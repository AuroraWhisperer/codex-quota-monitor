# 使用指南

[返回项目首页](../README.md)

以下命令均在项目根目录的 PowerShell 中执行。首次安装见[快速开始](../README.md#快速开始)。

## 常用命令

| 场景 | 命令 |
| --- | --- |
| 持续监控 | `npm start` |
| 查询一次并退出 | `npm run snapshot` |
| 查看完整额度与逐模型明细 | `npm run snapshot -- --details` |
| 输出单次 JSON 快照 | `npm run --silent snapshot -- --json` |
| 持续输出 JSON 快照 | `npm run --silent start -- --json` |
| 将刷新间隔设为 120 秒 | `npm start -- --interval 120` |
| 查看命令行帮助 | `npm run snapshot -- --help` |

`--interval` 的单位为秒，允许范围为 **30–3600**，默认 **60**。JSON 模式建议搭配 npm 的 `--silent`，避免 npm 自身的启动提示混入输出。

按 **`1`、`R`（大小写均可）或 `Enter`** 立即刷新，按 **`Ctrl+C`** 退出。快捷键仅在交互式终端的持续监控文本模式下生效。

交互式面板每轮刷新会清除上一轮画面及回滚历史；单次查询和重定向输出保留纯文本。正在采样时连续按刷新键，最多排队一次后续刷新。

## 配置

| 环境变量 | 默认行为 | 用途 |
| --- | --- | --- |
| `CODEX_BIN` | 从 `PATH` 及常见 npm 安装位置查找 | 指定原生 `codex.exe` 的完整路径 |
| `CODEX_HOME` | `%USERPROFILE%\.codex` | 指定 Codex CLI 的账号配置与日志目录 |

例如，自动发现失败时，可以在当前 PowerShell 会话中指定程序路径，再启动监控：

```powershell
$env:CODEX_BIN = 'C:\path\to\codex.exe'
npm start
```

请将示例路径替换为实际路径。`CODEX_BIN` 应指向原生可执行文件；npm 生成的 `codex.cmd` 不是该配置项所需的文件。

每份账本绑定首次使用的 `CODEX_HOME`。已有账本时切换到其他日志目录，程序会停止并提示目录不匹配；需要监控另一个目录时，可使用独立的项目副本保存其账本。

遇到启动或查询问题时，请参阅[常见问题](faq.md)。
