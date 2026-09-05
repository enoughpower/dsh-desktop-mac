# DeepSeek Harness — macOS Desktop

[中文](README.md) | **English**

A native macOS desktop wrapper around [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`@deepseek-ai/dsh`). The shell uses the system **WKWebView** (not Electron); the backend bundles a
**slimmed Node.js runtime + pruned node_modules**, so the size is far smaller than an Electron build.

## Quick Start (Build & Use)

### Artifacts

`./build.sh` produces **`DeepSeekHarness.app`** in `dist/` (double-click to run, ad-hoc signed locally);
adding `--dmg` also produces a **DMG installer** named
`DeepSeekHarness-<version>-<MMddHHmm>-<full|lite>.dmg` (`full`=full build, `lite`=slim build).

### Build

Requirements: macOS + Xcode command-line tools (`swiftc`/`codesign`) + Node.js (to bundle the runtime
and install dependencies).

```bash
cd desktop
./build.sh                          # default: full build (all multi-provider SDKs)
./build.sh --dmg                    # also produce a DMG installer
KEEP_EXTRA_PROVIDERS=0 ./build.sh --dmg   # slim: DeepSeek only, smaller (see "Size Comparison")
```

- The first build runs `npm install --omit=dev` for `@deepseek-ai/dsh` production deps.
- `KEEP_EXTRA_PROVIDERS=0` follows the slim path: `prune.sh` removes the Pi.ai etc. multi-provider
  SDKs and `prune.patch.yml` disables the `llm-pi-ai` row; the default model stays DeepSeek.

### Install the DMG

1. Double-click `dist/DeepSeekHarness-<version>-*.dmg` to mount it.
2. Drag **`DeepSeekHarness.app`** into **`/Applications`** (quit any running copy first).
3. Open from Launchpad/Finder; user data lives in `~/Library/Application Support/DeepSeekHarness`.

> Command-line overwrite install:
> ```bash
> hdiutil attach <dmg>
> rm -rf /Applications/DeepSeekHarness.app && cp -R '<mount>/DeepSeekHarness.app' /Applications/
> hdiutil detach <mount>
> ```

## Directory Layout

```
desktop/
├── App/
│   ├── main.swift          # WKWebView shell: start backend, read DSH_READY, load page, clean on exit
│   ├── Info.plist          # app manifest (incl. ATS local-network exemption)
│   ├── make_icon.swift     # icon generator (optional)
│   └── icon.icns           # generated icon
├── launcher.mjs            # backend supervisor: spawn dsh web, print DSH_READY=<url> when ready
├── desktop-bin.mjs         # node/pnpm runtime shim generator (Plan C)
├── plugins.mjs             # user-level plugin CLI: add/remove/list (Plan C)
├── add-plugin.sh           # one-click bundled plugin install / --runtime user-level install
├── prune.patch.yml         # disables pruned plugin rows (llm-pi-ai, telemetry)
├── git.patch.yml           # registers the built-in Git plugin
├── billing.patch.yml       # registers the cost plugin dsh-cost-meter
├── pocket.patch.yml        # registers the phone-access plugin dsh-pocket
├── updater.patch.yml       # registers the version/update-check plugin
├── skills-hub.patch.yml   # registers the global skills library plugin dsh-skills
├── mcp-settings.patch.yml  # registers the MCP service management plugin
├── vision.patch.yml        # registers the vision plugin dsh-vision-router v2.1.2 (not taking over llm-deepseek)
├── theme-blackgold.patch.yml # registers the black-gold theme plugin (@frostgao/dsh-theme-blackgold)
├── prune.sh                # node_modules slimming script
├── build.sh                # one-click build
├── plugins/                # bundled plugin source (copied into backend node_modules at build)
└── package.json            # declares only the @deepseek-ai/dsh dependency
```

## Size Comparison (measured)

| Version | Build command | App bundle | Backend | DMG | Notes |
|---|---|---|---|---|---|
| **Full** | `./build.sh --dmg` | 240M | 235M | ~79 MB | Includes 30+ providers (Pi.ai / Anthropic / Google / OpenAI…; llm-pi-ai lazily loaded) |
| **Slim (lite)** | `KEEP_EXTRA_PROVIDERS=0 ./build.sh --dmg` | 203M | 200M | ~73 MB | DeepSeek only; multi-provider SDKs & telemetry removed |

The ~37M saved by the slim build mostly comes from removing the Pi.ai multi-provider SDK stack
(`@earendil-works/pi-ai` and its `@mistralai`/`@google`/`@anthropic-ai`/`@aws-sdk`/`@opentelemetry`/`openai`
deps), session telemetry, non-darwin-arm64 native binaries, and non-runtime files
(`.ts`/`.d.ts`/`.map`/third-party docs), plus stripping Node debug symbols (`strip -x`). Both reuse
the system WKWebView (no Chromium), far smaller than an Electron build.

> After a full build, Settings → Models → **Add Provider** enables amazon-bedrock / anthropic / google /
> google-vertex / mistral / openai / openrouter / xai / groq / nvidia and 30+ more (the llm-pi-ai plugin
> loads lazily and activates once a provider is configured).

## Memory Footprint Comparison (measured)

The desktop app is slimmer not only in **installer size** but also in **runtime memory**. Measured
with the desktop in use vs. the web version opened in a browser (Chrome tabs cleared):

| | Desktop client | Web version (in browser) |
|---|---|---|
| Server | backend node 160 MB | fresh web node 177 MB |
| Rendering | WKWebView shell 98 MB (built-in) | browser (Chrome) ~1150 MB |
| **Total** | **~258 MB** | **~1.33 GB** |

**Conclusion**: the desktop app is roughly **1/5** of the web version's total, saving about **1 GB** of RAM.
Even with all Chrome tabs cleared, the browser carries ~1150 MB of **base overhead** (browser / GPU /
network / extensions), while the desktop folds that "rendering" into a 98 MB WKWebView shell and ships the
backend together as **one app**, eliminating the need to run a separate browser. **Slim install + slim memory,
a win-win.**

> Rounding: desktop = backend node + WKWebView shell (all-in-one, stable shortly after launch); web = fresh
> web server + the whole browser (incl. residual tabs / extensions / Chrome base, not just the DSH page).
> Both render with WebKit/Chromium; the desktop simply avoids the browser process overhead.

## How It Works

1. On launch, the Swift shell spawns `Contents/Resources/backend/node launcher.mjs` via `Process`.
2. `launcher.mjs` sets the app's data dir to a dedicated `DSH_HOME`
   (fixed to `~/Library/Application Support/DeepSeekHarness`; the shell **strips an inherited
   `DSH_HOME`** from the launcher env so the app always uses its own home, fully isolated from the
   CLI's `~/.dsh`; running `launcher.mjs` directly still honors a `DSH_HOME` override), symlinks the
   bundled plugins into `profiles/node_modules`, then starts
   `dsh web --patch <overlays>.patch.yml --host 127.0.0.1 --port 0`, polls until the front-end answers,
   and prints `DSH_READY=http://127.0.0.1:<port>` to stdout.
3. The shell loads that URL into the `WKWebView`.
4. User data (config, credentials, sessions, profile, plugins, skills) lives in the **separate** `DSH_HOME`,
   fully isolated from the CLI `dsh`'s `~/.dsh`.
5. On quit, the shell sends `SIGTERM` to the launcher, which forwards it to `dsh web` for a clean exit.

The backend listens only on a random `127.0.0.1` port, avoiding conflicts and LAN exposure.

## Version & Update Check

The app shows the current DeepSeek Harness version in the **top-right corner** (the `@deepseek-ai/dsh`
package version, e.g. `v0.1.1-rc.2`). Under **Settings → Check for Updates**:

- **Check for updates**: compares against the latest `@deepseek-ai/dsh` on the npm registry;
- **Update now**: downloads the latest closure (dsh + all its `@deepseek-ai/*` deps, plus any new
  third-party deps missing from the bundle) and atomically replaces the bundle's `node_modules`,
  then restarts the app (re-signed to keep the arm64 ad-hoc signature valid).

This is a built-in plugin (same pattern as git):

| File | Role |
|---|---|
| `plugins/dsh-updater/` | Host half: `/updater` JSON API (version / check / update / status) |
| `plugins/dsh-client-ui-updater/` | Browser half: top-right version badge + "Check for Updates" section in Settings |
| `updater.patch.yml` | registers these two plugins (passed via `--patch` at launcher start) |

### How to Actually Upgrade Harness

The in-app "**Check for Updates**" replaces only the `node_modules` inside the **current app bundle**;
it does **not** write back to the desktop source dependencies. So **just re-running `./build.sh` resets
the version to the source-pinned one** (`build.sh` copies from `desktop/node_modules` each time).

To **permanently upgrade** (so `./build.sh` keeps producing the new version):

```bash
cd desktop
# 1) bump @deepseek-ai/dsh in package.json to the target version (e.g. 0.1.1-rc.2)
# 2) reinstall deps with a working node/npm (system node may be broken by an icu4c change; use nvm's node)
$HOME/.nvm/versions/node/v22.19.0/bin/npm install --omit=dev --no-audit --no-fund
# 3) rebuild
./build.sh
```

The `@deepseek-ai/dsh` version in the produced app = the version in `desktop/node_modules`, i.e. what
`package.json` declares.

## Git Source Management

The built-in Git plugin provides a **full-screen Git panel**: open it via the **"Git" tab** in the
conversation (trajectory) view's tab bar (replaces the chat/trajectory area), and quit with Esc / the
close button. On open it **auto-binds to the current session's working directory** (`useSessions` reads
the current session cwd); the top bar has a "Refresh" button.

Features:

- **Status sections**: staged / unstaged / untracked files in columns; **checkbox = stage toggle** —
  check an unstaged file to stage it, uncheck a staged one to unstage; the "Unstaged" header has a
  select-all checkbox for stage/unstage-all.
- **Discard changes**: each row's `⋯` menu → "Discard" restores worktree changes (not for untracked);
  "Remove file" deletes it from the worktree (incl. untracked, with confirmation, irreversible).
- **Commit** (the git-commit button): **commits only staged (checked) files**; staged-only, unstaged
  untouched; supports amending the last commit; **message input is multi-line** (Enter newline,
  auto-grows, ⌘/Ctrl+Enter or the Commit button), with output echo below.
- **Branch switching**: the top branch button opens a menu grouped by **Local / Remote** listing every
  branch; **click a row to switch** (a remote branch auto-creates a same-named local tracking branch;
  if the local name already exists it falls back to switching local); the current branch is highlighted
  with a dot and not clickable. The menu is a narrow vertical list with borderless rows; per-row rename ✎
  and delete ✕ (confirmed) remain. "New" (branch from the selected commit) and "Merge" (merge the selected
  commit into current) live in the **commit-detail toolbar**, styled like "Refresh".
- **Remote ops**: push (-u sets upstream), pull (--ff-only), Fetch --prune.
- **History**: a Git-Graph-style commit graph (mainline left, branches fork right and run down, each
  branch colored per column; HEAD is a hollow circle, others solid), click a commit for the full diff;
  supports per-file history (`git log -- <file>`) and blame.
- **File diff**: click a file for "worktree vs HEAD" comparison (with file history).
- **Layout**: commit history occupies the top of the second column (fills remaining height); the commit
  form is at the bottom.
- **Diff view**: diffs grouped by file (file header + add/delete/rename/binary badges); changed lines
  marked green/red; old/new line numbers per row; hunk headers show `@@ -old +new @@`.
- **Files browser**: a **"Files"** tab sits to the right of "Git" in the tab bar — the full workspace
  file tree on the left (with **expand-all / collapse-all** buttons), file content on the right. Text
  editing is powered by **CodeMirror 6** (VS Code-grade **syntax highlighting** & editing: line numbers,
  code folding, bracket matching, multi-cursor, undo/redo…; JS/TS/JSX/TSX/JSON/HTML/CSS/Python/Markdown/
  YAML/Shell/C/C++/Java/Kotlin/Go…); ⌘/Ctrl+S saves, ⌘/Ctrl+E toggles edit/preview; images and common
  formats preview inline. The editor uses the **One Dark** theme to match the black-gold dark theme.
  **.md/.markdown** files render as Markdown in preview mode (GFM, line breaks, tables/quotes/code blocks);
  edit mode shows the source.
  > No freeze on huge change-sets: git itself answers in milliseconds for thousands of files — the
  > freeze came from the client rendering *every* file as a full DOM row. Each status section now
  > renders only the first 600 rows and the Files tree caps at 1200 items, folding the rest behind a
  > "…N more (click to expand all)" row, so huge workspaces stay responsive.

| File | Role |
|---|---|
| `plugins/dsh-git/` | Host half: `/git` JSON API (28 ops: status/stage/diff/commit/branch/merge/log/blame/cat…) + `/fs` file API (tree/read/write) |
| `plugins/dsh-client-ui-git/` | Browser half: Git tab + Files browser tab + full-screen panel UI |
| `git.patch.yml` | registers these two plugins (via `--patch`) |

**Panel preview:**

![Git panel: branch bar + commit history + changed files + diff view](./docs/screenshots/git-panel.png)

## Vision (dsh-vision-router)

Bundled third-party plugin **dsh-vision-router** (see its
[GitHub repo](https://github.com/ysr666/dsh-vision-router), bundled at **v2.1.2**), giving text-only models
(DeepSeek etc.) **pixel-faithful image understanding**:

- **See the original image** (no lossy description bridge): image turns are handed to a vision model,
  DeepSeek always does the reasoning; an image turn is just a normal **tool call** that could iterate
  (`vision_ground` → `vision_crop` → `vision_describe` → `vision_pixel_diff`…) — locatable, verifiable.
- **Free by default**: vision tools fall back to 5 OVHcloud anonymous vision models, no key needed
  (2 req/min per IP per model); your own vision models (Zhipu/Bailian/OpenRouter…) take priority.
- **14 in-depth tools**: Q&A / locate / crop / pixel-diff / colors / OCR / SVG trace / cutout /
  HTML screenshot / long-screenshot read, etc.; no Python — based on sharp / potrace / tesseract / system Chrome.
- **Settings**: Settings → Plugins → Plugin config → **"Vision Router"** card; whether it takes over the
  official route is set by the "Stealth mode" toggle (off by default, official `llm-deepseek` row stays).
- **No log pollution**: the rewrite toward vision tools happens only at the model input layer; the session
  log still shows the original image.

| File | Role |
|---|---|
| `plugins/dsh-vision-router/` | plugin source (v2.1.2: host route + 14 vision tools + browser settings card) |
| `vision.patch.yml` | registers the plugin + relaxed attachment policy (20 MiB / 100 MP / 10000 px per edge; not taking over llm-deepseek) |

## Global Skills Library (dsh-skills)

Bundled third-party plugin **dsh-skills** ([CocoSgt/dsh-skills](https://github.com/CocoSgt/dsh-skills)).
Centralizes scattered skills: Claude Code's `~/.claude/skills`, project dirs, `.skill` packages, etc.,
imported into `$DSH_HOME/skills` (the official skill-filesystem default scan root, live watcher); imported
skills appear in the input's "/" slash menu; Settings has a "Skills" nav page.

Features:

- **Two import identities**: reference (symlink, edits edit the source) / copy (full tree, evolves independently).
- **Global skills tab**: + new skill, upload `.skill`, visual filter; each card shows identity badge,
  resource file count, non-default invocation policy; "Edit SKILL.md" inline editing, export `.skill`
  full-tree package, open dir, delete (reference only removes the link, two-step confirm).
- **Discover tab**: scan directory chips in place, then "reference / copy" the results; supports "reference all" batch.
- All copy rendered via the official locale service (Chinese/English); pairs with `dsh-attachments` / `dsh-inspector`.

| File | Role |
|---|---|
| `plugins/dsh-skills/` | plugin source (host: `skillHub` Typert gateway: status / import (reference|copy) / edit / export; browser: Settings skills hub) |
| `skills-hub.patch.yml` | registers the plugin (via `--patch`) |

## MCP Service Management

Bundled third-party plugin **@opendsh/dsh-plugin-setting-mcp** (npm) adds a "**MCP Services**" entry in
Settings to **view, add, edit, remove, enable/disable** MCP services (stdio / Streamable HTTP); clicking
"Save" hot-applies (no restart). It manages the `@deepseek-ai/dsh-mcp-client` loader entries and persists
the service set back to the profile's `cordis.patch.yml`.

| File | Role |
|---|---|
| `plugins/@opendsh/dsh-plugin-setting-mcp/` | plugin source (host: typert `ctx.mcp` service; browser: Settings MCP service management) |
| `mcp-settings.patch.yml` | registers the plugin (via `--patch`) |

## User Plugins (Plan C: runtime install, no recompile)

The `dsh` core natively supports user-level plugins: install them into the **profile**
(`$DSH_HOME/profiles/web`)'s `node_modules`; declaring `dsh.bundle` auto-adds them to the layer stack
(`$DSH_HOME` is the app's own user dir, default `~/Library/Application Support/DeepSeekHarness`, overridable
via `DSH_HOME`). This mechanism is built into the app:

- **Bundled node/pnpm**: on start `launcher.mjs` uses `desktop-bin.mjs` to generate `$DSH_HOME/.desktop-bin/{node,pnpm}`
  shims and prepends them to PATH, so `dsh plugin` works inside the packaged app without a system Node/pnpm.
- **One-command CLI** (`add-plugin.sh`):
  ```sh
  ./add-plugin.sh --runtime add <npm-package-or-local-dir>   # install
  ./add-plugin.sh --runtime list                              # list installed bundles
  ./add-plugin.sh --runtime remove <package>                  # remove
  ```
- **No recompile**: user plugins live under `$DSH_HOME`; `./build.sh` rebuild/upgrade only rewrites the
  bundle's node_modules and won't clear user-installed plugins. Install bundle plugins that declare
  `dsh.bundle` (package.json with `dsh.bundle.patch` + `cordis.patch.yml`).

> `--runtime add` passes `-w` (the profile is a pnpm workspace root; pnpm needs it).
> `remove`/`list` use the full package name (e.g. `@scope/name`); trust `list` output.
>
> **Both plugin kinds work**: bundle plugins (e.g. git/updater) auto-join the bundle layer after install;
> browser-only plugins that only declare `dsh.client` (e.g. `@frostgao` themes) are NOT auto-activated by
> `dsh plugin add` — `plugins.mjs` appends an activation row to the profile's user-layer
> `cordis.patch.yml` and cleans it on remove.

## Black-Gold Theme (@frostgao/dsh-theme-blackgold)

Bundled `@frostgao/dsh-theme-blackgold` (a companion theme by @frostgao), shipped as an in-app plugin
(source in `plugins/@frostgao/dsh-theme-blackgold`), repainting the web UI in **black-and-gold**
(black/white base + gold accents, light/dark):

- **Brand mark**: whale logo gold outline + hover micro-motion; `HARNESS` badge black-on-gold with a periodic shine sweep.
- **Page accents**: send key, active session/trajectory/workspace tabs, caret, highlights turned gold.
- **Details**: sidebar running dot gold, new-session halo faint gold, ContextMeter, etc.
- Pure presentation-layer override (via `dsh-client-ui-theme` token overrides), respects `prefers-reduced-motion`.

The plugin is client-only (`immediately: true`, no toggle needed); loaded at start with the plugin manifest.
Pure ESM, no native binary; its `@deepseek-ai/dsh-client-ui-theme` dep ships with 0.1.1-rc.2.

| File | Role |
|---|---|
| `plugins/@frostgao/dsh-theme-blackgold/` | plugin source (host half is a placeholder; browser: black-gold token override) |
| `theme-blackgold.patch.yml` | registers the plugin (via `--patch`) |

## Session Cost Meter (dsh-cost-meter)

Bundled **dsh-cost-meter** ([Han-1413141/dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter),
v1.7.10), providing session-level cost stats:

- **Cost**: per-conversation cost, daily totals, history; built-in 90+ model price catalog auto-matches,
  one-click sync with official prices.
- **Balance / quota**: official balance, configurable custom provider balance (any HTTP endpoint) with a
  balance progress bar; mainstream Coding Plan quota queries & display (7 vendors, incl. local Credits
  metering for the SCNet Token Plan).
- **Off-peak pricing**: on/off-peak periods, pre-switch popup / system-notification reminders (position /
  lead time / type configurable).
- Bilingual (Chinese/English) UI; configure in Settings → Plugins → dsh-cost-meter.

| File | Role |
|---|---|
| `plugins/dsh-cost-meter/` | plugin source (host: costMeter service + ledger; browser: cost display & settings) |
| `billing.patch.yml` | registers the plugin (via `--patch`; the `name:` must be quoted — linkBundledPlugins only collects quoted names) |


## Phone Access (dsh-pocket)

Bundled **dsh-pocket** ([shaobeichen/dsh-pocket](https://github.com/shaobeichen/dsh-pocket),
v2.10.3, GPL-2.0) puts DSH "in your pocket" — **scan a QR code with your phone and see the
same interface in real time**:

- **LAN QR code**: Settings → **Phone Access** — phones on the same Wi-Fi scan to open
  (auto-detects the LAN IP; a separate 8-digit PIN, enabled by default, can be disabled or
  customized).
- **Public QR code**: click "Enable public access" → cloudflared quick tunnel (downloaded on
  first use) → public QR code for use anywhere (4G / any network); the public link has its own
  8-digit PIN (rotated on every enable by default, customizable).
- **Real-time mirror**: the phone shows the same dsh web UI as the computer — WebSocket
  pass-through, two-way control, narrow screens switch to a mobile drawer layout; heartbeat
  keep-alive with auto-reconnect, gzip/brotli response compression.
- **Desktop adaptation**: the desktop app injects `dsh-desktop-mode=compatibility`, so the
  QR mirror works out of the box; the plugin's in-page "update / restart" actions are disabled
  in the desktop build (managed by the app). If port 3081 is taken the proxy auto-switches.
- **Trimmed tabs on phone**: the "Git" and "文件" (Files) tabs are hidden when accessed from a
  phone (the Git client skips registering them when the URL carries dsh-desktop-mode), so they
  don't collide with the mobile drawer layout; the desktop app is unaffected.

| File | Role |
|---|---|
| `plugins/dsh-pocket/` | plugin source (host: Host/Origin-rewriting reverse proxy + QR codes + tunnel; browser: Settings → Phone Access + mobile adaptation) |
| `pocket.patch.yml` | registers the plugin (via `--patch`; quoted `name:` so linkBundledPlugins links it into the profile) |

> ⚠️ **Security**: DSH can execute code on your computer. Both the LAN and public links are
> gated by a separate 8-digit PIN — don't share QR codes / URLs / PINs with others; a security
> disclaimer is enforced before enabling public access; close it when done.
> The login session is bound to the computer's dsh web process — after the app restarts or
> updates, the phone must re-enter the PIN once.


The launcher also prepends the backend dir (with the bundled `node` binary) to PATH, so vision subprocesses
use the app's own Node rather than a possibly-broken system Node.

## License

This project (`desktop/`) is licensed under the **MIT License** (see [LICENSE](LICENSE)).
All bundled third-party plugins and the upstream `@deepseek-ai/dsh` are MIT (each retains its own copyright
notice and LICENSE).
