# Gothic 字体来源与许可

这些字体是独立的开放字体资产。字体文件未修改。它们不包含 Typora 程序代码。

直接来源：本机 Typora 1.14.10 的 `Contents/Resources/TypeMark/style/themes/gothic/`。复制日期：2026-10-19。`FONT-METADATA.json` 保存每个字体的 name 表和 SHA-256。六个目标文件的 SHA-256 均与直接来源相同。

## TeX Gyre Adventor

文件：`texgyreadventor-regular.woff`、`texgyreadventor-bold.woff`、`texgyreadventor-italic.woff`、`texgyreadventor-bolditalic.woff`。版本：1.104。

name 表版权声明：

> Copyright (URW)++, copyright 1999 by (URW)++ Design & Development; Cyrillic glyphs added by Valek Filippov, copyright 2001-2002; Vietnamese characters were added by Han The Thanh; copyright 2006, 2008 for TeX Gyre extensions by B. Jackowski and J.M. Nowacki (on behalf of TeX users groups). This work is released under the GUST Font License -- see http://tug.org/fonts/licenses/GUST-FONT-LICENSE.txt for details.

随原包附带的许可完整保存在 `GUST-FONT-LICENSE.txt`。它允许按 LPPL 1.3c 或更新版本分发或修改。LPPL 全文保存在 `LPPL-1.3c.txt`。本项目保持字体文件和字体名称不变。

- [GUST 官方字体项目和公开源包](https://www.gust.org.pl/projects/e-foundry/tex-gyre/adventor)
- [GUST 官方字体许可页面](https://www.gust.org.pl/projects/e-foundry/licenses)
- [LaTeX 官方 LPPL 1.3c 全文](https://www.latex-project.org/lppl.txt)

## Didact Gothic

文件：`didact-gothic-c.woff2`、`didact-gothic-c-ext.woff2`。版本：2.101。它们提供原 Gothic 主题指定的西里尔字符子集。

name 表版权声明：

> Copyright 2016 The Didact Gothic Project Authors (il.basso.buffo@gmail.com)

name 表 license URL 为 `http://scripts.sil.org/OFL`。Google Fonts 官方仓库确认该字体使用 SIL Open Font License 1.1。完整许可证保存在 `DIDACT-OFL-1.1.txt`。该文件还保留上游版权声明。上述 2016 年声明与字体 name 表中的声明一同保留。本项目未修改、重命名或单独销售字体。

- [Didact Gothic 作者项目和源文件](https://github.com/ossobuffo/didact-gothic)
- [Google Fonts 官方 OFL 许可证](https://raw.githubusercontent.com/google/fonts/main/ofl/didactgothic/OFL.txt)

## 使用与导出

`src/themes/gothic.css` 使用相对 URL 引用这六个字体，并保留原主题的 unicode-range。编辑器构建工具需要处理这些 URL。独立 HTML 导出需要把 URL 改为内嵌 data URI，或连同字体目录一起导出。许可证与来源文件应随字体一起保留。
