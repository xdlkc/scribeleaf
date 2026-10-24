# Scribeleaf

源码仓库：[xdlkc/scribeleaf](https://github.com/xdlkc/scribeleaf)（私有）。

Scribeleaf 是一个原生 macOS Markdown 编辑器，目标是复刻 Typora 1.14.10 的使用体验。

工程使用原生 AppKit 窗口和 WebKit 编辑器。原 Typora 安装包只用作只读参照。
项目仍在开发，尚未完成完整 1:1 验收。当前完成情况与已知差距见 [STATUS.md](STATUS.md)。

产品名为 **Scribeleaf**，结合书写（scribe）与纸页（leaf）。为保留已有设置和恢复记录，内部 bundle identifier 与存储键暂时沿用开发期标识。

## 开发和运行

```sh
npm install
npm run dev -- --host 127.0.0.1
```

## 构建 macOS 应用

需要本机 Node.js 和 Xcode Command Line Tools。

```sh
bash scripts/build-macos.sh
open 'build/Scribeleaf.app'
```

应用支持 HTML、无样式 HTML、PDF、全长 PNG，以及 Pandoc 的九种转换格式。
构建脚本固定下载官方 Pandoc 3.1.11.1 的 arm64 / x86_64 ZIP，验证预置 SHA256，
合并并嵌入 Universal 转换器及 GPL 许可证。缺少依赖或校验失败会终止构建。
首次构建需要网络；后续构建会重新校验缓存的压缩包。

原生“导出”菜单支持使用上次格式/目标再导出（Ctrl+Cmd+E）和覆盖上次输出。
覆盖前会确认。切换文稿后保留格式，并要求重新选择目标。历史保存在当前窗口内，
重启应用后清空。

通过“文件 → 导出 → Export Settings…”打开独立设置窗口。可设置默认目录、
Pandoc 路径、PDF 纸张/边距/头尾、HTML 追加内容/目录、PNG 宽度/质量/字号，
以及转换模板、附加参数和导出后的操作。可添加、重命名、排序和删除自定义格式。
这些设置在文稿窗口之间同步，并在重启后保留。

设置窗口可搜索并定位选项。“编辑器”支持符号配对、Emoji自动补全、列表/引用缩进、
复制行为、整行复制/剪切、当前块源码显示，以及打字机模式始终居中。关闭括号配对时，
Markdown配对会停用并保留原选择。Emoji词表使用MIT开放数据；完整原版词汇对齐仍待验证。

“使用上一次设置导出”保留当时的基础设置，每次重新读取当前文稿的 YAML。
主题选“当前主题”时，每次使用当前编辑主题。自定义命令从文稿目录运行；
应用管理的输出会先暂存。目录输出采用逐文件替换与失败回滚，用户命令自行
写入的其它内容不属于该输出事务。

## 验收

启动开发服务器后运行：

```sh
APP_URL=http://127.0.0.1:5174 node scripts/verify-browser.mjs
node scripts/verify-export.mjs
```

`APP_URL` 应与开发服务器输出的地址一致。当前会话使用 5174。浏览器脚本
使用 agent-browser。可用 `AGENT_BROWSER` 指定 CLI 的绝对路径。验收
文档位于 `fixtures/acceptance.md`。截图与测试结果位于 `evidence/`。

导出接线和嵌套编辑的本地回归分别为 `scripts/verify-export-formats.mjs` 与
`scripts/verify-nested-editing.mjs`。它们使用 JSDOM，不能替代真实浏览器验收。
`scripts/verify-image-export.py`、`scripts/verify-native-export-bridge.py` 会生成
独立的原生验收应用；真实 WebKit 和保存面板结果见 `STATUS.md`。

## GitHub Release 包

最低 macOS 13，Universal ZIP / DMG 均包含 arm64 与 x86_64。
`Release packages` 在 PR、main、release/** 分支和手动运行时生成经过校验的 Actions 产物；
两种原生运行器下载同一份包，校验 SHA256、架构、部署目标、签名与原生启动。
推送与应用版本完全相同的 `v<major>.<minor>.<patch>` tag 后，所有检查通过才创建 **draft Release**。
在 GitHub 审阅后手动发布；工作流不会自动对外发布正式版本，也不会合并 PR。
下载 ZIP、DMG 和 SHA256SUMS 后，在同一目录运行 `shasum -a 256 -c SHA256SUMS`。
当前分发包仅 ad-hoc 签名，没有 Developer ID 签名或 Apple 公证，可能出现 Gatekeeper 提示。
CI 使用 macOS 15；最低系统由 plist 与每个 Mach-O 切片的部署目标检查，未替代 macOS 13 真机测试。
