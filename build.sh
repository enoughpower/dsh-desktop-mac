#!/usr/bin/env bash
# Build the DeepSeek Harness macOS desktop app into dist/DeepSeekHarness.app.
#
# Usage:
#   ./build.sh                 full multi-provider build (app only, default)
#   ./build.sh --dmg           build + also package a drag-to-install DMG
#   KEEP_EXTRA_PROVIDERS=0 ./build.sh   minimal build (DeepSeek only)
#
# Requires: macOS with Xcode command line tools (swiftc, codesign), node + npm.
set -euo pipefail

# Default to the full multi-provider build; set KEEP_EXTRA_PROVIDERS=0 for a
# DeepSeek-only minimal build. Export so prune.sh and the patch generation below
# agree on the same setting.
export KEEP_EXTRA_PROVIDERS="${KEEP_EXTRA_PROVIDERS:-1}"

# DMG packaging is opt-in: pass --dmg (or -d) to also build a drag-to-install
# DMG. By default we only produce the .app bundle.
PACK_DMG=0
for arg in "$@"; do
  case "$arg" in
    --dmg|-d) PACK_DMG=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

APP_NAME="DeepSeekHarness"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$ROOT/dist"
APP="$DIST/$APP_NAME.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RES="$CONTENTS/Resources"
BACKEND="$RES/backend"
VERSION="$(node -e 'console.log(require("./package.json").version)' 2>/dev/null || echo 0.1.0)"

ARCH="$(uname -m)"   # arm64 or x86_64
case "$ARCH" in
  arm64|x86_64) ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
esac

# A Homebrew `node` can stop working after an unrelated icu4c upgrade (its dylib
# is pinned to a specific ICU version). Prefer a Node.js that actually runs:
# an nvm-managed v22 first, then whatever `node` resolves to, and fail loudly
# rather than bundling a broken binary.
resolve_node() {
  for candidate in \
    "$HOME/.nvm/versions/node/v22.19.0/bin/node" \
    "$HOME/.nvm/versions/node/v22.15.0/bin/node" \
    "$(command -v node 2>/dev/null)"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && "$candidate" --version >/dev/null 2>&1 && {
      echo "$candidate"; return 0;
    }
  done
  echo "build.sh: no working node binary found" >&2
  return 1
}

# --- 0. dependencies -------------------------------------------------------
if [ ! -f "$ROOT/node_modules/@deepseek-ai/dsh/lib/bin.js" ]; then
  echo "==> installing production dependencies (one-time)"
  (cd "$ROOT" && npm install --omit=dev --no-audit --no-fund --loglevel=error)
fi

# --- 1. stage the backend --------------------------------------------------
rm -rf "$DIST"
mkdir -p "$MACOS" "$BACKEND"

echo "==> copying node_modules and pruning"
cp -a "$ROOT/node_modules" "$BACKEND/node_modules"
"$ROOT/prune.sh" "$BACKEND/node_modules"

# --- 1b. integrated desktop plugins (tracked source, not npm deps) ----------
# Every directory under plugins/ is a self-contained plugin bundle. Its
# destination under node_modules/<scope>/<name> is read from the plugin own
# package.json "name" field -- so dropping a new dir under plugins/ is all that
# is needed to bundle it (see add-plugin.sh). No per-plugin copy block required.
# Copy directory CONTENTS via `cp -a src/. dest` so an existing dest is merged.
copy_plugin() {
  local src="$1" name
  name="$(node -e 'const path=require("path");const p=process.argv[1];const j=require(path.resolve(p));process.stdout.write(j.name||"")' "$src/package.json" 2>/dev/null)" || name=""
  if [ -z "$name" ]; then
    echo "  WARN: no package.json name for plugin $src; skipping" >&2
    return 0
  fi
  local dest="$BACKEND/node_modules/$name"
  mkdir -p "$(dirname "$dest")"
  cp -a "$src/." "$dest/"
  echo "  bundled $name -> node_modules/$name"
}
# Unscoped plugin dirs: plugins/<pkg> and scoped dirs: plugins/@scope/<pkg>.
# Skip dirs that are just scope containers (no own package.json).
for pd in "$ROOT"/plugins/*/ "$ROOT"/plugins/@*/*/; do
  [ -d "$pd" ] || continue
  [ -f "$pd/package.json" ] || continue   # scope container, not a plugin
  copy_plugin "${pd%/}"
done
# --- 1c. Settings-panel nav icons (idempotent patch) ------------------------
# ui-settings-general maps nav glyphs by section id; teach it the "git" and
# "updater" ids so those sections show fitting icons instead of the gear.
python3 - "$BACKEND/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js" << 'PYEOF'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
s = p.read_text()
icons = [("git", "IconBranchOutline16"), ("updater", "IconRefreshOutline16")]
if not all(f'if (id === "{i[0]}") return' in s for i in icons):
    lines = s.split("\n")
    for i, line in enumerate(lines):
        if "IconSettingsOutline16, {" in line and i + 1 < len(lines) and "navIcon" in lines[i + 1]:
            indent = line[: len(line) - len(line.lstrip("\t "))]
            prop = lines[i + 1][: len(lines[i + 1]) - len(lines[i + 1].lstrip("\t "))]
            block = []
            for section_id, icon in icons:
                if f'if (id === "{section_id}") return' in s:
                    continue
                block += [
                    f'{indent}if (id === "{section_id}") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.{icon}, {{',
                    f'{prop}className: SettingsRoot_module_css_default.navIcon,',
                    f'{prop}size: 16',
                    f'{indent}}});',
                ]
            lines[i:i] = block
            break
    p.write_text("\n".join(lines))
PYEOF

# --- 1d. Settings sidebar section order (idempotent patch) -------------------
# The settings.section slot sorts sidebar rows by order. Reorder the shipped
# default to: 通用设置/模型/插件/技能/MCP服务/用量/Agent预设/检查更新.
# The plugin-owned rows (usage/updater/skills/mcp) are patched in their
# source under plugins/; agent-presets is an official package so we patch its
# order here (20 -> 45) so it lands right before updater (50).
python3 - "$BACKEND/node_modules/@deepseek-ai/dsh-client-ui-agent-preset/lib/client.js" << 'PYEOF'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
s = p.read_text()
old = 'id: "agent-presets",\n\t\t\t\torder: 20,'
new = 'id: "agent-presets",\n\t\t\t\torder: 45,'
if old in s and new not in s:
    p.write_text(s.replace(old, new, 1))
    print("patched agent-presets order -> 45")
PYEOF

# --- 2. bundle the Node.js runtime (strip local symbols, re-sign) ----------
NODE_SRC="$(resolve_node)"
echo "==> bundling node runtime from $NODE_SRC"
cp "$NODE_SRC" "$BACKEND/node"
# `-x` drops local symbols (~21 MB of debug/local symtab) while keeping the
# exported global symbols that native addons link against. A full `strip`
# removes those exports and segfaults when sharp/koffi/node-pty/etc. dlopen.
strip -x "$BACKEND/node" 2>/dev/null || true
codesign --force --sign - "$BACKEND/node" 2>/dev/null || true

# --- 3. launcher + profile overlay ----------------------------------------
cp "$ROOT/launcher.mjs" "$BACKEND/launcher.mjs"
# Runtime plugin helpers (方案 C): shim generator + per-profile plugin CLI.
# desktop-bin.mjs is imported by launcher.mjs; plugins.mjs is the CLI entry;
# dsh-home.mjs isolates the app's user-data home and links bundled plugins.
cp "$ROOT/desktop-bin.mjs" "$BACKEND/desktop-bin.mjs"
cp "$ROOT/plugins.mjs" "$BACKEND/plugins.mjs"
cp "$ROOT/dsh-home.mjs" "$BACKEND/dsh-home.mjs"
# The bundled pnpm (declared in package.json) enables dsh plugin in the app.
# node_modules is copied above; just verify the entry exists here.
# prune.patch.yml: without KEEP_EXTRA_PROVIDERS the Pi.ai multi-provider row is
# disabled (its SDKs were deleted by prune.sh); with it, only the (no-op by
# default) OTLP telemetry row stays disabled so Pi.ai actually loads.
if [ "${KEEP_EXTRA_PROVIDERS:-0}" = "1" ]; then
  cat > "$BACKEND/prune.patch.yml" << 'PATCH'
# Built with KEEP_EXTRA_PROVIDERS=1: multi-provider SDKs are retained, so only
# the OTLP telemetry exporter row stays disabled (no-op; launcher also sets
# DSH_TELEMETRY_DISABLED=1).
- id: session-telemetry-otel
  disabled: true
PATCH
else
  cp "$ROOT/prune.patch.yml" "$BACKEND/prune.patch.yml"
fi
cp "$ROOT/git.patch.yml" "$BACKEND/git.patch.yml"
cp "$ROOT/billing.patch.yml" "$BACKEND/billing.patch.yml"
cp "$ROOT/updater.patch.yml" "$BACKEND/updater.patch.yml"
cp "$ROOT/skills-hub.patch.yml" "$BACKEND/skills-hub.patch.yml"
cp "$ROOT/mcp-settings.patch.yml" "$BACKEND/mcp-settings.patch.yml"
cp "$ROOT/vision.patch.yml" "$BACKEND/vision.patch.yml"
cp "$ROOT/theme-blackgold.patch.yml" "$BACKEND/theme-blackgold.patch.yml"
cp "$ROOT/pocket.patch.yml" "$BACKEND/pocket.patch.yml"

# --- 4. compile the native WKWebView shell ---------------------------------
echo "==> compiling Swift shell"
swiftc -O -target "$ARCH-apple-macosx12.0" \
  -framework AppKit -framework WebKit \
  -o "$MACOS/$APP_NAME" \
  "$ROOT/App/main.swift"

# --- 5. Info.plist + icon --------------------------------------------------
cp "$ROOT/App/Info.plist" "$CONTENTS/Info.plist"
if [ -f "$ROOT/App/icon.icns" ]; then
  cp "$ROOT/App/icon.icns" "$RES/AppIcon.icns"
fi

# --- 6. sign (ad-hoc, for local use) ---------------------------------------
echo "==> code signing"
codesign --force --deep --sign - "$APP" 2>/dev/null || true

# --- 7. package a drag-to-install DMG (macOS) -------------------------
build_dmg() {
  echo "==> packaging DMG"
  local STAGE="$DIST/dmg-stage"
  # Naming: DeepSeekHarness-{version}-{build date MMddHHmm}-{full|lite}.dmg
  local DMG_DATE="$(date +%m%d%H%M)"
  local DMG_MODE="full"
  if [ "$KEEP_EXTRA_PROVIDERS" = "0" ]; then DMG_MODE="lite"; fi
  local DMG_NAME="DeepSeekHarness-${VERSION}-${DMG_DATE}-${DMG_MODE}.dmg"
  local DMG_PATH="$DIST/$DMG_NAME"
  local RWD="$DIST/dmg-rw.dmg"
  rm -rf "$STAGE" "$RWD"
  mkdir -p "$STAGE"
  cp -R "$APP" "$STAGE/DeepSeekHarness.app"
  ln -s /Applications "$STAGE/Applications"
  # volume icon (the app icon doubles as the mounted-volume icon)
  if [ -f "$ROOT/App/icon.icns" ]; then cp "$ROOT/App/icon.icns" "$STAGE/.VolumeIcon.icns"; fi
  # install-window background (rendered by a small Swift helper under dmg-tools/)
  local BG_TOOL="$ROOT/dmg-tools/make_dmg_bg"
  if [ ! -x "$BG_TOOL" ]; then (cd "$ROOT/dmg-tools" && swiftc make_dmg_bg.swift -o make_dmg_bg >/dev/null 2>&1); fi
  if [ -x "$BG_TOOL" ] && [ -f "$ROOT/App/icon.icns" ]; then
    mkdir -p "$STAGE/.background"
    "$BG_TOOL" "$ROOT/App/icon.icns" "$STAGE/.background/background.png" >/dev/null 2>&1
  fi
  # R/W volume first so Finder can write .DS_Store, then convert to compressed
  if ! hdiutil create -volname "DeepSeek Harness" -srcfolder "$STAGE" -ov -format UDRW "$RWD" >/dev/null 2>&1; then
    echo "  WARN: R/W DMG creation failed" >&2
    rm -rf "$STAGE"
    return 0
  fi
  local MOUNT="$(hdiutil attach "$RWD" | grep -oE '/Volumes/DeepSeek Harness' | head -1)"
  if [ -n "$MOUNT" ]; then
    SetFile -a V "$MOUNT/.background" 2>/dev/null || true
    osascript "$ROOT/dmg-tools/layout.applescript" >/dev/null 2>&1 || true
    hdiutil detach "$MOUNT" >/dev/null 2>&1 || true
  fi
  rm -rf "$STAGE"
  if hdiutil convert "$RWD" -format UDZO -o "$DMG_PATH" >/dev/null 2>&1; then
    rm -f "$RWD"
    echo "==> dmg: $DMG_PATH ($(du -sh "$DMG_PATH" 2>/dev/null | cut -f1))"
  else
    echo "  WARN: DMG convert failed" >&2
    rm -f "$RWD"
    return 0
  fi
}

echo
echo "==> built: $APP"
du -sh "$APP" 2>/dev/null
echo "   backend: $(du -sh "$BACKEND" 2>/dev/null | cut -f1)"

# --- 8. optional DMG output (only with --dmg) ---
if [ "$PACK_DMG" = "1" ]; then
  if command -v hdiutil >/dev/null 2>&1; then build_dmg;
  else echo "  (hdiutil unavailable - skipping DMG)" >&2; fi
else
  echo "  (DMG skipped - pass --dmg to package one)"
  echo "  e.g. "./build.sh --dmg""
fi