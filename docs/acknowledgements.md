# 致谢

[返回项目首页](../README.md)

感谢以下项目的维护者与贡献者提供的工具、文档和设计参考：

| 项目 | 在本项目中的作用 |
| --- | --- |
| [OpenAI Codex](https://github.com/openai/codex) | 提供 CLI、app-server 账号额度接口和本机会话日志 |
| [ccusage](https://github.com/ccusage/ccusage) · [Codex 文档](https://ccusage.com/guide/codex/) | 早期用量对照工具，以及本地日志解析、逐请求计价的参考 |
| [CodexBar](https://github.com/steipete/CodexBar) | 调研参考：区分账号额度与本机成本、处理多账号和继承历史 |
| [Sub2API](https://github.com/Wei-Shaw/sub2api) | 调研参考：上游额度快照、周期记录，以及用量与计费分层 |
| [xterm.js](https://github.com/xtermjs/xterm.js) | 通过 `@xterm/headless` 验证中文折行、窗口缩放和终端刷新行为 |
| [Node.js](https://nodejs.org/en) | 提供运行时、原生模块和测试工具 |

ccusage、CodexBar 和 Sub2API 在此作为调研与设计参考列出。当前日志解析、周期账本与计价由本仓库实现；实际开发依赖以 [`package.json`](../package.json) 为准。也感谢提出问题、分享使用经验和提交改进的每一位参与者。
