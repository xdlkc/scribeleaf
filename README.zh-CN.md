# Scribeleaf

[English](./README.md) | 简体中文

**Scribeleaf** 是一款原生 macOS Markdown 编辑器，采用 **AppKit（`NSDocument` + `WKWebView`）** 原生外壳与独立实现的 **TypeScript + CodeMirror 6** 实时预览渲染器，目标是对齐 macOS 版 Typora 1.14.10 的编辑与导出体验。

> **开发阶段说明**：项目目前**仍在积极开发中**，尚未完成与 Typora 1.14.10 的完整 1:1 功能与逐像素验收。当前已完成范围、测试证据与已知差距请参阅 [`STATUS.md`](./STATUS.md)，菜单对照清单见 [`PARITY-MENUS.md`](./PARITY-MENUS.md)。

## 架构与兼容性

- **原生 AppKit + WebKit 混合架构**：原生 Swift/AppKit 层（[`native/`](./native)）负责 `NSDocument` 文档生命周期、原生菜单、递归目录监测、偏好设置窗口、PDFKit 输出与 Pandoc 子进程调用；前端编辑器（[`src/`](./src)）通过 Vite 打包为经典 IIFE 脚本与样式，供 `WKWebView` 以本地 `file://` 方式加载。
- **独立实现**：原版 Typora 1.14.10 仅作只读设计参照，所有编辑器与原生代码均为独立编写。
- **共存与兼容标识**：产品名已定为 **Scribeleaf**（构建产物为 `build/Scribeleaf.app`，可执行文件 `Scribeleaf`，当前版本 `0.1.0`），可与 Typora 共存安装。内部 bundle identifier（`local.typora-replica.editor`）、桥接名称与存储键暂时保留兼容标识，以免丢失已有设置和恢复记录。
- **系统要求**：macOS 13.0 及以上（`LSMinimumSystemVersion = 13.0`），发布包为 Universal 2（`arm64` + `x86_64`）通用二进制。

## 核心能力

- **原生窗口操作**。拖动文档标题栏即可移动窗口。
- **实时预览与源码模式**：基于 CodeMirror 6 的单栏所见即所得写作区，支持标题、列表、任务复选框、引用块、围栏代码高亮、KaTeX 数学公式、Mermaid 图表、YAML 元信息、内容目录（TOC）、警告框、HTML 注释、引用式链接与脚注，支持无损切换完整源码模式。
- **表格直接编辑与粘贴处理**：支持表格实时写回、撤销重做、行列增删与对齐、行列拖动及中文输入法组合输入；支持富文本/纯文本粘贴、异步多图落盘与按文档隔离的图片引用。
- **工作区侧栏与写作模式**：侧栏支持文件树、文档列表、递归文件夹监测和大纲。侧栏打开时，「文件」与「大纲」标签始终可见。另支持查找替换、专注模式、打字机模式，内置六套主题（`GitHub`、`Gothic`、`Night`、`Newsprint`、`Pixyll`、`Whitey`）及开放许可字体（[`public/fonts/`](./public/fonts)、[`public/licenses/`](./public/licenses)）。
- **13 种导出格式与重复导出**：
  - **内置导出**：带样式 HTML、无样式 HTML、PDF（支持纸张、边距与页眉页脚）以及全长 PNG（多视口分段拼接）。
  - **Pandoc 转换（9 种格式）**：`docx`、`odt`、`rtf`、`epub`、`latex`、`mediawiki`、`rst`、`textile`、`opml`。
  - **重复导出**：原生「导出」菜单支持使用上次格式/目标再次导出（`Ctrl+Cmd+E`）以及确认后直接覆盖上次输出（切换文稿后保留格式并要求重新选择目标；历史记录保存在当前窗口内存中）。
- **独立偏好设置与导出配置**：通过「文件 → 导出 → Export Settings…」打开独立窗口，配置默认目录、Pandoc 路径、PDF/HTML/PNG 参数、自定义格式与排序、模板、自定义命令、导出后动作及 YAML 覆盖，支持跨窗口同步与重启保留。支持搜索的编辑器设置涵盖符号/Markdown 配对、Emoji 自动补全、列表与引用缩进、复制/剪切行为、当前块源码显示及打字机始终居中。

## 目录结构

```text
scribeleaf/
├── native/                 # AppKit / NSDocument / WKWebView 原生层、PDF/PNG/Pandoc 导出与设置窗口
├── src/                    # TypeScript + CodeMirror 6 编辑器、主题样式、导出构建与桥接逻辑
├── public/
│   ├── fonts/              # 内置界面字体
│   ├── licenses/           # 第三方字体与 Pandoc 许可证
│   └── samples/            # 示例 Markdown 文档
├── fixtures/               # 验收测试文档（如 acceptance.md）
├── scripts/                # 构建、Pandoc 拉取校验、打包与自动化验收脚本
├── STATUS.md               # 详细完成状态、验证结果与未完成项
├── SPEC.md                 # 重构架构与 WebKit 桥接契约说明
└── PARITY-MENUS.md         # 与 Typora 1.14.10 的菜单入口对照记录
```

## 开发与构建

### 浏览器端渲染器开发

需要本机安装 Node.js（CI 使用 Node 22）：

```sh
npm install
npm run typecheck
npm run dev -- --host 127.0.0.1
```

开发服务器默认监听端口 `5173`（详见 [`vite.config.ts`](./vite.config.ts)）。

### 构建 macOS 原生应用

需要本机安装 **Node.js** 与 **Xcode Command Line Tools**：

```sh
bash scripts/build-macos.sh
open 'build/Scribeleaf.app'
```

构建脚本会调用 [`scripts/fetch-pandoc.sh`](./scripts/fetch-pandoc.sh) 下载官方 **Pandoc 3.1.11.1**（`arm64` 与 `x86_64` ZIP），校验预置 SHA256 后使用 `lipo` 合并并嵌入 `Contents/Resources/Converters/pandoc`，同时打包 GPL 许可证（[`public/licenses/pandoc/`](./public/licenses/pandoc)）。首次构建需要联网，后续构建会重新校验 `.cache/pandoc/` 中的缓存压缩包。

### 验收与回归脚本

启动开发服务器（`npm run dev -- --host 127.0.0.1`）后运行：

```sh
APP_URL=http://127.0.0.1:5173 node scripts/verify-browser.mjs
node scripts/verify-export.mjs
```

- `verify-browser.mjs` 通过 `agent-browser`（可用 `AGENT_BROWSER` 指定路径）基于 [`fixtures/acceptance.md`](./fixtures/acceptance.md) 执行浏览器验收。
- 原生资源包校验：`node scripts/verify-bundle.mjs dist`
- JSDOM 本地回归（不能替代真实浏览器或 WebKit 验收）：`node scripts/verify-export-formats.mjs`、`node scripts/verify-nested-editing.mjs`
- 独立原生验收脚本：`python3 scripts/verify-image-export.py`、`python3 scripts/verify-native-export-bridge.py`（真实 WebKit 与保存面板验收记录见 [`STATUS.md`](./STATUS.md)）。

## 打包与 GitHub Release

本地构建 Universal（`arm64` + `x86_64`）ZIP / DMG 分发包与 `SHA256SUMS`：

```sh
bash scripts/package-macos.sh
```

- [`.github/workflows/release.yml`](./.github/workflows/release.yml) 在 PR、`main`、`release/**` 分支及手动触发时运行，并在 `macos-15`（`arm64`）和 `macos-15-intel`（`x86_64`）原生运行器上验证 ZIP 解压启动。
- 推送与 [`native/Info.plist`](./native/Info.plist) 及 [`package.json`](./package.json) 版本号完全一致的 `v<major>.<minor>.<patch>` tag 后，全部检查通过才会创建 **draft Release**，供人工审阅后发布。
- 下载 ZIP、DMG 与 `SHA256SUMS` 后，在同一目录运行 `shasum -a 256 -c SHA256SUMS` 校验。
- 当前分发包仅作 ad-hoc 签名，未配置 Developer ID 签名或 Apple 公证，首次打开可能触发 Gatekeeper 提示。CI 仅检查 plist 与各 Mach-O 切片的 macOS 13 部署目标，不能替代 macOS 13 真机测试。
