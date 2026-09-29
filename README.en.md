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
├── billing.patch.yml       # registers the cost plugin dsh-cost-meter
├── updater.patch.yml       # registers the version/update-check plugin
├── theme-blackgold.patch.yml # registers the black-gold theme plugin (@frostgao/dsh-theme-blackgold)
├── prune.sh                # node_modules slimming script
├── build.sh                # one-click build
├── plugins/                # bundled plugin source (copied into backend node_modules at build)
└── package.json            # declares only the @deepseek-ai/dsh dependency
```

## Size Comparison (measured)

| Version | Build command | App bundle | Backend | DMG | Notes |
|---|---|---|---|---|---|
| **Full** | `./build.sh --dmg` | 451M | 446M | ~176 MB | 30+ providers (llm-pi-ai lazily loaded) plus the 0.2.0 document-preview runtime (`libreoffice-kit`, ~200M) and speech runtime (`sherpa-onnx`, ~33M) |
| **Slim (lite)** | `KEEP_EXTRA_PROVIDERS=0 ./build.sh --dmg` | 417M | 414M | ~160 MB | DeepSeek only; multi-provider SDKs & telemetry removed; document-preview / speech runtimes kept |

The ~34M saved by the slim build mostly comes from removing the Pi.ai multi-provider SDK stack
(`@earendil-works/pi-ai` and its `@mistralai`/`@google`/`@anthropic-ai`/`@aws-sdk`/`@opentelemetry`/`openai`
deps), session telemetry, non-darwin-arm64 native binaries, and non-runtime files
(`.ts`/`.d.ts`/`.map`/third-party docs), plus stripping Node debug symbols (`strip -x`). Since 0.2.0 the
bundle is dominated by the **document-preview runtime** (`libreoffice-kit-darwin-arm64`, ~200M) and the
**speech runtime** (`sherpa-onnx-darwin-arm64`, ~33M), neither of which the slim build removes, so lite and
full now differ very little. Both reuse the system WKWebView (no Chromium), far smaller than an Electron build.

> After a full build, Settings → Models → **Add Provider** enables amazon-bedrock / anthropic / google /
> google-vertex / mistral / openai / openrouter / xai / groq / nvidia and 30+ more (the llm-pi-ai plugin
> loads lazily and activates once a provider is configured).

## Memory Footprint Comparison (measured)

The desktop app is slimmer not only in **installer size** but also in **runtime memory**. Measured
with the desktop in use vs. the web version opened in a browser (Chrome tabs cleared):

| | Desktop client | Web version (in browser) |
|---|---|---|
| Server | backend node 187 MB | fresh web node 177 MB |
| Rendering | WKWebView shell 90 MB (built-in) | browser (Chrome) ~1150 MB |
| **Total** | **~277 MB** | **~1.33 GB** |

**Conclusion**: the desktop app is roughly **1/5** of the web version's total, saving about **1 GB** of RAM.
Even with all Chrome tabs cleared, the browser carries ~1150 MB of **base overhead** (browser / GPU /
network / extensions), while the desktop folds that "rendering" into a 90 MB WKWebView shell and ships the
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
package version, e.g. `v0.2.0-rc.1`). Under **Settings → Check for Updates**:

- **Check for updates**: compares against the latest `@deepseek-ai/dsh` on the npm registry;
- **Update now**: downloads the latest closure (dsh + all its `@deepseek-ai/*` deps, plus any new
  third-party deps missing from the bundle) and atomically replaces the bundle's `node_modules`,
  then restarts the app (re-signed to keep the arm64 ad-hoc signature valid).

This is a built-in plugin (same pattern as cost-meter):

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
# 1) bump @deepseek-ai/dsh in package.json to the target version (e.g. 0.2.0-rc.1)
# 2) reinstall deps with a working node/npm (system node may be broken by an icu4c change; use nvm's node)
$HOME/.nvm/versions/node/v22.19.0/bin/npm install --omit=dev --no-audit --no-fund
# 3) rebuild
./build.sh
```

The `@deepseek-ai/dsh` version in the produced app = the version in `desktop/node_modules`, i.e. what
`package.json` declares.

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
> **Both plugin kinds work**: bundle plugins (e.g. updater, cost-meter) auto-join the bundle layer after install;
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
Pure ESM, no native binary; its `@deepseek-ai/dsh-client-ui-theme` dep ships with 0.2.0-rc.1.

| File | Role |
|---|---|
| `plugins/@frostgao/dsh-theme-blackgold/` | plugin source (host half is a placeholder; browser: black-gold token override) |
| `theme-blackgold.patch.yml` | registers the plugin (via `--patch`) |

## Session Cost Meter (dsh-cost-meter)

Bundled **dsh-cost-meter** ([Han-1413141/dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter),
v1.7.45), providing session-level cost stats:

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


## License

This project (`desktop/`) is licensed under the **MIT License** (see [LICENSE](LICENSE)).
All bundled third-party plugins and the upstream `@deepseek-ai/dsh` are MIT (each retains its own copyright
notice and LICENSE).
