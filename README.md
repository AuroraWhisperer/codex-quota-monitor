# Codex Quota Monitor

A local terminal dashboard for Codex quota windows, reset times, and recorded usage. It queries the signed-in CLI and keeps a local usage ledger.

## Requirements

- Windows x64 or ARM64
- Node.js 22 or later
- Codex CLI signed in with a ChatGPT subscription

## Quick start

```sh
npm ci
npm start
```

You can also double-click `start-monitor.cmd`. The dashboard refreshes every 60 seconds. Press **1**, **R**, or **Enter** to refresh, and **Ctrl+C** to stop. The terminal display is currently in Chinese.

```sh
npm run snapshot                 # One report
npm run snapshot -- --details    # Per-model usage and estimate details
npm run --silent snapshot -- --json # JSON output
npm start -- --interval 120      # Refresh every 120 seconds
npm test
```

## Configuration and data

- `CODEX_BIN`: path to the native `codex.exe` if automatic discovery fails.
- `CODEX_HOME`: CLI data directory; defaults to `%USERPROFILE%\.codex`. Each ledger is tied to this directory.
- `--interval`: refresh interval in seconds, from 30 to 3600.

Local state is stored in `data/`. Account and request identifiers are hashed. Local data, dependencies, and archived development material in `tmp/` are excluded from Git.

Tracking for a newly observed account starts at its first observation. Full-period estimates require local history covering the current quota window. USD values use bundled reference prices and represent approximate API equivalents, not charges. Missing logs, usage on other devices, and reporting delays can affect estimates.

## Source layout

| File | Purpose |
| --- | --- |
| `src/quota-monitor.mjs` | CLI, terminal display, and refresh loop |
| `src/quota-ledger.mjs` | Log parsing, deduplication, pricing, and period totals |
| `src/quota-sources.mjs` | CLI discovery, account context, and quota queries |
| `tests/` | Regression tests and terminal checks |
