<div align="center">

# Codex Quota Monitor

**在终端里看清 Codex 额度、重置时间与本机用量。**

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022-43853D?style=flat-square)](https://nodejs.org/en)
![Windows](https://img.shields.io/badge/Windows-x64%20%7C%20ARM64-0078D4?style=flat-square)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

[快速开始](#快速开始) · [文档导航](#文档导航) · [常见问题](docs/faq.md) · [参与贡献](docs/development.md)

</div>

Codex Quota Monitor 是一个面向 Windows 的本地终端工具。它通过已登录的 Codex CLI 查询账号额度，结合本机会话日志，按**当前账号、当前额度周期**汇总请求、Token 和 API 等值金额。

适合希望随时查看「还剩多少额度、什么时候重置、这个周期用了多少」的 Codex 用户。终端界面为中文，支持持续监控、单次查询和 JSON 输出。

> 社区独立项目，与 OpenAI 无隶属关系。额度百分比来自 Codex 接口；美元金额是根据本机日志计算的 API 等值估算，不代表实际账单或可用现金余额。

## 功能概览

- **查看额度**：展示各额度窗口的剩余比例、重置时间和倒计时。
- **汇总用量**：按当前账号与额度周期统计本机请求、Token 和 API 等值金额。
- **持续监控**：自动刷新终端面板，支持单次查询、逐模型明细和 JSON 输出。
- **本地记账**：保存采样与周期账本，处理重复日志、账号切换和周期重置。

## 快速开始

需要 **Windows x64 或 ARM64**、**[Node.js](https://nodejs.org/en) 22+（含 npm）**，以及已使用 **ChatGPT 订阅账号登录**的 Codex CLI。尚未配置 CLI 时，请先按[官方项目说明](https://github.com/openai/codex#quickstart)完成安装与登录；仅使用 API Key 登录不适用于订阅额度查询。

安装 Git 后，在 PowerShell 中执行（也可从 GitHub 下载并解压源码）：

```powershell
git clone https://github.com/AuroraWhisperer/codex-quota-monitor.git
cd codex-quota-monitor
npm ci
npm start
```

启动后会显示查询与统计进度，随后进入每 60 秒自动刷新的监控面板。按 **`Ctrl+C`** 退出；完成安装后也可双击 [`start-monitor.cmd`](start-monitor.cmd) 启动。

单次查询、JSON 输出、刷新快捷键与环境变量配置见[使用指南](docs/usage.md)。

## 重要说明

- **统计范围是本机**：其他设备的用量和缺失日志无法完整还原；首次观测前的历史不会自动归入当前账号。
- **金额是估算**：API 等值不代表实际账单；满额与剩余等值需要满足历史完整性等条件，首次启动可能无法显示。详见[统计与估算口径](docs/how-it-works.md)。
- **记录保存在本地**：运行数据写入项目的 `data/`，不保存对话正文或凭据；额度查询通过本机 Codex CLI 连接其服务。详见[数据与隐私](docs/data-and-privacy.md)。

## 文档导航

| 文档 | 适合查阅的内容 |
| --- | --- |
| [使用指南](docs/usage.md) | 常用命令、JSON 输出、刷新交互与环境变量配置 |
| [工作原理](docs/how-it-works.md) | 数据流程、账号与周期归属、计价和外推条件 |
| [数据与隐私](docs/data-and-privacy.md) | 本地文件、保存内容与隐私边界 |
| [常见问题](docs/faq.md) | 程序发现、额度查询、金额缺失、切号与进程锁排查 |
| [开发与贡献](docs/development.md) | 问题反馈、测试命令、项目结构与模块职责 |
| [致谢](docs/acknowledgements.md) | 依赖工具、调研与设计参考项目 |

## 参与贡献

欢迎通过 [Issues](https://github.com/AuroraWhisperer/codex-quota-monitor/issues) 反馈问题、提出建议，或提交 Pull Request。反馈所需信息与提交前检查见[开发与贡献](docs/development.md)。

## 开源协议

本项目采用 [MIT License](LICENSE)，版权归 AuroraWhisperer 及项目贡献者所有。

你可以使用、修改、分发和用于商业用途，分发时须保留版权与许可声明；软件按原样提供，不附带担保。完整条款以 [`LICENSE`](LICENSE) 为准。第三方项目的代码、名称与商标仍遵循各自的许可证和权利声明。
