# Gothic 独立主题任务

请直接实现和验证，不需要计划或确认。使用中文汇报。

## 目标与边界

为本项目补齐 Typora 1.14.10 的 Gothic 主题。只准新增或修改：

- `src/themes/gothic.css`
- `GOTHIC-RESULT.md`

本 brief 和 `GOTHIC-HARNESS.jsonl` 由调度器维护，不要改动。其他文件一律只读。不要改 package、native、菜单、枚举、集成、已有样式或测试。不要启动子 Agent 或另一个模型/harness。不要联网。不要修改 Typora、用户配置或其他项目。项目没有 Git 仓库，不要依赖 git。

## 可读输入

- `AGENTS.md`
- `src/themes/github.css`
- `src/styles/base.css`
- `/Applications/Typora.app/Contents/Resources/TypeMark/style/themes/gothic.css`
- 验证所需的已安装本机工具与依赖的元数据；可只读查询本机字体可用性。

原版仅作为样式行为参考。独立编写 CSS，不嵌入原程序，不复制原版应用代码或字体文件。

## 实现要求

1. 使用 `body[data-theme="gothic"]` 限定所有样式，包括响应式规则。定义现有系统使用的 `--paper`、`--bg`、`--text`、`--heading`、`--font-body` 等主题变量。
2. 同时覆盖实时 CodeMirror（`#editor .cm-*`、`.lp-*`）和导出 `.md-render`。保持源代码模式可编辑，不用不加限定的全局样式。
3. 复现主要特征：`#fcfcfc` 纸面、`#111` 正文、`#990000` 链接；几何 Gothic 无衬线字体；大写居中的普通字重一级/二级标题与其行高、间距；914px 内容宽度及 1400px 下 1024px 宽度；正文 1.75rem 行高与两端对齐；细灰色引用线、透明引用、灰色引用文字；无底纹的细边框代码；表格横线与单元格间距；不同标题级别、任务列表、可复用控件配色。
4. 需要覆盖 base 里优先级较高的 qualified editor rules，尤其 h1/h2 下边框、heading margins、代码 padding、quote border、1800px 内容宽度。避免不必要的 `!important`。
5. 不新增字体资产或网络依赖。可以 local 字体声明或字体栈。实际查询 TeXGyreAdventor / Century Gothic / Didact Gothic / Yu Gothic 在本机是否可用，并如实报告降级。不声称字体一比一，除非证据支持。
6. 仅完成这个独立主题文件，不负责加载/菜单/偏好/导出集成。Coordinator 会完成这些。

## 验证与交付

使用本机可用且与本次改动相称的验证方式确认 CSS 可解析、全部选择器按主题限定、同时含实时与导出覆盖、响应式宽度覆盖。可运行一次内联 Node/Python 验证，不要新增测试脚本或临时文件。若工具可用，验证关键 computed styles；不能运行时明确标为未测，不能杜撰。

`GOTHIC-RESULT.md` 简短记录：实现了什么、实际执行的验证及结果、字体可用性、仍有差距及集成边界。最终回复列出这两个文件和验证结果。完成后停止，不追加其他工作。
