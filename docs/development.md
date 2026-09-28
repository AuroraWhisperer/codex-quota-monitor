# 开发与贡献

[返回项目首页](../README.md)

## 参与贡献

欢迎通过 [Issues](https://github.com/AuroraWhisperer/codex-quota-monitor/issues) 反馈问题、提出建议，或提交 Pull Request。

- **反馈问题**：提供 Windows 架构、Node.js 与 Codex CLI 版本、运行命令、复现步骤及脱敏后的错误信息。
- **修复与功能**：围绕一个明确问题提交改动，并为日志解析、计价或周期归属的行为变化补充回归测试。
- **文档改进**：欢迎修正示例、补充排障经验与完善说明。

提交代码前运行：

```powershell
npm test
```

测试使用 Node.js 内置测试运行器和本地构造的数据，覆盖日志去重、账号隔离、周期边界、定价、持久化及终端刷新等行为，无需使用真实账号凭据。

## 项目结构

项目采用 Node.js 原生 ES Modules。运行代码使用内置模块，`@xterm/headless` 用于开发测试中的终端行为验证。

| 路径 | 职责 |
| --- | --- |
| [`src/quota-monitor.mjs`](../src/quota-monitor.mjs) | 命令行入口、进程锁、持久化调度与刷新循环 |
| [`src/quota-terminal.mjs`](../src/quota-terminal.mjs) | 报告格式、终端输出与按键刷新 |
| [`src/quota-collector.mjs`](../src/quota-collector.mjs) | 单轮采样、账号一致性检查与日志扫描进度 |
| [`src/quota-sources.mjs`](../src/quota-sources.mjs) | Codex 程序发现、账号上下文与额度查询 |
| [`src/quota-ledger.mjs`](../src/quota-ledger.mjs) | 账号历史绑定、周期汇总、估算与账本存储 |
| [`src/usage-logs.mjs`](../src/usage-logs.mjs) | 会话发现、日志解析、扫描缓存与请求去重 |
| [`src/usage-pricing.mjs`](../src/usage-pricing.mjs) | 模型参考价格、速度档位与长上下文调整 |
| [`src/fingerprint.mjs`](../src/fingerprint.mjs) | 本地标识与价格版本的共享哈希工具 |
| [`tests/`](../tests/) | 日志、额度、账本及终端交互的回归测试 |
| [`start-monitor.cmd`](../start-monitor.cmd) | Windows 双击启动入口 |

原有 monitor、ledger 和 sources 模块继续重导出已有公共辅助函数，保留现有导入路径。
