# Gothic 主题结果

已接入编辑器、原生/网页菜单、偏好和导出。

六份字体按原字节保留：TeXGyreAdventor 1.104（常规、粗体、斜体、粗斜体），Didact Gothic 2.101（两个西里尔子集）。来源、SHA-256 与许可证见 `src/assets/fonts/gothic/`。应用包同时带上 GUST、LPPL 1.3c、Didact OFL 全文。HTML 导出内嵌字体及许可。

## 实际验证

- `scripts/verify-gothic.mjs`：700 / 1200 / 1900px 三档通过。HTML 样本的选定计算样式与原版快照一致，六份字体全部加载。
- 当前证据：`evidence/gothic-verification.json`。
- 原始基线 `src/assets/fonts/gothic/STYLE-VERIFICATION.json` 的 `reference` 用于比较；其中 `replica` 是修正前历史样本，不能代表当前版本。
- Coordinator 另修正了窄屏引用的层叠顺序、代码字号/颜色/对齐与表格文字色。不是只核对标题。
- `scripts/verify-export.mjs` 验证 Gothic 字体数据和三份许可已进入独立 HTML。

这些检查覆盖 HTML 样本，不证明完整 CodeMirror 页面已经像素一致。原生截图、长文布局、源码模式和全部控件仍须按产品逐项对照。未修改原 Typora。
