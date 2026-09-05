import { spawn, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const execFileAsync = promisify(execFile);

/** Cordis plugin name (matches the patch insert id). */
const name = "updater";
/** The webserver owns the HTTP route. */
const inject = ["webServer"];

// ── bundle layout ─────────────────────────────────────────────────────────
// This plugin ships inside the packaged app bundle:
//   <app>/Contents/Resources/backend/node_modules/@deepseek-ai/dsh-updater/lib
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, "..");
const AI_ROOT = join(HERE, "..", ".."); // .../node_modules/@deepseek-ai
const NM_ROOT = join(HERE, "..", "..", ".."); // .../node_modules
const BACKEND_DIR = join(NM_ROOT, ".."); // .../backend
const APP_DIR = join(BACKEND_DIR, "..", "..", ".."); // <app>.app
const APP_EXE = join(APP_DIR, "Contents", "MacOS", "DeepSeekHarness");

const DSH_PKG = join(AI_ROOT, "dsh", "package.json");
const REGISTRY = "https://registry.npmjs.org";
const DSH_NAME = "@deepseek-ai/dsh";
/**
 * npm dist-tag the updater tracks. The desktop app ships the in-development
 * harness line, so it must compare against the `next` prerelease channel (the
 * `latest` tag lags behind the release candidates — e.g. latest=rc.7 while
 * the app already runs rc.8). Override with $DSH_UPDATE_TAG if needed.
 */
const UPDATE_TAG = (process.env.DSH_UPDATE_TAG || "next").trim() || "next";
const TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 256_000;
const DOWNLOAD_CONCURRENCY = 6;
/** Local desktop plugins (tracked source, not published on npm) — never touch. */
const LOCAL_PLUGINS = new Set([
  "dsh-updater",
  "dsh-client-ui-updater",
  "dsh-billing",
  "dsh-client-ui-billing",
  "dsh-git",
  "dsh-client-ui-git",
]);

function ok(value) {
  return { ok: true, value };
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

// ── version helpers ────────────────────────────────────────────────────────
/** Current installed harness version (the @deepseek-ai/dsh package version). */
function currentVersion() {
  try {
    const pkg = JSON.parse(readFileSync(DSH_PKG, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Installed version of one @deepseek-ai/* package, or undefined. */
function installedVersion(pkgName) {
  const dir = join(AI_ROOT, pkgName.slice("@deepseek-ai/".length));
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

// ── registry helpers ───────────────────────────────────────────────────────
async function registryGet(path, timeoutMs = TIMEOUT_MS, abbreviated = false) {
  const res = await fetch(`${REGISTRY}/${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: abbreviated ? { accept: "application/vnd.npm.install-v1+json" } : { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`registry ${res.status} for ${path}`);
  return res.json();
}

/** Metadata of the tracked npm dist-tag (version + tarball + dependencies). */
async function fetchLatestDsh() {
  return await registryGet(`${DSH_NAME}/${UPDATE_TAG}`);
}

// ── update resolution ──────────────────────────────────────────────────────
/**
 * Walk the @deepseek-ai/* dependency closure of dsh@<tracks tag> and resolve
 * every monorepo package to its exact target version. Returns entries in a
 * stable order (parents before children is not required — tarballs are
 * independent).
 */
async function resolveUpdateSet(latestMeta) {
  const targetVersion = latestMeta.version;
  const targets = new Map(); // name -> { name, version, tarball }
  const queue = [{ name: DSH_NAME, version: targetVersion, tarball: latestMeta.dist?.tarball, deps: latestMeta.dependencies ?? {} }];

  while (queue.length > 0) {
    const entry = queue.shift();
    if (targets.has(entry.name)) continue;
    if (!entry.tarball) continue;
    targets.set(entry.name, { name: entry.name, version: entry.version, tarball: entry.tarball, deps: entry.deps ?? {} });
    for (const [depName, range] of Object.entries(entry.deps)) {
      if (!depName.startsWith("@deepseek-ai/")) continue;
      if (targets.has(depName)) continue;
      try {
        const meta = await registryGet(`${depName}/${entry.version}`);
        if (meta.version && meta.dist?.tarball) {
          queue.push({ name: depName, version: meta.version, tarball: meta.dist.tarball, deps: meta.dependencies ?? {} });
        }
      } catch {
        // Not published at the monorepo version (separate track like cordis);
        // the installed copy already satisfies its range.
      }
    }
  }
  return [...targets.values()];
}

/** Which resolved packages actually need replacing (newer than installed). */
function packagesNeedingUpdate(resolved) {
  const out = [];
  for (const entry of resolved) {
    const short = entry.name.slice("@deepseek-ai/".length);
    if (LOCAL_PLUGINS.has(short)) continue;
    const installed = installedVersion(entry.name);
    if (installed === undefined || semver.gt(entry.version, installed)) out.push(entry);
  }
  return out;
}

/**
 * Third-party (non-@deepseek-ai/*) dependencies the tracked closure needs but
 * that are missing from the bundle's node_modules. The tarball swap only
 * replaces @deepseek-ai/* packages, so a brand-new third-party dep introduced
 * by the newer core (e.g. dsh-app-boot's resolve.exports) would otherwise be
 * absent at boot (ERR_MODULE_NOT_FOUND). BFS their own third-party closure so
 * the bundle stays bootable after every update.
 */
async function resolveMissingNpmDeps(targets) {
  const missing = [];
  const seen = new Set();
  const present = (name) => existsSync(join(NM_ROOT, ...name.split("/")));
  const queue = [];
  for (const entry of targets) {
    for (const [depName, range] of Object.entries(entry.deps ?? {})) {
      if (depName.startsWith("@deepseek-ai/") || present(depName) || seen.has(depName)) continue;
      seen.add(depName);
      queue.push({ name: depName, range });
    }
  }
  while (queue.length > 0) {
    const { name, range } = queue.shift();
    if (present(name) || seen.has("done:" + name)) continue;
    let meta;
    try {
      meta = await registryGet(name);
    } catch {
      continue; // unresolvable (private/git dep) — leave untouched
    }
    const version = semver.maxSatisfying(Object.keys(meta.versions ?? {}), range ?? "*");
    const record = version ? meta.versions[version] : undefined;
    if (!record?.dist?.tarball) continue;
    seen.add("done:" + name);
    missing.push({ name, version: record.version, tarball: record.dist.tarball, deps: record.dependencies ?? {}, root: NM_ROOT });
    for (const [depName, depRange] of Object.entries(record.dependencies ?? {})) {
      if (depName.startsWith("@deepseek-ai/") || present(depName) || seen.has(depName)) continue;
      seen.add(depName);
      queue.push({ name: depName, range: depRange });
    }
  }
  return missing;
}

// ── download + install ──────────────────────────────────────────────────────
async function downloadTarball(tarball, destFile) {
  const res = await fetch(tarball, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destFile, buf);
}

async function extractTarball(tgz, destDir) {
  mkdirSync(destDir, { recursive: true });
  // npm tarballs carry a top-level package/ directory.
  await execFileAsync("/usr/bin/tar", ["-xzf", tgz, "-C", destDir]);
  return join(destDir, "package");
}

async function runDownloadPool(entries, onStatus) {
  const staging = mkdtempSync(join(tmpdir(), "dsh-update-"));
  const results = new Array(entries.length);
  let next = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, entries.length) }, async () => {
    while (next < entries.length) {
      const i = next++;
      const entry = entries[i];
      const tgz = join(staging, `${i}.tgz`);
      try {
        await downloadTarball(entry.tarball, tgz);
        results[i] = { entry, tgz };
      } catch (error) {
        results[i] = { entry, error };
      }
      done++;
      onStatus?.(done, entries.length);
    }
  });
  await Promise.all(workers);
  const failures = results.filter((r) => r.error);
  if (failures.length > 0) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`下载失败：${failures.map((f) => `${f.entry.name} (${f.error.message})`).slice(0, 5).join("; ")}`);
  }
  return { staging, results };
}

/**
 * Re-apply the desktop nav-icon patch to dsh-client-ui-settings-general.
 * The update replaces that package with the pristine npm artifact, which
 * loses the "git"/"updater" section icons the build normally patches in.
 * Mirrors build.sh's idempotent python step; runs only when the file changed.
 */
function patchSettingsNavIcons() {
  const target = join(AI_ROOT, "dsh-client-ui-settings-general", "lib", "client.js");
  if (!existsSync(target)) return false;
  const icons = [
    ["git", "IconBranchOutline16"],
    ["updater", "IconRefreshOutline16"],
  ];
  let s = readFileSync(target, "utf8");
  const present = icons.every(([id]) => s.includes(`if (id === "${id}") return`));
  if (present) return false;
  const lines = s.split("\n");
  let inserted = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("IconSettingsOutline16, {") && lines[i + 1]?.includes("navIcon")) {
      const indent = lines[i].slice(0, lines[i].length - lines[i].trimStart().length);
      const prop = lines[i + 1].slice(0, lines[i + 1].length - lines[i + 1].trimStart().length);
      const block = [];
      for (const [id, icon] of icons) {
        if (s.includes(`if (id === "${id}") return`)) continue;
        block.push(
          `${indent}if (id === "${id}") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.${icon}, {`,
          `${prop}className: SettingsRoot_module_css_default.navIcon,`,
          `${prop}size: 16`,
          `${indent}});`,
        );
      }
      if (block.length > 0) {
        lines.splice(i, 0, ...block);
        inserted = true;
      }
      break;
    }
  }
  if (inserted) {
    writeFileSync(target, lines.join("\n"));
    return true;
  }
  return false;
}

/**
 * Replace every listed package inside the bundle's node_modules. All tarballs
 * are downloaded first; only when every download succeeded are directories
 * swapped (old removed, new moved in). Returns the number of updated packages.
 */
async function installPackages(entries, onStatus) {
  const { staging, results } = await runDownloadPool(entries, onStatus);
  try {
    let count = 0;
    for (const { entry, tgz } of results) {
      const extractDir = join(staging, `x-${count}`);
      const pkgDir = await extractTarball(tgz, extractDir);
      const short = entry.name.startsWith("@deepseek-ai/") ? entry.name.slice("@deepseek-ai/".length) : entry.name;
      const dest = join(entry.root ?? AI_ROOT, ...short.split("/"));
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(pkgDir, dest);
      count++;
    }
    return count;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// ── restart ────────────────────────────────────────────────────────────────
/** Read the bundle identifier from the app's Info.plist (used to quit the old
 *  instance gracefully via Apple Events). Falls back to the known id. */
function bundleId() {
  try {
    const plist = join(APP_DIR, "Contents", "Info.plist");
    const id = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (id) return id;
  } catch {
    /* fall through */
  }
  return "ai.deepseek.harness.desktop";
}

/**
 * Spawn a detached helper that waits, then shuts the OLD app down and
 * relaunches via `open -n`.
 *
 * Shutting down relies on AppleScript `quit` (an Apple Event), which drives
 * NSApplication's normal termination: `applicationWillTerminate` →
 * `backend.stop()` → launcher forwards SIGTERM → dsh web exits. That closes
 * BOTH the window and the backend, so the old instance is fully gone before
 * the new one opens. (SIGTERM alone was not enough — its default action skips
 * `applicationWillTerminate` and orphans the backend, which is why the old app
 * appeared to stay open with a white screen.)
 *
 * A force-clear pass (pgrep + TERM, then KILL) is kept as a belt-and-braces
 * fallback for anything the Apple Event did not reach. The bundle path is
 * regex-escaped ([.]) so pgrep cannot match the helper's own command line,
 * letting the helper finish the re-sign + relaunch.
 */
function scheduleRestart(delayMs = 2500) {
  if (!existsSync(APP_EXE)) return { scheduled: false, reason: "not a packaged app bundle" };
  const RE = APP_DIR.replace(/\./g, "[.]");
  const script = [
    `sleep ${Math.max(1, Math.round(delayMs / 1000))}`,
    // 1) Graceful quit via Apple Events (NSApplication termination chain).
    `osascript -e 'tell application id "${bundleId()}" to quit' >/dev/null 2>&1 &`,
    `OSA=$!`,
    `sleep 6`,
    `kill $OSA 2>/dev/null || true`,
    // 2) Force-clear anything still alive under this bundle path.
    `PIDS=$(pgrep -f "${RE}" 2>/dev/null || true)`,
    `for p in $PIDS; do kill "$p" 2>/dev/null || true; done`,
    `sleep 2`,
    `PIDS=$(pgrep -f "${RE}" 2>/dev/null || true)`,
    `for p in $PIDS; do kill -9 "$p" 2>/dev/null || true; done`,
    `sleep 1`,
    `codesign --force --deep --sign - "${APP_DIR}" >/dev/null 2>&1 || true`,
    `open -n "${APP_DIR}"`,
  ].join("\n");
  const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" });
  child.unref();
  return { scheduled: true };
}

// ── update state (for progress reporting) ──────────────────────────────────
let updateState = null;

// ── handlers ───────────────────────────────────────────────────────────────
const handlers = {
  /** Current installed version. */
  version() {
    return ok({ version: currentVersion(), package: DSH_NAME });
  },

  /** Compare the installed version against the tracked npm dist-tag. */
  async check() {
    const current = currentVersion();
    const latest = await fetchLatestDsh();
    return ok({
      current,
      latest: latest.version,
      hasUpdate: semver.gt(latest.version, current),
    });
  },

  /** Apply the update in the background; the client polls `status` for progress. */
  async update() {
    if (updateState?.running) return fail("busy", "已有更新任务正在进行");
    const current = currentVersion();
    const latest = await fetchLatestDsh();
    if (!semver.gt(latest.version, current)) {
      return ok({ updated: false, current, latest: latest.version });
    }
    updateState = { running: true, phase: "resolve", done: 0, total: 0, from: current, to: latest.version };
    runUpdate(latest, current);
    return ok({ started: true, from: current, to: latest.version });
  },

  /** Progress of the in-flight (or last) update task. */
  status() {
    return ok(updateState ?? { running: false, phase: "idle", done: 0, total: 0 });
  },
};

/** Background update pipeline (never blocks the HTTP layer). */
async function runUpdate(latest, current) {
  try {
    const resolved = await resolveUpdateSet(latest);
    const needed = packagesNeedingUpdate(resolved);
    const extra = await resolveMissingNpmDeps(resolved);
    if (needed.length + extra.length === 0) {
      updateState = { running: false, phase: "up-to-date", done: 0, total: 0, from: current, to: latest.version };
      return;
    }
    updateState = { running: true, phase: "download", done: 0, total: needed.length + extra.length, from: current, to: latest.version };
    const count = await installPackages([...needed, ...extra], (done, total) => {
      if (updateState) updateState = { ...updateState, done, total };
    });
    patchSettingsNavIcons();
    writeFileSync(
      join(BACKEND_DIR, ".dsh-updated.json"),
      JSON.stringify({ from: current, to: latest.version, at: new Date().toISOString(), packages: count, extra: extra.length }, null, 2),
    );
    updateState = { running: false, phase: "done", done: count, total: needed.length, from: current, to: latest.version };
    scheduleRestart(2500);
  } catch (error) {
    updateState = { running: false, phase: "error", done: 0, total: 0, error: error?.message ?? String(error) };
  }
}

// ── HTTP route ─────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function handleRequest(ctx, req, res) {
  if (req.method !== "POST") {
    json(res, 405, fail("method", "POST required"));
    return;
  }
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    json(res, 413, fail("body", error.message));
    return;
  }
  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    json(res, 400, fail("bad-json", "invalid JSON body"));
    return;
  }
  const fn = typeof payload.op === "string" ? handlers[payload.op] : undefined;
  if (fn === undefined) {
    json(res, 400, fail("bad-op", `unknown op ${JSON.stringify(payload.op)}`));
    return;
  }
  try {
    json(res, 200, await fn(payload, ctx));
  } catch (error) {
    json(res, 200, fail("internal", error?.message ?? String(error)));
  }
}

function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/updater",
        handler: (req, res) => handleRequest(ctx, req, res),
      }),
    "dsh-updater: /updater route",
  );
}

export { apply, inject, name, currentVersion, fetchLatestDsh, resolveUpdateSet, packagesNeedingUpdate, resolveMissingNpmDeps, installPackages, patchSettingsNavIcons };
