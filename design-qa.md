> 2026-10-20 快照说明：当前源代码已增加 Files/Image/Markdown 三类偏好，产品名为 Scribeleaf。下面是此前的视觉验收记录。新增页面的完整像素与焦点对照尚未重跑；缺失类别的旧观察不能作为当前源码仍缺少类别的结论。

# 偏好窗口视觉对照

当前完整产品视觉尚未通过。本轮修复了导出区域的明显差距，并完成Editor设置接线。

## 对照输入

- Source: `evidence/typora-export-settings-general.png`，安装原版1.14.10。
- Implementation: `evidence/replica-export-settings-layout-general.png`，当前生产PID49103。
- 两图均为1440×960物理像素，对应720×480 CSS像素、2x密度。没有缩放或平移来隐藏差距。
- State: 浅色、Export → General、自动输出目录、Pandoc空路径、导出后选项关闭。
- Full view: `evidence/preferences-layout-comparison-general.png`。原版在左，副本在右。
- Focused view: `evidence/preferences-layout-comparison-detail.png`。两图使用同一物理裁剪框[730,64,1400,492]。
- 当前PDF预览另有原生AX证据`evidence/preferences-layout-native-pdf.ax.txt`。截图接口两次未返回像素，因此没有声称该页新的像素验收。较早截图保留为`replica-export-settings-layout-pdf-before.png`。

## Findings

- [P1] 主分类及内容未齐。原版有Files/Editor/Image/Markdown/Export/Appearance/General七类。副本当前只有四类；General/View内容还需按原版重组。缺少的字段和行为见`evidence/preferences-panels-reference.json`。
- [P2] 固定格式标签被截断。原版完整显示“HTML (without Styles)”，当前副本显示省略号。需在保持列宽和卡片位置的条件下修正按钮文本可用宽度，并重新捕获原生画面。

## Comparison history

1. 初始副本仅三类，文案多为英文，格式列过窄，右卡片偏左约17 CSS像素，表单密度不符。初始图为`evidence/replica-export-settings-final.png`。
2. 重做分组、中文、搜索、图标工具栏、列宽和原生控件。当前并排图和局部图显示卡片与字段结构已接近原版。关闭窗口最小化能力，与原版AX状态一致。
3. 原版源码进一步证明：非custom纸张尺寸是readonly，不是disabled；Default显示缓存尺寸或A4。已修正，浏览器和最终原生AX均显示210×297。四边距控件按行对齐。
4. 独立功能审阅发现搜索漏项/组内行定位和多光标整行复制多插空行。搜索修复已由真实浏览器确认；复制修复有138项永久回归，包括LF/CRLF、末尾无换行、去重、剪切及Undo。

## 验证与剩余范围

真实in-app浏览器验证了搜索、依赖、焦点、实际配对、Emoji候选/Unicode接受、纸张模式及边距布局，共19项。两页error级日志为空。原生另有9项接线观察。浏览器页和临时5182服务已关闭，当前原生应用继续运行。

字体占位文字粗细、图标形状和少量间距仍有P3差异。深色、其他格式完整页面、Editor原版截图及完整主编辑器像素对照仍需继续。功能计数不替代这些对照。

final result: blocked
