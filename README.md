<div align="center">

# Codex Quota Monitor

**在终端里查看 Codex 剩余额度、重置时间和本机用量。**

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022-43853D?style=flat-square)](https://nodejs.org/en)
![Windows](https://img.shields.io/badge/Windows-x64%20%7C%20ARM64-0078D4?style=flat-square)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

[快速开始](#快速开始) · [文档导航](#文档导航) · [常见问题](docs/faq.md) · [参与贡献](docs/development.md)

</div>

Codex Quota Monitor 是一个在 Windows 终端里运行的小工具，用来查看 Codex 还剩多少额度、什么时候重置，以及当前周期在这台电脑上用了多少 Token。使用前需要先登录 Codex CLI。

界面为中文，可以保持运行、自动刷新，也可以只查一次，或输出 JSON 供脚本使用。

> 这是一个非官方项目，与 OpenAI 无隶属关系。额度数据来自 Codex 接口。界面中的美元金额是根据本机用量、参照 API 价格估算的，不是实际花费，也不是账户余额。

## 功能概览

- **查看额度**：显示各额度周期还剩多少、何时重置，以及距离重置还有多久。
- **统计用量**：统计当前账号在本周期内的本机请求数、Token 用量和估算金额，也可以按模型查看明细。
- **自动刷新**：默认每 60 秒更新一次，也可以按快捷键立即刷新。
- **保存记录**：在本地保存查询结果和用量记录，避免重复计算同一条请求，并分别记录不同账号、不同周期的用量。

## 快速开始

运行前，请确认：

- 系统为 **Windows x64 或 ARM64**。
- 已安装 **[Node.js](https://nodejs.org/en) 22 或更高版本（含 npm）**。
- 已安装 Codex CLI，并使用 **ChatGPT 订阅账号登录**。如果还没安装或登录，请参考[官方说明](https://github.com/openai/codex#quickstart)。只配置 API Key 无法查询订阅额度。

如果已安装 Git，在 PowerShell 中运行：

```powershell
git clone https://github.com/AuroraWhisperer/codex-quota-monitor.git
cd codex-quota-monitor
npm ci
npm start
```

没有 Git 也可以从 GitHub 下载并解压源码，在项目文件夹中打开 PowerShell，再运行上面的 `npm ci` 和 `npm start`。

启动后，程序会先查询额度，并读取本机日志来统计用量，然后显示监控面板。按 **`Ctrl+C`** 退出。以后也可以直接双击 [`start-monitor.cmd`](start-monitor.cmd) 启动。

只查一次、输出 JSON、手动刷新或修改配置的方法，见[使用指南](docs/usage.md)。

## 重要说明

- **用量统计只涵盖本机日志**：其他设备上的用量统计不到，缺失的日志也无法补全。程序第一次识别某个账号时，无法确认更早的日志属于谁，因此不会把这些记录算到该账号名下。
- **首次运行时可能看不到满额和剩余额度的估算金额**：程序需要有从当前周期开始以来的账号记录，并满足其他估算条件，才能显示这些金额。具体计算方法见[工作原理](docs/how-it-works.md)。
- **数据保存在项目文件夹的 `data/` 中**：程序会保存查询结果和用量记录，不会保存对话正文或登录凭据。查询额度时，仍需要通过本机 Codex CLI 连接服务。详见[数据与隐私](docs/data-and-privacy.md)。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [使用指南](docs/usage.md) | 常用命令、JSON 输出、刷新快捷键和环境变量 |
| [工作原理](docs/how-it-works.md) | 数据从哪里来，如何区分账号和周期，金额怎么算 |
| [数据与隐私](docs/data-and-privacy.md) | 会保存哪些数据，保存在哪里 |
| [常见问题](docs/faq.md) | 找不到 Codex、查询失败、没有估算金额等问题的处理方法 |
| [开发与贡献](docs/development.md) | 如何反馈问题、运行测试，以及各模块的用途 |
| [致谢](docs/acknowledgements.md) | 用到的工具和参考过的项目 |

## 参与贡献

遇到问题或有改进建议，欢迎提 [Issue](https://github.com/AuroraWhisperer/codex-quota-monitor/issues)，也欢迎提交 Pull Request。[开发与贡献](docs/development.md)中列出了反馈问题时需要提供的信息，以及提交代码前的测试步骤。

## 开源协议

本项目采用 [MIT License](LICENSE)，版权归 AuroraWhisperer 及项目贡献者所有。

你可以使用、修改和分发本项目，也可以用于商业用途。分发时需保留版权和许可声明，软件不提供任何担保。完整条款见 [`LICENSE`](LICENSE)。第三方代码、名称和商标的使用仍需遵守各自的许可和相关声明。
