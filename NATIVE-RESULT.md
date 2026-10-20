# 原生实现与验证

Coordinator 实现了 native/App.swift。Grok 的开发轮次仅完成逆向，随后参与短审查。

早期隔离原生测试通过：UTF-8/UTF-16、中文和 CRLF 的打开保存；真实关闭按钮触发保存提示，Cancel 保留文档且不改磁盘。对应证据位于 evidence/native-*.json。

之后已修复编码检测、恢复文件生命周期、同路径窗口复用、参数化 JS 桥接、保存快照，以及完整 HTML 打印路径。最新 Swift 编译和签名通过。这些后续改动尚未完成原生端到端复测。

对 Grok 审查的处理：
- 外部 BOM 更新、恢复备份过早删除、过期恢复数据：已修复。
- 菜单旧路由在 renderer 的 format 分发中可工作；现将非格式命令显式转发。
- 不依赖审查对 U+2028/U+2029 的旧语法推断；桥接改为 callAsyncJavaScript 参数传值。
- PDF 增加 provisional navigation 错误处理；打印使用完整独立 HTML。实际 PDF/打印仍待验证。

当前生产 WebKit 测试在隔离环境中出现内容进程终止。浏览器控制的自动权限审查也连续超时。不能声明安装版运行通过或完整 1:1 已完成。
