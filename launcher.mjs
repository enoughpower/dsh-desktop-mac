#!/usr/bin/env node
/**
 * Backend supervisor for the DeepSeek Harness desktop shell.
 *
 * The native shell spawns `node launcher.mjs`. This process then boots the
 * `dsh web` backend on a loopback port chosen by the OS, waits until the
 * frontend actually answers, prints a single `DSH_READY=<url>` line to its
 * own stdout (that is all the shell parses), and keeps the backend alive,
 * mirroring its logs to stderr and forwarding termination signals.
 *
 * Everything lives under <app>/Contents/Resources/backend, so paths are
 * resolved relative to this file, never the current working directory.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { ensureDesktopBin, desktopBinDir } from "./desktop-bin.mjs";
import { resolveDesktopHome, linkBundledPlugins } from "./dsh-home.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DSH_BIN = join(HERE, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

// Isolate the desktop app's user data from the CLI's shared `~/.dsh`:
// 1) Resolve the desktop's own home ($DSH_HOME). The environment variable
//    drives every path inside the harness (config, credentials, sessions,
//    profiles), so the backend boots against a dedicated data directory.
// 2) Put it on process.env early so desktop-bin's shims and the spawned child
//    all agree, then expose the bundled overlay plugins to the profile. Each
//    *.patch.yml registers packages bundled in backend/node_modules that the
//    profile must reach through $DSH_HOME/profiles/node_modules; linking them
//    here (idempotent) makes a fresh, isolated profile resolve them — the step
//    that lets the app boot again without relying on a pre-seeded ~/.dsh.
const DSH_HOME = resolveDesktopHome();
if (process.env.DSH_HOME === undefined || process.env.DSH_HOME.trim() === "") {
  process.env.DSH_HOME = DSH_HOME;
}
linkBundledPlugins(HERE, process.env.DSH_HOME);

/**
 * Discover the overlay patches to apply. Any *.patch.yml dropped into the
 * backend directory is auto-registered -- no launcher change needed to add a
 * plugin (see add-plugin.sh). Each patch is a Cordis patch file that inserts
 * the plugin's host/browser halves (e.g. billing.patch.yml inserts
 * dsh-cost-meter). prune.patch.yml is just another patch and is picked up
 * the same way. Sorted by filename so ordering is deterministic.
 */
import { existsSync, readdirSync } from "node:fs";

function collectPatches() {
  const out = [];
  let files = [];
  try {
    files = readdirSync(HERE).filter((f) => f.endsWith(".patch.yml")).sort();
  } catch {
    return out;
  }
  for (const f of files) {
    const p = join(HERE, f);
    if (existsSync(p)) out.push(p);
  }
  return out;
}

/** Patch files applied to the backend, in deterministic (filename) order. */
const PATCH_FILES = collectPatches();

/** Build the backend environment. A Finder-launched app inherits a bare PATH,
 *  so we restore the standard macOS search path plus the Homebrew roots.
 *  The bundled `node` lives at <backend>/node; putting the backend dir first
 *  lets child processes (e.g. the dsh-vision-router plugin's vision subprocess) run
 *  `node` against the bundled binary instead of a possibly-broken system one. */
function buildEnv() {
  const env = { ...process.env };
  // Ensure the desktop's own node+pnpm shims (~/.dsh/.desktop-bin) and prepend
  // them so `dsh plugin` (which shells out to bare `pnpm`) resolves against the
  // bundled runtime -- no system node/pnpm required. pnpm not bundled => no-op.
  ensureDesktopBin().catch(() => {});
  const wanted = [
    desktopBinDir(),
    HERE,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/opt/homebrew/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const seen = new Set((env.PATH ?? "").split(":").filter(Boolean));
  for (const p of wanted) if (!seen.has(p)) {
    seen.add(p);
    env.PATH = (env.PATH ? env.PATH + ":" : "") + p;
  }
  // Respect an explicit choice; otherwise disable telemetry by default.
  if (env.DSH_TELEMETRY_DISABLED === undefined) env.DSH_TELEMETRY_DISABLED = "1";
  return env;
}

// Launcher flags must precede the web app's flags. All *.patch.yml files in
// the backend directory are applied in filename order (see collectPatches);
// each one disables or inserts plugin rows whose packages are bundled.
// `--no-open` (rc.8+): the native shell renders the UI in its own WKWebView,
// so the backend must NOT spawn the default browser on startup.
const launcherArgs = [DSH_BIN, "web"];
for (const patch of PATCH_FILES) launcherArgs.push("--patch", patch);
launcherArgs.push("--host", "127.0.0.1", "--port", "0", "--no-open");

const child = spawn(
  process.execPath,
  launcherArgs,
  { cwd: process.env.HOME ?? HERE, env: buildEnv(), stdio: ["ignore", "pipe", "pipe"] },
);

let url = null;
let announced = false;

/** Poll the resolved loopback URL until the webserver answers, then tell the shell. */
function announceWhenReady() {
  if (announced || url === null) return;
  const target = new URL(url);
  const attempt = () => {
    if (announced) return;
    const req = http.get(
      { hostname: target.hostname, port: target.port, path: "/", timeout: 500 },
      (res) => {
        res.resume();
        announced = true;
        process.stdout.write(`DSH_READY=${url}\n`);
      },
    );
    req.on("error", () => {
      if (announced) return;
      setTimeout(attempt, 150);
    });
    req.on("timeout", () => {
      req.destroy();
      if (!announced) setTimeout(attempt, 150);
    });
  };
  attempt();
}

function onLine(line) {
  const m = line.match(/dsh web:\s+(http:\/\/[^\s]+)/);
  if (m && url === null) {
    url = m[1];
    announceWhenReady();
  }
  // Mirror backend logs to our stderr (visible when the shell is launched from a terminal).
  process.stderr.write("[dsh] " + line + "\n");
}

let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).replace(/\r$/, "");
    buf = buf.slice(idx + 1);
    if (line.length > 0) onLine(line);
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

let exiting = false;
function shutdown(code = 0) {
  if (exiting) return;
  exiting = true;
  try {
    child.kill("SIGTERM");
  } catch {}
  const force = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch {}
  }, 3000);
  force.unref?.();
  child.once("exit", () => process.exit(code));
  // Safety net in case the child ignores the signal entirely.
  setTimeout(() => process.exit(code), 5000).unref?.();
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGQUIT", () => shutdown(0));
process.stdin.on("close", () => shutdown(0));

child.on("exit", (code) => {
  if (!exiting) {
    process.stderr.write(`[dsh] backend exited (code ${code})\n`);
    process.exit(code ?? 1);
  }
});
child.on("error", (err) => {
  process.stderr.write(`[dsh] failed to spawn backend: ${err.message}\n`);
  process.exit(1);
});
