# DeepSeek Harness — macOS 桌面版

**中文** | [English](README.en.md)

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`@deepseek-ai/dsh`）封装成原生 macOS 桌面应用。壳使用系统 **WKWebView**（不是 Electron），后端打包精简后的 **Node.js 运行时 + 精简 node_modules**，因此体积远小于 Electron 方案。

## 快速开始（构建与使用）

### 产物

`./build.sh` 在 `dist/` 下产出 **`DeepSeekHarness.app`**（双击即可运行，本地临时签名）；
加 `--dmg` 时再打一个 **DMG 安装包**，命名
`DeepSeekHarness-<版本>-<MMddHHmm>-<full|lite>.dmg`（`full`=完整版，`lite`=精简版）。

### 构建

依赖：macOS + Xcode 命令行工具（`swiftc`/`codesign`）+ Node.js（打包运行时与装依赖）。

```bash
cd desktop
./build.sh                          # 默认：完整版（含全部多供应商 SDK）
./build.sh --dmg                    # 再打 DMG 安装包
KEEP_EXTRA_PROVIDERS=0 ./build.sh --dmg   # 精简版：仅 DeepSeek，体积更小（见「体积对比」）
```

- 首次构建会自动 `npm install --omit=dev` 安装 `@deepseek-ai/dsh` 生产依赖。
- `KEEP_EXTRA_PROVIDERS=0` 走精简路径：`prune.sh` 删掉 Pi.ai 等多供应商 SDK，`prune.patch.yml`
  把 `llm-pi-ai` 行置为 `disabled`；默认模型仍是 DeepSeek。

### 安装 DMG

1. 双击 `dist/DeepSeekHarness-<版本>-*.dmg` 挂载。
2. 把 `DeepSeekHarness.app` 拖进 **`/Applications`**（覆盖旧版前先退出正在运行的应用）。
3. 从启动台/Finder 打开即可；用户数据落在 `~/Library/Application Support/DeepSeekHarness`。

> 命令行覆盖安装：
> ```bash
> hdiutil attach <dmg>
> rm -rf /Applications/DeepSeekHarness.app && cp -R '<挂载点>/DeepSeekHarness.app' /Applications/
> hdiutil detach <挂载点>
> ```

## 目录结构

```
desktop/
├── App/
│   ├── main.swift          # 原生 WKWebView 壳：起后端、读 DSH_READY、加载页面、随退出清理
│   ├── Info.plist          # 应用清单（含 ATS 本地网络豁免）
│   ├── make_icon.swift     # 图标生成（可选）
│   └── icon.icns           # 已生成的图标
├── launcher.mjs            # 后端监督进程：spawn dsh web，确认就绪后输出 DSH_READY=<url>
├── desktop-bin.mjs         # node/pnpm 运行时 shim 生成器（方案 C）
├── plugins.mjs             # 用户级插件 CLI：add/remove/list（方案 C）
├── add-plugin.sh           # 一键装内置插件 / --runtime 走用户级安装
├── prune.patch.yml         # 禁用被裁剪掉的插件行（llm-pi-ai、telemetry）
├── git.patch.yml           # 注册内置 Git 插件
├── billing.patch.yml       # 注册内置费用插件 dsh-cost-meter
├── pocket.patch.yml        # 注册内置手机访问插件 dsh-pocket
├── updater.patch.yml       # 注册内置版本号/检查更新插件
├── skills-hub.patch.yml   # 注册内置全局技能库插件 dsh-skills
├── mcp-settings.patch.yml  # 注册内置 MCP 服务管理插件
├── vision.patch.yml        # 注册识图插件 dsh-vision-router v1.7.6（不接管 llm-deepseek）
├── theme-blackgold.patch.yml # 注册黑金主题插件（@frostgao/dsh-theme-blackgold）
├── prune.sh                # node_modules 精简脚本
├── build.sh                # 一键构建
├── plugins/                # 内置插件源码（构建时拷入后端 node_modules）
└── package.json            # 仅声明依赖 @deepseek-ai/dsh
```

## 体积对比（实测）

| 版本 | 构建命令 | App 包 | 内置后端 | DMG 安装包 | 说明 |
|---|---|---|---|---|---|
| **完整版 (full)** | `./build.sh --dmg` | 240M | 235M | ~79 MB | 含 Pi.ai / Anthropic / Google / OpenAI 等 30+ 提供方（llm-pi-ai 按需休眠加载） |
| **精简版 (lite)** | `KEEP_EXTRA_PROVIDERS=0 ./build.sh --dmg` | 203M | 200M | ~73 MB | 仅 DeepSeek，去掉多供应商 SDK 与遥测 |

精简版省的 ~37M 主要来自：删除 Pi.ai 多供应商 SDK 栈（`@earendil-works/pi-ai` 及拖入的
`@mistralai`/`@google`/`@anthropic-ai`/`@aws-sdk`/`@opentelemetry`/`openai`）、session 遥测、
非 darwin-arm64 原生二进制、`.ts`/`.d.ts`/`.map`/三方文档等非运行文件，并去掉 Node 调试符号
（`strip -x`）。两者都复用系统 WKWebView（不打包 Chromium），体积远小于 Electron 方案。

> 完整版构建后在 设置 → 模型 → **添加提供方** 可启用 amazon-bedrock / anthropic / google /
> google-vertex / mistral / openai / openrouter / xai / groq / nvidia 等 30+ 提供方
> （llm-pi-ai 插件按需休眠加载，配置 provider 即可激活）。

## 内存开销对比（实测）

桌面端不止**安装包更小**，**运行时内存也更省**。实测（同为使用中的桌面端 vs 浏览器访问、且 Chrome 已清空标签）：

| | 桌面客户端 | Web 版（浏览器访问） |
|---|---|---|
| 服务端 | 后端 node 160 MB | 全新 web node 177 MB |
| 渲染 | WKWebView 壳 98 MB（已内置） | 浏览器（Chrome）约 1150 MB |
| **合计** | **约 258 MB** | **约 1.33 GB** |

**结论**：桌面端约为 Web 版的 **1/5**，省约 **1GB** 内存。即使 Chrome 清空所有标签页，
浏览器仍有约 1150MB 的**基座开销**（浏览器 / GPU / 网络 / 扩展等进程）——而桌面端把这套
"渲染"吸收进了 98MB 的 WKWebView 壳里，后端一起打包成**一个应用**，省掉了"单独跑一个
浏览器"的整套内存。**安装包瘦身 + 内存瘦身，双赢。**

> 口径：桌面 = 后端 node + WKWebView 壳（一体化，刚启动的稳定值）；Web = 全新 web 服务 +
> 整个浏览器（含少量残留标签 / 扩展 / Chrome 基座，非纯 DSH 页面）。同为基于 WKWebView /
> Chromium 的渲染，桌面端把浏览器进程的开销省掉了。

## 工作原理

1. 应用启动后，Swift 壳用 `Process` 拉起 `Contents/Resources/backend/node launcher.mjs`。
2. `launcher.mjs` 先把应用的用户数据目录定为专用的 `DSH_HOME`
   （固定为 `~/Library/Application Support/DeepSeekHarness`；壳层在拉起后端时会**剥离
   环境里继承的 `DSH_HOME`**，确保应用始终使用专属 home，与命令行 `dsh` 的 `~/.dsh`
   完全隔离；直接运行 `launcher.mjs` 时仍可用 `DSH_HOME` 环境变量覆盖），
   并把内置插件在 `profiles/node_modules` 里建好软链，然后启动
   `dsh web --patch <各 overlay>.patch.yml --host 127.0.0.1 --port 0`，
   轮询确认前端可访问后，向 stdout 打一行 `DSH_READY=http://127.0.0.1:<port>`。
3. 壳读到 `DSH_READY` 后把该地址加载进 `WKWebView`。
4. 用户数据（配置、凭据、会话、profile、插件、技能）落在**独立的** `DSH_HOME`，
   与命令行 `dsh` 的 `~/.dsh` 完全隔离，互不干扰。
5. 退出应用时，壳向 launcher 发 `SIGTERM`，launcher 转发给 `dsh web` 完成优雅退出。

后端只监听 `127.0.0.1` 的随机端口，避免端口冲突与暴露到局域网。

## 版本号与检查更新

应用在**窗口右上角**常驻显示当前 DeepSeek Harness 版本号（`@deepseek-ai/dsh` 包版本，
如 `v0.1.1-rc.2`）。「设置 → 检查更新」里可以：

- **检查更新**：对比 npm registry 上 `@deepseek-ai/dsh` 的最新版本；
- **立即更新**：后台下载最新闭包（dsh 及其全部 `@deepseek-ai/*` 依赖）并原子替换进
  应用包内的 `node_modules`，完成后自动重启应用（重启前会重新签名，保证 arm64
  上的 ad-hoc 签名仍然有效）。

实现是内置插件（与 git 同模式）：

| 文件 | 作用 |
|---|---|
| `plugins/dsh-updater/` | 宿主半部：`/updater` JSON API（version / check / update / status） |
| `plugins/dsh-client-ui-updater/` | 浏览器半部：右上角版本徽标 + 设置里的「检查更新」区块 |
| `updater.patch.yml` | 注册这两个插件（launcher 启动时经 `--patch` 传入） |

### 如何真正升级 Harness

运行时「**检查更新**」只替换**当前应用包内**那份 `node_modules`，**不会写回桌面源码依赖**。
因此**只要重新运行 `./build.sh`，版本就会回到源码锁定的版本**（`build.sh` 每次都从
`desktop/node_modules` 重新拷贝）。

要**永久升级**（让 `./build.sh` 稳定产出新版本）：

```bash
cd desktop
# 1) 把 package.json 里 @deepseek-ai/dsh 的版本号改成目标版本（如 0.1.1-rc.2）
# 2) 用可用的 node/npm 重装依赖（系统 node 可能因 icu4c 损坏，用 nvm 的 node）
$HOME/.nvm/versions/node/v22.19.0/bin/npm install --omit=dev --no-audit --no-fund
# 3) 重建
./build.sh
```

`./build.sh` 产出应用包的 `@deepseek-ai/dsh` 版本 = `desktop/node_modules` 里的版本，
所以以 `package.json` 声明的版本为准。

## Git 源码管理

内置的 Git 插件提供**全屏 Git 面板**：入口是**对话（轨迹）视图右侧页签栏的「Git」页签**
（点击后用面板替换聊天/轨迹区域），Esc / 关闭按钮退出。
打开时**自动关联当前会话的工作目录**（`useSessions` 读取当前会话 cwd）；
顶部栏有「刷新」按钮。

功能：

- **状态分区**：暂存区 / 未暂存区 / 未跟踪文件分栏列出；**checkbox 即暂存开关**——
  勾选未暂存文件即暂存，取消已暂存文件的勾选即取消暂存；「未暂存」标题旁有全选框，
  一键全部暂存 / 全部取消暂存。
- **丢弃改动**：每行右侧 `⋯` 菜单 →「丢弃改动」恢复工作区改动（未跟踪文件不提供）；
  「移除文件」从工作区删除该文件（含未跟踪文件，二次确认后不可恢复）。
- **提交**：**只提交已暂存（勾选）的文件**（`提交已暂存 (N)`），未暂存的不受影响；
  支持 amend 上次提交；**提交说明为多行输入**（Enter 换行、随内容自动增高，⌘/Ctrl+Enter
  或「提交」按钮提交），下方输出回显。
- **分支切换**：顶部分支按钮弹出分支菜单，按「本地 / 远程」分组**列出全部本地与远程
  分支，点击整行即切换**（远程分支点选后自动创建同名本地跟踪分支，本地同名存在时回退切
  本地）；当前分支高亮带圆点、不可点。菜单为纵向窄列表、行无边框；行内保留重命名 ✎ /
  删除 ✕（二次确认）。「新建」（从选中提交建分支）与「合并」（合并选中提交到当前分支）
  在**提交详情工具栏**，样式与「刷新」一致。
- **远程操作**：推送（-u 设上游）、拉取（--ff-only）、Fetch --prune。
- **历史**：图形化提交图（Git Graph 风格：主线靠左、分支向右分叉后竖直向下，
  每条分支按列着色；HEAD 为空心圆，其余为实心圆点），点击提交看完整 diff；支持
  文件级历史（`git log -- <file>`）与 blame。
- **文件对比**：点击文件查看「工作区 vs HEAD」内容对照（含文件历史）。
- **面板布局**：第 2 列上方为提交历史（占满剩余高度），最下方为提交表单。
- **差异视图**：diff 按文件分类展示（文件头 + 新增/删除/重命名/二进制徽标），修改位置
  用绿色/红色色块标出，每行标注新旧行号，hunk 头显示 `@@ -旧行 +新行 @@`。
- **文件浏览**：页签栏「Git」右侧新增 **「文件」** 页签——左侧为该工作空间的完整文件树
  （支持**一键全部展开/收起**），右侧显示文件内容；文本编辑基于 **CodeMirror 6**（VS Code 级
  **语法高亮**与编辑：行号、代码折叠、括号匹配、多光标、undo/redo…支持 JS/TS/JSX/TSX/JSON/
  HTML/CSS/Python/Markdown/YAML/Shell/C/C++/Java/Kotlin/Go 等），⌘/Ctrl+S 保存、⌘/Ctrl+E
  切换编辑/预览；图片等常见格式直接预览。编辑器采用 **One Dark** 主题，适配黑金深色。
  **.md/.markdown** 预览模式自动渲染为 Markdown（GFM、断行、表格/引用/代码块），编辑模式显示源码。

| 文件 | 作用 |
|---|---|
| `plugins/dsh-git/` | 宿主半部：`/git` JSON API（status/stage/diff/commit/branch/merge/log/blame/cat 等 28 个操作）+ `/fs` 文件 API（tree/read/write） |
| `plugins/dsh-client-ui-git/` | 浏览器半部：Git 页签 + 文件浏览页签 + 全屏面板 UI |
| `git.patch.yml` | 注册这两个插件（launcher 经 `--patch` 传入） |

**面板效果：**

![Git 面板：分支栏 + 提交历史 + 变更文件 + 差异视图](./docs/screenshots/git-panel.png)

## 识图（dsh-vision-router）

内置第三方插件 **dsh-vision-router**（见其
[GitHub 仓库](https://github.com/ysr666/dsh-vision-router)，内置 **v1.7.6**），
给纯文本模型（DeepSeek 等）提供**像素保真的图片理解**：

- **原图直看**：图片轮交给视觉模型看原图，DeepSeek 始终负责思考；图片轮就像普通
  **工具调用**（`vision_ground` → `vision_crop` → `vision_describe` → `vision_pixel_diff`
  … 可连续多步迭代定位/裁剪/比对/修复），可定位、可验证。
- **默认免费**：视觉工具兜底 5 个 OVHcloud 匿名视觉模型，免注册免 Key（每 IP、
  每模型 2 次/分钟）；用户自备视觉模型（智谱/百炼/OpenRouter 等）优先调用。
- **14 个深看工具**：Q&A / 定位 / 裁剪 / 像素比对 / 取色 / OCR / SVG 矢量化 / 抠图 /
  HTML 截图 / 长截图识读等；无 Python，基于 sharp / potrace / tesseract / 系统 Chrome。
- **设置**：设置 → 插件 → 插件配置 → **「Vision Router」**卡片；接管官方路由与否由
  「隐身模式」开关决定（默认关，官方 `llm-deepseek` 行保持启用）。
- **不写日志**：指向视觉工具的改写只发生在模型输入层，会话日志里仍是原图。

| 文件 | 作用 |
|---|---|
| `plugins/dsh-vision-router/` | 插件源码（v1.7.6：宿主路由 + 14 个视觉工具 + 浏览器半设置卡） |
| `vision.patch.yml` | 注册该插件 + 附件准入放宽（20 MiB / 100 MP / 单边 10000 px）；不接管 llm-deepseek） |

## 全局技能库（dsh-skills）

内置第三方插件 **dsh-skills**（[CocoSgt/dsh-skills](https://github.com/CocoSgt/dsh-skills)）。
把散落的技能汇成全局库：Claude Code 的
`~/.claude/skills`、项目目录、`.skill` 包等统一入库到 `$DSH_HOME/skills`（官方
skill-filesystem 默认扫描根，watcher 实时），入库即出现在输入框的「/」斜杠菜单；
设置页侧栏有「技能」导航页。

功能：

- **两种入库身份**：引用（符号链接，编辑即编辑来源）/ 副本（整树拷贝，独立演化）。
- **全局技能页签**：＋ 新建技能、上传 `.skill`、可视化筛选；每张卡带身份徽标、
  资源文件数、非默认调用策略；「编辑 SKILL.md」内联编辑、导出 `.skill` 整树打包、
  打开目录、删除（引用只删链接，两步确认）。
- **发现页签**：扫描目录 chips 就地管理，结果可「引用 / 复制」，支持「全部引用」批量。
- 全部文案经官方 locale 服务中英渲染；同系列搭配 `dsh-attachments` / `dsh-inspector`。

| 文件 | 作用 |
|---|---|
| `plugins/dsh-skills/` | 插件源码（宿主半：`skillHub` Typert 网关：状态 / import（引用|复制）/ edit / export；浏览器半：设置页技能中枢） |
| `skills-hub.patch.yml` | 注册该插件（launcher 经 `--patch` 传入） |


## MCP 服务管理

内置了第三方插件 **@opendsh/dsh-plugin-setting-mcp**（npm 包），在设置页加一个
「**MCP 服务**」入口，可**查看、新增、修改、移除、启用/停用** MCP 服务（stdio /
Streamable HTTP），点「保存」即热更新生效（无需重启进程）。它管理的是
`@deepseek-ai/dsh-mcp-client` 的 loader 条目，并把服务集合持久化写回 profile 的
`cordis.patch.yml`。

| 文件 | 作用 |
|---|---|
| `plugins/@opendsh/dsh-plugin-setting-mcp/` | 插件源码（宿主半：typert `ctx.mcp` 服务；浏览器半：设置页 MCP 服务管理） |
| `mcp-settings.patch.yml` | 注册该插件（launcher 经 `--patch` 传入） |


## 用户插件（方案 C：运行时安装，不重编译）

内核的 `dsh` 原生支持用户级插件：把应用装进 **profile**（`$DSH_HOME/profiles/web`）里的
`node_modules`，通过声明 `dsh.bundle` 自动加入 layer 栈（`$DSH_HOME` 是应用自己的用户目录，
默认 `~/Library/Application Support/DeepSeekHarness`，可设 `DSH_HOME` 覆盖）。本应用已内置该机制：

- **运行时自带的 node/pnpm**：`launcher.mjs` 启动时用 `desktop-bin.mjs` 生成
  `$DSH_HOME/.desktop-bin/{node,pnpm}` shim 并前置 PATH，`dsh plugin` 因此能在
  打包后的应用里跑通，无需系统 Node / pnpm。
- **一键 CLI**（`add-plugin.sh`）：
  ```sh
  ./add-plugin.sh --runtime add <npm包名或本地目录>   # 装
  ./add-plugin.sh --runtime list                      # 列出已装的 bundle
  ./add-plugin.sh --runtime remove <包名>             # 卸
  ```
- **不重编译**：用户插件存在 `$DSH_HOME`,`./build.sh` 重建/升级只重写应用包内的
  node_modules，不会清掉用户已装插件。要装的是声明了 `dsh.bundle` 的 bundle 插件
  （`package.json` 带 `dsh.bundle.patch` + `cordis.patch.yml`）。

> `--runtime add` 会传 `-w`（profile 是 pnpm workspace 根，pnpm 需要该标志）。
> `remove`/`list` 用包全名（如 `@scope/name`），以 `list` 输出为准。
>
> **两类插件都支持**：声明 `dsh.bundle` 的插件（如 git/updater）装完自动加入 bundle 层；
> 只声明 `dsh.client` 的纯前端插件（如 `@frostgao` 的主题插件）`dsh plugin add` 不会自动激活，
> `plugins.mjs` 会在 profile 的用户层 `cordis.patch.yml` 里自动补一条激活 row，移除时一并清理。

## 黑金主题（@frostgao/dsh-theme-blackgold）

内置 `@frostgao/dsh-theme-blackgold`（@frostgao 出品的配搭主题），作为**应用内插件**打包
（源码在 `plugins/@frostgao/dsh-theme-blackgold`），把 Web 界面重绘成**黑金配色**
（黑白底 + 金色强调，浅色 / 深色两套）：

- **品牌标**：鲸鱼 logo 金色描边 + 悬停微动；`HARNESS` 徽标黑底金字 + 周期性高光扫过。
- **页面强调色**：发送键、激活的会话/轨迹/工作区标签、光标、高亮等金色化。
- **细节**：侧栏运行点金色跑动、新会话光环淡金、ContextMeter 等。
- 纯演示层覆盖（走 `dsh-client-ui-theme` 的 token 覆盖），尊重 `prefers-reduced-motion`。

该插件是**客户端专属**（`immediately: true`，无需在设置里开开关），随插件清单在启动时
自动加载生效。纯 ESM、无原生二进制，依赖的 `@deepseek-ai/dsh-client-ui-theme` 为 0.1.1-rc.2 自带。

| 文件 | 作用 |
|---|---|
| `plugins/@frostgao/dsh-theme-blackgold/` | 插件源码（宿主半为空占位；浏览器半：黑金 token 覆盖） |
| `theme-blackgold.patch.yml` | 注册该插件（launcher 经 `--patch` 传入） |

## 会话费用统计（dsh-cost-meter）

内置 **dsh-cost-meter**（[Han-1413141/dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter)，
v1.5.38），提供会话级费用统计：

- **费用**：本会话成本、当日费用、历史记录；内置 90+ 模型价格目录自动匹配，与官方价格一键同步。
- **余额 / 额度**：官方余额、可配自定义 Provider 余额（任意 HTTP 端点）与余额进度条；主流
  Coding Plan 订阅额度查询与显示（7 家，含 SCNet Token Plan 本地 Credits 计量）。
- **峰谷计价**：峰谷时段显示，切换前弹窗 / 系统通知提醒（位置 / 提前量 / 类型可配）。
- 界面中英双语；配置在 设置 → 插件 → dsh-cost-meter。

| 文件 | 作用 |
|---|---|
| `plugins/dsh-cost-meter/` | 插件源码（宿主：costMeter 服务 + ledger；浏览器半：费用展示与设置） |
| `billing.patch.yml` | 注册该插件（launcher 经 `--patch` 传入；`name:` 必须带引号，linkBundledPlugins 只收集带引号的 name） |


## 手机访问（dsh-pocket）

内置 **dsh-pocket**（[shaobeichen/dsh-pocket](https://github.com/shaobeichen/dsh-pocket)，
v1.14.5，GPL-2.0），把 DSH「装进口袋」——**手机扫二维码实时同屏**电脑上的界面：

- **局域网扫码**：设置 → **手机访问**，同一 WiFi 下手机扫码即开（自动识别本机局域网 IP；
  独立 8 位数字密码，默认开启，可一键关闭或自定义）。
- **公网扫码**：点「开启公网访问」→ cloudflared 快速隧道（首次自动下载）→ 出公网二维码，
  人在外面（4G / 任何网络）也能访问；公网有独立 8 位密码（默认每次开启自动换新，可自定义）。
- **实时同屏**：手机看到的就是电脑上的 dsh web 界面，WebSocket 全透传、双向操作，窄屏自动
  变移动端抽屉布局；内置心跳保活与断线重连、响应 gzip/brotli 压缩。
- **桌面版适配**：桌面端自动注入 dsh-desktop-mode=compatibility，扫码同屏正常可用；
  插件内「更新 / 重启」两项在桌面版自动停用（由应用统一管理）。端口冲突（3081 被占）时
  代理自动换端口，无需干预。

| 文件 | 作用 |
|---|---|
| `plugins/dsh-pocket/` | 插件源码（宿主：改头反向代理 + 二维码 + 隧道；浏览器半：设置页「手机访问」+ 移动端适配） |
| `pocket.patch.yml` | 注册该插件（launcher 经 `--patch` 传入；`name:` 带引号以便 linkBundledPlugins 软链） |

> ⚠️ **安全**：DSH 能执行电脑上的代码。局域网/公网链接都配独立 8 位密码才可访问，请勿把
> 二维码 / URL / 密码发给他人；开启公网前会强制弹出安全免责声明，用完建议及时关闭。
> 登录状态绑定电脑上的 dsh web 进程——应用重启 / 更新后手机需重新输入一次密码。


launcher 还会把后端目录（含内置 `node` 二进制）放在 `PATH` 最前，确保插件跑视觉
子进程时用的是应用自带的 Node，而非可能损坏的系统 Node。

## 许可证

本项目（`desktop/`）采用 **MIT License**（见 [LICENSE](LICENSE)）。
内置的各第三方插件与上游 `@deepseek-ai/dsh` 均为 MIT（各自保留其版权声明与 LICENSE）。
