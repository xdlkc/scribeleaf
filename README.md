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
Full 构建固定下载官方 Pandoc 3.1.11.1 的 arm64 / x86_64 ZIP，验证预置 SHA256，
合并并嵌入 Universal 转换器及 GPL 许可证。缺少依赖或校验失败会终止构建。
Full 首次构建需要网络；后续构建会重新校验缓存的压缩包。Lite 不下载或内置 Pandoc。

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

## Lite / Full 安装包（0.1.1，尚未发布）

| 版本 | 内置 Pandoc | 功能与依赖 |
| --- | --- | --- |
| Lite | 无 | Markdown 编辑/保存与原生 HTML、PDF、PNG 导出；文档转换需要可信的已有 Pandoc |
| Full | 官方 3.1.11.1 Universal | 同样的编辑器，内置经 SHA256 校验的转换器与对应许可证 |

两版均最低 macOS 13、Universal arm64 + x86_64。Lite 调用 Word、EPUB 等需要 Pandoc 的
导入/导出时，如果找不到转换器，会显示明确错误，说明可改装 Full，或在
「文件 → 导出 → Export Settings…」配置可信的已有 Pandoc。应用不会自动联网下载或安装依赖。

两版安装内容均名为 **Scribeleaf.app**，共用 `local.typora-replica.editor`、偏好和文档身份，
属于**互斥安装选项**，不支持并排安装。选择其中一版；手动替换已安装版本前先保存文档并退出应用。
安装包本身不会改变默认文档应用；本开发流程不会修改用户安装、偏好或文档。
`CFBundleDisplayName` 和 `ScribeleafEdition` 分别标记 Lite / Full。

```sh
# 默认 Full，兼容原构建路径 build/Scribeleaf.app
bash scripts/build-macos.sh
# 只构建 Lite，不获取 Pandoc：build/Lite/Scribeleaf.app
SCRIBELEAF_EDITION=Lite bash scripts/build-macos.sh
# 一次构建公共编辑器，再打包两版
bash scripts/package-macos.sh
```

`dist/packages/` 必须恰有以下四个不同名资产和一个覆盖四文件的 `SHA256SUMS`：

- `Scribeleaf-Lite-0.1.1-universal.zip` / `.dmg`
- `Scribeleaf-Full-0.1.1-universal.zip` / `.dmg`

运行 `shasum -a 256 -c SHA256SUMS` 验证下载完整性。约 8 MB 是此前临时副本的估算，
实际大小以当前构建产物为准。

## GitHub Release 验证

`Release packages` 在 PR、main 和手动运行时生成两版 Actions 产物。
CI 验证缺依赖行为、前端导出接线、ZIP/DMG 内容、四文件校验和、每个 Mach-O 的双架构与最低系统、
动态依赖及签名；确认 Lite 不含转换器、Full 包含许可，且两版的编辑器代码/数据段和前端资源一致（版本元数据与签名不同）。
两个原生运行器下载同一份产物，分别启动 Lite / Full，并验证 Full 的 Pandoc 转换。

推送与应用版本一致的 `v<major>.<minor>.<patch>` tag 后，全部检查通过才创建 **draft Release**，
之后仍需人工审阅发布；工作流不合并 PR。现有正式 `v0.1.0` 的 tag、Release 和资产保持不变。
当前仅 ad-hoc 签名，没有 Developer ID 签名或 Apple 公证，macOS 可能显示安全提示。
CI 使用 macOS 15；部署目标检查未替代 macOS 13 真机验收，原生启动冒烟未替代完整功能验收。

## 应用图标

Lite / Full 使用同一个原创书页＋叶片图标：深墨绿圆角底、暖白纸页与青绿叶片，
图标本体没有文字或外部品牌素材。可编辑矢量几何位于 `assets/icon/draw-icon.swift`。
运行 `bash scripts/build-icon.sh` 可重建透明 PNG、标准十项 iconset 和 `Scribeleaf.icns`。
PNG 覆盖 16/32/64/128/256/512/1024 像素；生成器检查透明角与内容边距，
`verify-icon.py` 检查 ICNS 的所有标准尺寸。已导出的素材与尺寸预览见 `assets/icon/`。
打包时仅内置一个 ICNS，不复制 PNG/预览/生成器，因此不会把整套设计素材放入安装包。
CI 另提供 `icon-assets` 供审阅。当前安装的 0.1.0 不会被本分支自动替换或刷新图标缓存。
