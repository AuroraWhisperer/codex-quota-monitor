import { LEDGER_PRICE_BASIS } from './usage-pricing.mjs';
import { periodStart } from './quota-ledger.mjs';
import { readRequestLogs } from './usage-logs.mjs';
import { normalizeLimits, readLocalContext, readAccountQuota } from './quota-sources.mjs';

function createScanProgress(onProgress) {
  const startedAt = Date.now();
  let lastProgress = 0;
  let lastPhase = null;
  return ({ phase, completed, total }) => {
    const now = Date.now();
    if (phase === lastPhase && now - lastProgress < 250 && completed !== total) return;
    lastProgress = now;
    lastPhase = phase;
    const action = phase === 'filter' ? '筛选本周期日志' : '统计本周期日志';
    onProgress(`正在${action}：${completed} / ${total}（${Math.floor((now - startedAt) / 1000)} 秒） Ctrl+C 停止。`);
  };
}

export async function collectSnapshot(executable, codexHome, signal, onProgress) {
  const errors = [];
  async function readContext() {
    try { return await readLocalContext(codexHome); }
    catch (error) { errors.push(error.message); return null; }
  }
  const before = await readContext();
  let account = null;
  onProgress('正在查询 Codex 官方额度… Ctrl+C 停止。');
  try { account = await readAccountQuota(executable, codexHome, signal); }
  catch (error) { errors.push(error.message); }
  signal.throwIfAborted();
  const quota = account?.quota ?? {};
  const windows = normalizeLimits(quota);
  const starts = windows.filter(window => Number.isFinite(window.resetsAt) && window.resetsAt * 1000 > Date.now()).map(periodStart);
  let scanned = { requests: [], invalidRecords: 0 };
  if (starts.length) {
    onProgress('正在读取历史日志列表… Ctrl+C 停止。');
    const scanProgress = createScanProgress(onProgress);
    try {
      scanned = await readRequestLogs(codexHome, Math.min(...starts), {
        signal,
        onProgress: scanProgress,
      });
    } catch {
      signal.throwIfAborted();
      errors.push('本轮请求日志读取失败，已保存用量仍保留，暂停满额推算。');
      scanned.invalidRecords = 1;
    }
  }
  const after = await readContext();
  const stable = before && after && before.accountKey === after.accountKey && before.configKey === after.configKey;
  if (!stable) errors.push('采样期间账号或配置发生变化，校准已重新开始。');
  if (!before?.accountKey) errors.push('未取得可核对的本地账号标识；仅显示额度，不做美元估算。');
  const core = quota.rateLimitsByLimitId != null ? quota.rateLimitsByLimitId.codex : quota.rateLimits;
  return { scanned, sample: {
    at: Date.now(), accountKey: stable ? before.accountKey : null,
    priceBasis: LEDGER_PRICE_BASIS,
    planType: account?.planType ?? null,
    windows: stable ? windows : [],
    credits: core?.credits?.balance ?? null,
    resetCredits: quota.rateLimitResetCredits?.availableCount ?? null,
    cost: null, errors,
  } };
}
