# 原生菜单简体中文本地化

已新增 `native/Localization.swift`。入口为 `localizedMenuTitle(_ english: String) -> String`。未修改 `App.swift`。

函数检查 `Locale.preferredLanguages` 的首选语言。`zh-Hans`、`zh-CN`、`zh-SG` 及包含这些语言标记的地区变体使用简体中文。显式 `Hant` 与其他语言返回原英文。未知标签也原样返回。函数保留命令的省略号，并统一为 `…`。

字典覆盖当前 `buildMenu()` 的全部 90 个不同标题，包含动态生成的 `Heading 1` 至 `Heading 6`、应用名相关项目、最近文件菜单与五个主题名。应用名与主题名保留专名。最近文件列表中的真实文件名不属于翻译对象。

来源：只读检查本工程 `native/App.swift` 的菜单创建代码，以及本机 Typora 的 `/Applications/Typora.app/Contents/Resources/zh-Hans.lproj/Menu.strings`。菜单用词沿用参考资源；工程特有的 `Settings`、导出命令、`Enter Full Screen`、`Files` 与 `Markdown Reference` 按同一术语风格补齐。未复制原应用实现。

验证：

- `swiftc -typecheck -module-cache-path .cache/swift native/Localization.swift` 通过。
- 静态提取当前菜单标题，覆盖检查为 90/90。
- 独立 Swift 可执行程序通过 `-AppleLanguages` 验证 `zh-Hans`、`zh-CN`、`zh-SG`、`zh-Hans-US` 均输出中文。
- 同一程序验证 `zh-Hant` 与 `en-US` 返回英文，并验证标题、省略号及主题专名。
- 验证用临时程序已删除。未构建整个应用，也未宣称已完成菜单 UI 验证。

集成位置：菜单 builder 的 `menu`、`item`、`role` 辅助函数，以及 `Services`、`Open Recent` 和 `menuNeedsUpdate()` 内 `Clear Menu` 的直接创建路径。Root 负责集成。
