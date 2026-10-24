# 当前状态

目标：完整复刻本机 macOS Typora 1.14.10。**仍在开发，未证明完整 1:1。**
本文件的通过项不能替代全产品的功能、视觉和系统行为对照。

本地应用：`build/Scribeleaf.app`；源码：本目录。当前宿主为 Intel macOS，部署目标 macOS 13。应用与原 Typora 共存。

## 2026-10-20 命名与提交快照

产品名改为 **Scribeleaf**。窗口、菜单、关于页面、npm 包和 macOS 构建产物使用新名称。
内部 bundle identifier、桥接名称和存储键保留，以兼容开发期设置和恢复记录。
历史证据保留原始名称。当前源代码还包含文件、图像、Markdown 偏好及原生消费链路。
本次新名称构建的 TypeScript、Vite、Swift、资源检查与 deep strict 签名均通过；
源文件摘要与范围见 `evidence/scribeleaf-branding-build.json`。本次未做新的原生启动和完整偏好截图验收。

新增专项验证：文件偏好150项、原生文件工作流83项、导入86项、图像原生50项与DOM51项、
Markdown127项、拖放DOM31项与注入原生7项均通过。它们不是完整产品验收。
文件工作流的对话框选择使用注入；图像上传器未进行真实云端往返。
Markdown偏好为25项已实现、4项部分实现、2项未实现；iPic专有IPC尚未实现。
七类偏好已接线；通用、外观及完整原生视觉/焦点对照仍未完成。

## 当前实现

- AppKit / NSDocument / WKWebView 壳、原生菜单、文件与目录、最近文件、保存、关闭保护、恢复、外部更新。
- 单栏 CodeMirror 实时 Markdown、源码模式、查找替换、文件树/文档列表/大纲侧栏、专注/打字机模式、统计、偏好。
- 递归目录监测、空目录/资源目录、完整文件枚举；未保存副本恢复保留资源基址与工作目录。
- YAML 元信息、内容目录、五类警告框、HTML 注释、引用式链接、段落插入与任务状态命令；实时编辑和HTML出口接线。
- 表格直接编辑：即时写回、位置映射、历史、增删/调整行列、对齐、行列拖动、组合输入。
- 富文本/纯文本粘贴、异步多图片、图片落盘/引用、切文档归属隔离。
- GitHub / Gothic / Night / Newsprint / Pixyll / Whitey 六主题；Gothic、Newsprint、Pixyll 的开放字体及许可已打包。
- 样式/无样式 HTML、PDF、全长 PNG、Word、OpenOffice、RTF、EPUB、LaTeX、Media Wiki、reStructuredText、Textile、OPML 导出。
- 使用上次格式/目标再导出，以及直接覆盖上次输出；按窗口保存历史，换文档后保留格式并禁直接覆盖；覆盖确认可选择不再询问。
- 编辑器9项偏好：括号/Markdown配对、Emoji补全、缩进与对齐、复制/剪切、当前块源码、打字机居中；设置搜索与定位。
- 独立偏好窗口与全局持久化；导出格式增删/改名/排序、自定义命令、输出目录、后续操作、YAML覆盖、图片与PDF选项、Pandoc参数和自动writer。重复导出冻结原始设置，再应用当次YAML与当前主题。
- HTML 内嵌主题字体、许可和可读取的本地图片；PDF/打印/PNG 基于完整独立 HTML，不截取虚拟编辑器可见区域。当前构建包含官方 Pandoc 3.12.1，二进制保持原厂签名。

## 当前证据

以下文件均在 `evidence/`；每项的范围以实际用例为准。

| 检查 | 结果与范围 |
| --- | --- |
| TypeScript / Vite / Swift / 严格签名 | `.macos-build.log` 通过，经典 IIFE 入口支持 file://；`verify-bundle.mjs` 检查脚本、CSS和本地资源 |
| 前一里程碑构建与启动 | `native-build-verification.json`；完整导出设置构建与deep strict签名均exit0，当前55份运行源码已绑定构建；旧原生导出快照41/52相同，11份导出核心源码不变。最新Editor138项、浏览器19项及原生9项另记；GitHub文稿无Edited，实际配对/前台撤销通过 |
| 基础编辑回归 | `browser-verification.json` 15/15；中文、CRLF、模式切换、历史、变更通知、脚注点击、围栏 |
| 表格真实浏览器交互 | `table-browser-verification.json` 16/16；包括正文位置更新、DOM焦点、历史显示同步、工具条、换行、行列拖动 |
| 剪贴板接入回归 | `clipboard-browser-verification.json` 8/8；DOM paste、菜单、单元格、异步图片映射、同内容新文档、迟到结果、保留字符路径 |
| 原生图片 | `native-images-verification.json` 6/6；真实落盘、重名、复制、引用、文件名、未知模板不自动写目录。未操作系统剪贴板 |
| 实际图片预览 | `native-image-preview.json`、`replica-image-paths.png`；最终应用实际显示含空格/%/#/?/括号路径的PNG |
| Cocoa 中文组合输入 | `native-ime-verification.json` 与 `native-table-ime-verification.json`；正文/表格提交、整次撤销重做、源码切换。未测试具体输入法候选界面 |
| 控件快捷键 | `input-shortcut-verification.json`；键盘/菜单全选保留数值框编辑目标，不误改正文 |
| Typora 格式快捷键 | `shortcut-verification.json` 6/6；行内代码/删除线、脚注、水平线、替换和保存为；修复 CM 忽略打印字符 Shift 导致的冲突 |
| 文件树与文档列表 | `sidebar-tree-verification.json` 21/21；真实浏览器目录排序/折叠、同名路径、筛选祖先、键盘和原生CSS |
| 原生文件导航 | `native-navigation.json`；实际快捷键切换列表/树，最终验收窗口无临时副本条目 |
| 原生目录与恢复 | `native-files-verification.json` 38/38；5107文件、真实根/嵌套增删改名、新目录、合并/去重/关闭取消、旧恢复记录及UTF16/BOM。当前宿主实际使用DispatchSource后备，FSEvents启动不可用 |
| 侧栏更新集成 | `folder-updates-verification.json` 9/9；真实应用boot/bridge/sidebar的JSDOM检查，保持正文、焦点、筛选选区及隐藏/大纲状态。不是原生视觉验收 |
| 段落命令 | `product-commands-verification.json` 19/19 本地CodeMirror；选区、历史、CRLF、标题边界、任务和控件焦点。其中嵌套任务/引用已有下述真实Chromium回归，标题/插段落等仍待专项 |
| 新语法渲染 | `product-rendering-verification.json` 19/19 本地HTML/CodeMirror；TOC/元信息/警告框/注释/引用及逐字键入、真实Enter回归。嵌套任务/引用/假任务排除已有真实Chromium回归；TOC/警告框等仍待专项 |
| 嵌套编辑 | `nested-editing-verification.json` 14/14；真实CodeMirror/JSDOM任务框、引用/有序列表、续行、CRLF、BOM、历史和引用命名。不是Chrome布局验收 |
| 真实浏览器编辑 | `product-browser-verification.json` 20/20；最终集成构建的真实Chromium/CodeMirror，含13项状态/DOM用例、实际点击和键盘输入/Enter/撤销重做、Unicode、CRLF/BOM、引用命名及运行时异常检查。未验证特定原生输入法候选界面 |
| 原生引用任务框 | `native-quote-task-smoke.json` 5/5；当前生产App点击四层引用中的任务框后变未选，Cmd+Z恢复选中与未编辑状态；第二任务与源文件字节不变。未保存测试变更 |
| 原生新语法与键入 | `native-product-verification.json`、`replica-product-native.png`；真正原生键入后保存尾文、注释、直引号和双连字符；目录定位、链接引用快捷键及撤销 |
| HTML | `export-verification.json` 14/14；内容、公式、脚注、内嵌字体与Gothic许可 |
| 本地导出图片 | `export-assets-verification.json` 55/55；真实 Swift 编译和 AppKit 图片解码；不同输出目录，删除源目录后仍解码，特殊路径、单次 HTML 实体解码、srcset、缺失资源保留并报告 |
| 实际副本与图片导出 | `native-duplicate-export.json`、`replica-duplicate-image.png`；原生复制保留相对图片预览，实际HTML导出的PNG字节与源图一致；验收临时文件已移回工程缓存 |
| 原生 PDF | `native-pdf-verification.json`；18页、首尾完整，导出对象真正释放后再结束测试 |
| 导出接线 | `export-formats-verification.json` 24/24；JSDOM真实main/命令/bridge，13格式取当前未保存快照、保持文档身份和后续编辑，未知格式不会误导出HTML |
| Pandoc转换 | `document-conversion-verification.json`；35/35传输/取消/失败保留检查，另9/9真实Pandoc格式转换；DOCX/ODT/EPUB图片字节和RTF图片通过。文本格式引用源图路径，需保留源资源 |
| 原生保存与转换 | `native-export-bridge-verification.json`；此前20/20真实NSSavePanel/Task/完成反馈，另3/3文件内容检查；Word、EPUB、无样式HTML均实际保存。此后桥接已增加重复导出，最新原生接线以以下51项证据为准 |
| 重复导出状态/接线 | `repeat-export-state-verification.json` 18/18；格式/路径/换文档/无历史/请求token，Swift5/macOS13及TypeScript通过。`repeat-export-bridge-verification.json` 30/30，真实main/CodeMirror的JSDOM检查，含13格式快照和异步切文档阻断 |
| 重复导出实机 | `repeat-export-native-verification.json` 51/51、11个完整生产renderer/native场景，另3份HTML独立解码；Save/警告取消、重用完整文件名、换目标、覆盖确认/抑制、换源禁覆盖、转换失败后保留历史与未保存快照。历史仅存窗口内存；原版跨重启行为仍未知 |
| 全长PNG后端 | `image-export-verification.json`；18/18真实AppKit/WebKit检查及PIL九图，含1x全回归、2x/3x物理像素/定位与3x细条纹真实增采样；长图拼接、字体/延迟图、失败/取消/超时、物理像素上限和窗口释放有覆盖。主App设置消费者另见下述原生16阶段及独立几何证据 |
| PDF设置后端 | `pdf-export-options-verification.json`；16/16原生helper检查，pypdf独立确认URL/GoTo/outline/vector，两页Poppler几何比对与头尾目检通过。系统默认纸张保留；无头尾复制原字节，有头尾用公开PDFKit规范化原点并同步内容/目标。头尾是独立布局，未证明与Typora像素一致；主App消费者已通过下述原生流程与四页几何验收 |
| 导出设置模型边界 | `export-settings-boundaries-verification.json`；30项通过，覆盖冻结base与当次YAML、嵌套数组快照、原版字面大小写和truthy回退、全局append保留、标准YAML、argv及设置继承。仅模型边界，不代替原生输出验收 |
| 自定义导出与后续操作后端 | `native-export-settings-verification.json`；31/31真实Swift5/macOS13 CLI检查。双管道/有限捕获、子进程组取消与回收、源目录和宏、当前快照、文件原子替换、目录逐文件提交与批次回滚、真实Pandoc/WebTeX/metadata、JSON类型及异步post均有覆盖。任意用户命令自行写入的副作用不在App管理的输出事务内 |
| 编辑器偏好消费者 | `editor-preferences-verification.json`；138/138真实CodeMirror/JSDOM检查，含实时重配、符号配对/跳过闭合/Backspace/撤销、1903项开放许可Emoji候选/接受、2–5空格/Tab/自动检测、列表引用缩进、复制/剪切DOM事件、表格既有处理、简单块焦点源码、旧Prefs/hydrate；既有剪贴板回归及13项原生YAML检查通过。Mac出厂默认和原版Emoji词汇完整一致尚未证明 |
| 设置实际浏览器交互 | `preferences-ui-browser-verification.json`；19项真实in-app浏览器操作通过，含搜索定位、控件依赖/保留值/焦点、实际括号/Markdown配对、实际Emoji候选与Unicode接受、纸张readonly/custom切换及四边距布局，无error日志。不是原生系统剪贴板或全产品像素验收 |
| 新偏好原生接线 | `preferences-ui-native-verification.json`；9项实机观察，包括9字段UI、配对依赖/值保留/恢复、实际Shift+9生成括号对、激活应用后Cmd+Z撤销并清除Edited、文件SHA不变、Default纸张210×297只读预览及禁最小化。后台投递撤销未生效的上下文有保留；没有把它当产品缺陷。新PDF截图两次只得AX文字，未声称新的PDF像素验收 |
| 偏好布局对照 | `preferences-layout-reference.json`、`preferences-layout-comparison-{general,detail}.png`及`design-qa.md`；同720×480、2x密度的原版/最新原生截图已并排和局部对照。卡片、分组、中文和工具已修；完整窗口仍因缺少三分类、固定标签截断而未通过视觉验收 |
| 完整偏好字段参照 | `preferences-panels-reference.json`；除Export外6类82项Mac字段及54项renderer baseline，附来源hash/偏移/中文文案/依赖/当前接入缺口。原生factory默认未冒认；不能把字段清单当已实现 |
| 独立设置窗口焦点 | `export-settings-focus-verification.json`；6/6实机检查，文本快捷键留在字段、原生命令禁误改后台文档、重命名原生输入框与实际导出菜单更新、源文件字节不变。系统剪贴板仅在内存备份并恢复；不包含完整设置视觉或格式消费者验收 |
| 完整原生导出设置流程 | `export-settings-native-verification.json`；16阶段60/60真实生产renderer/native检查，实际Save/Cancel/Replace/Open及失败对话框、未保存快照、HTML/PNG/PDF/DOCX/ODT/EPUB/custom/folder/noDialog、YAML与repeat均有覆盖；另2/2实际关闭重启后的产品设置/双窗口主题检查。任意shell外部副作用不能回滚；目录是逐文件提交加批次回滚 |
| 设置跨进程持久化证明 | `export-settings-native-raw-runner.json`保留原runner自动62/63及4个pending，唯一失败为QA sentinel读取少了standard fallback；产品Store已具备fallback。`export-settings-restart-proof.json`使用相同生产源码、新进程只读检查9/9，defaults前后hash一致。聚合分别列出60原生、2产品重启、9独立证明及3份补充证据，不把原runner改称全通过 |
| 参数消费者与主题重算 | `export-settings-producers-verification.json`为3个实际App.performExport场景/4项检查，确认额外argv优先、CRLF/ascii/reference及空writer自动识别；`export-settings-renderer-verification.json`为4/4真实WebKit主题检查，重复导出重算当前主题，显式Night保持不变 |
| 转换器打包 | `bundled-converter-verification.json`；官方Pandoc 3.12.1二进制SHA256一致，保留原厂签名，完整GPL许可与对应源码地址随应用打包 |
| 实际打印面板 | `native-print-ui.json`、`replica-print-panel.png`；面板可见、取消返回文档、PID不变。未发送物理打印 |
| 原生 UTF-8/UTF-16/关闭取消 | `native-verification.json`、`native-utf-16-verification.json`、`native-close-verification.json`；隔离页面验证，不能代替完整编辑器全部文件工作流 |
| Gothic 字体与样式 | `gothic-verification.json`；700/1200/1900宽度下HTML样本的选定计算样式与参考一致，6份字体加载。不是完整编辑器像素验收 |
| 其余四主题 | `theme-styles-verification.json`；700/1200/1900宽度下5412项选定CSS级联/DOM选择器声明检查、12份字体完整性通过。补正UA pre默认间距；CM行不能证明块间距，已明确不把它当该证据 |
| 四主题真实计算样式/字体 | `theme-browser-verification.json`；真实Chromium将原版CSS与实际导出HTML对照，4主题×3宽度共3000项选定计算样式一致，12/12字体面实际加载。`theme-native-smoke.json`另记录原生切换；这仍不证明完整编辑器块间距、像素一致或原生每份字体加载 |
| 图片导出字号语义 | `image-font-reference.json`、`image-font-browser-verification.json`；真实renderer的exportPrepare出口与原版CSS同浏览器对照，六主题×320/640/1200宽×默认/24px根字号共36场景、2340项选择样式/100px固定图片/长无空格文本换行检查全通过。删除逐节点缩放脚本，按根字号与rem/em处理，补齐原版write的word-wrap。Pixyll/Whitey保留默认根等效值；原5412静态项、3000真实计算样式及12份字体回归通过。不是原版像素对照 |
| 实际PNG与PDF设置几何 | `export-settings-output-geometry-verification.json`；19项独立解析通过。320CSS×quality2的PNG宽640，源色块测得固定100px图片宽200物理像素；四页210×148mm PDF的body clip匹配四边自定义边距，允许1.2pt取整；头尾/作者/页码、首尾正文与margin band均确认，四页Poppler渲染已目检。此前2cm CSS覆盖原生边距的真实失败保留在`export-settings-output-geometry-before.json`与`export-settings-pdf-margin-before.pdf`；已将浏览器与原生打印页策略分开。不是头尾像素对照或通用PDF规范校验 |
| Raw Type的TOC消费者 | `raw-toc-conversion-verification.json`；99项真实Pandoc检查通过。独立TOC段落生成MediaWiki/LaTeX raw，保留fenced/indented/inline/escaped/HTML/math/reference-link等literal及`--strip-comments`，并确认空writer按.html/.tex自动识别；失败/取消/超时的临时文件清理通过。原始regex错误有实际输出baseline；不声称所有原版Raw Type语法均已复刻 |

早期 `webkit-verification.json` 是受限隔离环境的失败记录。当前生产启动与编辑已通过，勿把旧失败当作当前阻断。旧 `replica-browser-initial.png` 不是当前效果。

## 本轮关键修复

- file:// 无法执行 ESM：改为经典脚本、合并CSS，保留Web安全设置。
- 多行装饰使用 StateField，widget 更新/析构正确委派，变更监听跨文档状态保留。
- 原生保存快照、CRLF/编码、快速变更通知、恢复与文件身份。
- 表格末格Tab失焦会导致快捷键误改正文：已修复并实测；工具条裁切、行手柄命中、thead误匹配也已修复。
- 图片先注册待办再读FileReader；迟到回调不得写入新文档。保留特殊文件名并正确解析alt与URL。
- PDF 同步 run() 曾产生无限空页：改为可分线程的 runModal。
- 取消打印曾因隐藏 NSWindow 重复释放崩溃：显式管理窗口生命周期，并把面板挂在真实文档窗口；释放回归与实机取消通过。
- 新增文件树与文档列表；原生菜单补表格增删、文稿复制、导出子菜单，并按实机修正多项快捷键。
- 本地图片在原生 HTML/PDF/打印出口转为 data URL；无法读取的资源保留原值。标准 srcset 支持 x/w/h，未编码的空格或歧义逗号保留并报告。
- 未保存副本保留资源基址；资源基址与文件身份分开，保存仍创建副本文件，不覆盖原稿。源目录图像预览与实际 HTML 导出已实测。
- 引用标记曾重复计算空格，装饰越过行尾引发RangeError，导致后续原生输入失同步、落盘丢失尾文。已修复；保留 `native-typing-before-fix.md`、`native-typing-after-quote-fix.md`、`native-typing-final.md` 三份实际保存证据。
- 使用公开的NSTextView替换动作和WKWebView菜单验证，关闭本App默认智能破折号/引号；实际原生输入与保存均保留Markdown标点。没有修改用户全局设置。
- 标题升降、链接引用菜单与混合任务切换按原版资源修正；新增命令不会从表格、输入框或对话框按钮误改旧正文光标。
- 多层引用和嵌套列表中的任务框按Markdown语法树识别，代码/HTML中的伪任务不生效；点击仅改状态字符。续行命令定位所属任务，引用定义命名包含引用/列表内定义并忽略伪定义。
- 导出菜单补齐13种格式。转换和长图使用导出时快照；取消、失败及关窗不会写回原稿，已有输出以原子替换方式保留。原生保存流程已实测三类代表格式。
- PNG 等待字体与图片，再分段抓取并按实际滚动位置拼接，避免长文截尾和末段重复；关闭并释放全部临时WebKit窗口。
- 实机新增用例发现fixed/sticky会被逐段重复抓取。导出时现固定其静态位置；保持吸顶元素的原有文档流与transform容器内fixed的原位置，页级底部fixed放在全页底部。普通正文保持分段viewport，不因全高布局改变vh内容。PNG修复独立验证通过，未改变此前原生Word/EPUB/无样式HTML接线验收覆盖的路径。
- Night/Newsprint/Pixyll/Whitey按原版CSS修正字号、颜色、断点与代码块；主题字体使用独立别名，防止切换后串用。
- Newsprint/Pixyll/Whitey的导出pre曾把浏览器默认上间距清零；真实浏览器对照发现后恢复为1em。静态声明检查补正UA默认样式，不再用单个CM行推断整个代码块间距。
- 上次导出按窗口保留格式/完整路径，确认目标后即更新，即使后续转换失败。取消不更新。Ctrl+Cmd+E重开保存面板；覆盖走确认面板。带token的请求和文档代次阻断异步HTML生成期间的换文档结果，不把旧内容写入新文档出口。

## 尚未完成的产品对照

这些是继续工作的范围，不是重新定义目标的排除项：

1. 已建立 `PARITY-MENUS.md` 和 `evidence/menu-comparison.json` 实机菜单入口差距表。偏好与完整行为仍需核对；菜单名称存在不代表行为已验收，数量不能当完成比例。
2. 同文档/同尺寸逐项视觉差分。标题栏位置、段落/列表/表格/代码块整体间距、六主题及全部控件仍未达到已证明的像素一致。HTML导出pre的间距已对齐；编辑器CM行、源码空行和margin collapse需按实际块位置继续验证。
3. 深入验证多行/嵌套编辑、文件管理、长文和大目录、保存恢复、打印与导出边界。目录外部变化与副本恢复已修复并隔离验证，仍需完整原生文件树焦点验收。嵌套任务与引用定义已修复并有本地回归；首次保存后是否应自动采用父目录仍需对齐。
4. 偏好现有Editor/Export/View/General四个主分类；仍需补Files/Image/Markdown与其余原版字段，并把General/View内容按原版重组。Editor9项已接线并验证，部分中文和导出布局已按原版修正；特定输入法候选界面和系统剪贴板完整流程仍需实测。
5. 导出偏好功能已接入并验收，但其布局、中文文案和控件仍未与原版逐像素对齐。原版AST/全部argv/defaults、Raw Type其他语法、项目级设置、重复导出的跨重启/同路径重载、YAML/root-url、完整HTML命名实体及SVG内部相对资源仍需对照。当前重复历史仅在窗口内存；已验证的本地img/srcset可移植性见55项证据。

重复导出的只读参照见 `evidence/repeat-export-reference.json`。实现由订阅Grok 4.6 low完成主体（22 turns、exit0），再由本地审阅补齐代次/token、菜单动态启用与原生完整流程。Ctrl+Cmd+E来自原版实机菜单捕获；原版跨重启持久化仍未实测，当前历史只存窗口内存。

## 执行上下文

最新一轮已完成Editor9项消费者、设置搜索、导出表单分组/中文、开放图标和纸张readonly预览。独立审阅找到的搜索漏项/组内定位、多光标整行复制多插空行均已修复。Editor138/138、浏览器19项、原生9项以及既有嵌套14/段落19/渲染19项本地回归通过；当前生产PID49103，完整构建与严格签名exit0。55份运行源码绑定到构建；旧原生导出QA有41/52源码未变，11份导出核心不变，没有把旧16阶段说成新UI重跑。原始sentinel误报与独立9项持久化证明仍原样保留。

当前设置仅Editor/Export/View/General四分类。Files/Image/Markdown及General/View重组仍待做，完整视觉验收是blocked；这不代表整个goal外部阻塞。字段参照已有六类82项，可直接据此继续实现。

真实输出及旧验收器源码已按字节归档到`evidence/export-settings-native-artifacts/`，带SHA256 manifest；两次UI基础设施中止记录保留为压缩档。临时QA应用、重复renderer、Swift模块缓存和无用harness stream已清理，详见`export-settings-cleanup.json`。要重跑原生QA需重新prepare；历史证据里的.cache路径是当时执行位置。完整产品目标仍在继续，下一阶段应优先处理设置界面与其余偏好面板差距。

- 表格、剪贴板、Gothic、文件树主体由订阅 Grok 4.6 完成；初始编辑器由 Kimi K3 完成。最新原生目录/恢复、新语法、导出与主题由子Agent在工作区完成，Coordinator集成并修复实机发现的问题。本轮较早Grok与浏览器CLI提权因自动审批模型容量故障未执行；后续一次新的Grok只读调查获准并已结束，没有绕过审批。最新主Grok服务返回402，不能把它误记为认证或自动审批失败。
- Grok 4.7 ID 不被本机harness接受；4.6实际prompt可用。后续用 low effort 和有文件边界的任务，避免长时间只读推理。未改全局模型/认证配置。
- pi当前自定义表只有Qwen，但内置目录含DeepSeek Flash、GLM5.3、Kimi K3。早先只看自定义表而认为没有这些模型，现已纠正。目录存在不证明订阅可用；实际禁工具DeepSeek调用在请求前因缺少API key退出。未改pi默认模型、认证或全局配置。
- 当前 `kimi` 使用 `~/.kimi-code` 配置，`kimi-code/k3` 的无工具短调用已exit0并返回READY。一次后续项目验收脚本只读审阅被自动审批拒绝，理由为未确认源码可发往该外部服务；调用未执行，已改用本地审阅，没有绕过拒绝或更改全局认证。
- 最新低成本调用见`preferences-ui-harness.json`：pi DeepSeek缺API key、dsh本地loader/凭据版本类型错误、禁工具隔离Kimi150秒无内容。均未更改全局认证/配置；没有把项目源码发给这些调用。公开规格临时目录已清理。不要在无新证据时重复相同失败。
- 开发服务：`http://127.0.0.1:5174`（启动句柄17335；先验证服务是否仍活跃）。
- 当前应用PID49103；最终完整构建、bundle检查及deep strict签名通过。最终再次显示本任务`typing-repro-final.md`，GitHub、无Edited。实际配对测试已用前台Cmd+Z撤销，文件SHA未变。主画面`replica-preferences-milestone-editor.png`、新设置`replica-editor-preferences-native.png`与`replica-export-settings-layout-general.png`；`replica-export-settings-layout-pdf-before.png`明确为纸张预览修复前，最终PDF只保存AX证据。
- 本轮独立浏览器会话`typora-font-qa`、`typora-wrap-qa`、临时5182服务器和导出设置QA均已关闭。Grok无后台作业；Kimi被拒绝的源码审阅没有执行。此前自己的Finder窗口已关闭，用户原“下载”窗口保留。没有改变默认文件关联或全局模型/认证配置。
- 标准路径未发现系统Pandoc；本轮在工程缓存取得并校验官方3.12.1，可直接运行，且已原样打包进应用。没有更改全局PATH或系统安装。
- 更早一次额外签名/清理提权被自动审批容量故障拦住；本轮普通工作区严格签名复核已成功。两份过期临时文件 `typora-paragraph-grok-brief.md` 与 `typora-paragraph-grok.log` 已用正常沙箱命令清理，没有修改权限或绕过审批。
- 只管理本任务的 typora-qa、gothic-qa 等 QA 浏览器会话，不关闭用户其它 Chrome。
- 原 Typora 中的 `fixtures/acceptance.md` 是本任务参照窗口；关闭前核实身份与未编辑状态。

## Release packaging (2026-10-24)

Added Universal app/ZIP/DMG generation, pinned compatible Pandoc 3.1.11.1,
SHA256SUMS, tag/version checks and draft-only GitHub Release automation.
Every bundled Mach-O is checked for arm64/x86_64, deployment target <=13,
system-only dylib dependencies and valid ad-hoc signatures. CI launches the
same ZIP on native Apple Silicon and Intel runners. No Developer ID signing
or notarization is configured; macOS 13 hardware execution remains unverified.
This release work does not revalidate historical product parity evidence.

Release validation evidence: local npm typecheck, Vite build and native renderer
bundle verification passed. Both native Swift slices compiled with macOS 13 targets.
The package job in https://github.com/xdlkc/scribeleaf/actions/runs/40060033587
passed on dc665a5, including actual ZIP extraction and read-only DMG verification.
The earlier run 40059882676 correctly failed on Pandoc 3.12.1 arm64 minos=15.0;
selected 3.1.11.1 official slices report arm64=12.0 and x86_64=11.0.
Final-commit CI and native launch results are linked in the release PR.
