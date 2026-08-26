# 改动记录（CHANGELOG）

> 按天记录本项目的改动要点。使用说明与当前状态见 [README](README.md)。

## 2026-08-22

- **Git 面板 UI 优化**：
  - 分支弹窗改为纯切换（本地/远程列表、点击整行切换、纵向窄列表、行无边框）；
    「新建/合并」移到提交详情工具栏并统一样式；移除顶部仓库路径输入；提交说明改多行
    输入（Enter 换行，⌘/Ctrl+Enter 提交）。
  - 文件行「⋯」菜单改为图标、点击区域撑满整行高度；下拉菜单危险项（移除文件）高亮改灰色。
- **费用插件**：改用 dsh-cost-meter（会话费用统计：本会话/当日费用、余额、Coding Plan
  额度、峰谷计价提醒）。
- **升级**：`@deepseek-ai/dsh` 0.1.0-rc.8 → 0.1.1-rc.2；第三方插件升级（dsh-vision-router
  1.7.6、dsh-cost-meter 1.5.38、@opendsh/dsh-plugin-setting-mcp 0.1.2）。
- **修复**：桌面端启动崩溃（因环境变量 `DSH_HOME` 泄漏导致后端误用外部 home）；
  桌面凭证文件格式适配 `dsh-credentials-local`。
- **打包**：DMG 命名规范 `DeepSeekHarness-<版本>-<MMddHHmm>-<full|lite>.dmg`；
  README 新增构建教程与体积对比表、Git 面板截图。
- **许可证**：采用 MIT。

## 2026-08-24

- **新增「文件」页签**（Git 页签右侧，同插件）：工作空间完整文件树（左）+ 文件内容
  查看/编辑（右）；文本可编辑保存（⌘/Ctrl+S）、图片等常见格式预览、轻量**代码高亮**
  （JS/TS/JSON/HTML/CSS/MD/Python/YAML/Shell/C 系）、⌘/Ctrl+E 切换编辑/预览。
- 宿主新增 `/fs` 文件 API（tree / read / write，含越界拦截）；README 中英双语同步。
- 「文件」页签增强：**一键全部展开 / 全部收起**目录；**代码高亮升级**（状态化分词：块注释、
  多行字符串、二级关键字、内置类型、属性访问、函数调用等更细着色，JS/TS/JSON/Python/YAML/
  Shell/C 系关键字更全）。
- **文本编辑升级为 CodeMirror 6**（VS Code 级）：esbuild 打成**单个自包含 bundle 并内联进
  git 客户端**（`dsh-client-ui-git/client.js`，~700KB；不引入独立插件/模块，避免 loader
  入口解析问题），行号/代码折叠/括号匹配/多光标/undo-redo；语言 JS/TS/JSX/TSX/JSON/HTML/CSS/
  Python/Markdown/YAML/Shell/C/C++/Java/Kotlin/Go。原轻量高亮器保留为兜底。
- **修复**：文件页签点击文件后整块空白——CodeMirror 6 编辑器原先自带一份内置 React 拷贝，
  与宿主 React 冲突导致组件树渲染崩溃；已改为**无 React 的命令式 API**
  （window.DshCodeMirror.create(host, ...)：destroy/setReadOnly/setLanguage/setValue/focus）
  并保持单文件内联，文件面板改用 ref 宿主 + 生命周期 effect 管理编辑器。
- **修复**：文件页签「点击编辑后整块空白」——`setReadOnly` 原以 Facet 输入作事务 effect
  （非法、在 effect 内抛错致 React 卸载子树）；改用 Compartment 重配 `editable`/`readOnly`，
  只读/可编辑切换不再重建编辑器、不报错。
- **配色**：编辑器改用 **One Dark** 主题（VS Code 风），适配黑金深色主题；背景透明跟随面板。
- **Markdown 渲染**：`.md`/`.markdown` 文件预览模式自动渲染为 HTML（GFM、断行、表格/引用/代码块），
  编辑模式仍显示源码；内置 `marked` 并过滤 `<script>`/`<iframe>`/事件属性以避免执行。
- **配色微调**：移除与 One Dark 冲突的 `defaultHighlightStyle`（亮色调高亮在深色背景上对比不足），
  令牌着色统一由 One Dark 提供；编辑器背景由透明改为显式深色（跟随 `--dsw-alias-bg-layer-1`，
  兜底 `#1a1a1a`），修复进入编辑态时背景变白的问题；`.cm-content/.cm-line/.cm-scroller` 设为透明。
- **新增 dsh-pocket 插件（手机访问）**：设置页新增「手机访问」入口——局域网二维码（同一 WiFi
  手机扫码即开，独立 8 位密码，可关/可自定义）与可选的 cloudflared 公网隧道（公网二维码 +
  8 位密码，默认每次开启自动换新）；手机看到的即电脑上的 dsh web 界面，WebSocket 实时同屏，
  支持移动端抽屉布局。桌面版自动兼容（插件内更新/重启项停用；注入 dsh-desktop-mode=compatibility）。
  宿主运行时依赖 qrcode 一并打包；pocket.patch.yml 注册（name 带引号以便 linkBundledPlugins 软链）；
  dsh-pocket@1.14.5（GPL-2.0）。
