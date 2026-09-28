import { access, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fingerprint = value => createHash('sha256').update(value).digest('hex');

// Bundled reference rates in USD per million tokens (2026-09-15).
// Per-request tier and context adjustments are applied by the ledger.
export const STANDARD_PRICES = {
  'gpt-6-astra': { input: 10, cacheRead: 1, cacheCreation: 12.5, output: 50 },
  'gpt-5.6-sol': { input: 4, cacheRead: 0.4, cacheCreation: 5, output: 20 },
  'gpt-5.6-luna': { input: 0.2, cacheRead: 0.02, cacheCreation: 0.25, output: 1.2 },
};
export const COST_BASIS = `standard-base-2026-09-15:${fingerprint(JSON.stringify(STANDARD_PRICES))}`;

export async function findCodexExecutable() {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error('第一版支持 Windows x64 / arm64。');
  }
  const triple = process.arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
  const suffix = `@openai/codex-win32-${process.arch}/vendor/${triple}/bin/codex.exe`;
  const candidates = process.env.CODEX_BIN ? [process.env.CODEX_BIN] : [];
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(directory, 'codex.exe'),
      path.join(directory, 'node_modules/@openai/codex/node_modules', suffix),
      path.join(directory, 'node_modules', suffix));
  }
  let codex;
  for (const candidate of candidates) {
    try { await access(candidate); codex = candidate; break; } catch { /* Try next installed location. */ }
  }
  if (!codex) throw new Error('找不到 Codex 原生程序；请把 CODEX_BIN 设置为 codex.exe 的完整路径。');
  return codex;
}

/** Normalize quota buckets while preserving absent windows. */
export function normalizeLimits(response) {
  const buckets = response.rateLimitsByLimitId ?? (response.rateLimits
    ? { [response.rateLimits.limitId ?? 'codex']: response.rateLimits } : {});
  return Object.entries(buckets).flatMap(([limitId, bucket]) =>
    [bucket?.primary, bucket?.secondary]
      .filter(value => value && Number.isFinite(value.usedPercent)
        && value.usedPercent >= 0 && value.usedPercent <= 100
        && Number.isFinite(value.windowDurationMins) && value.windowDurationMins > 0)
      .map(value => ({
        limitId, limitName: bucket.limitName ?? limitId,
        usedPercent: value.usedPercent,
        remainingPercent: 100 - value.usedPercent,
        windowDurationMins: value.windowDurationMins,
        resetsAt: Number.isFinite(value.resetsAt) ? value.resetsAt : null,
      })));
}

export async function readLocalContext(codexHome) {
  let accountKey = null;
  try {
    const auth = JSON.parse(await readFile(path.join(codexHome, 'auth.json'), 'utf8'));
    if (typeof auth.tokens?.account_id === 'string' && auth.tokens.account_id) {
      accountKey = fingerprint(auth.tokens.account_id);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取本机账号标识；本轮停止估算。'); }
  let config = '';
  try { config = await readFile(path.join(codexHome, 'config.toml'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { accountKey, configKey: fingerprint(config) };
}

/** Query account details and quota windows through the CLI. */
export async function readAccountQuota(executable, codexHome, signal) {
  const child = spawn(executable, ['app-server'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: codexHome }, signal,
  });
  child.stderr.resume();
  const reader = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 0;
  let failure = null;
  const rejectPending = error => {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on('error', () => rejectPending(new Error('无法启动 Codex 额度查询进程。')));
  child.on('exit', () => rejectPending(new Error('Codex 额度查询进程已退出。')));
  child.stdin.on('error', () => rejectPending(new Error('Codex 查询连接中断。')));
  reader.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id != null) {
      child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Read-only client' } })}\n`);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`Codex ${request.method} 查询失败（${message.error.code}），请检查登录状态。`));
    else request.resolve(message.result);
  });
  async function request(method, params) {
    if (failure) throw failure;
    let timer;
    const id = ++nextId;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex 额度查询超时。')); }, 20_000);
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    } finally { clearTimeout(timer); }
  }
  try {
    await request('initialize', { clientInfo: { name: 'codex_quota_monitor', version: '0.1.0' } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    const { account } = await request('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt') throw new Error('当前 Codex CLI 未使用 ChatGPT 订阅登录。');
    const quota = await request('account/rateLimits/read');
    // Do not carry email, raw account ids or reset-credit ids into persisted data.
    return { planType: account.planType ?? null, quota };
  } finally {
    reader.close();
    child.stdin.end();
    child.kill();
  }
}
