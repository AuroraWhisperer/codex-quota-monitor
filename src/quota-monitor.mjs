import { mkdir, readFile, writeFile, appendFile, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { LEDGER_PRICE_BASIS, loadLedger, saveLedger, updateLedger, periodStart, readRequestLogs } from './quota-ledger.mjs';
import { findCodexExecutable, fingerprint, projectDir, normalizeLimits, readLocalContext, readAccountQuota } from './quota-sources.mjs';

const money = value => `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
const moneyRange = values => !values ? '待定价' : Math.abs(values[0] - values[1]) < 0.000001 ? money(values[0]) : values.map(money).join('～');
const label = minutes => minutes === 300 ? '5 小时' : minutes === 10080 ? '周限额' : `${minutes} 分钟`;
const localTime = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
function duration(ms) {
  if (ms <= 0) return '等待接口更新';
  const minutes = Math.ceil(ms / 60_000);
  return `${Math.floor(minutes / 1440)}天 ${Math.floor(minutes % 1440 / 60)}小时 ${minutes % 60}分`;
}

export function renderSnapshot(snapshot, { details = false, manualRefresh = false } = {}) {
  const { sample, estimates } = snapshot;
  const lines = ['Codex 账号额度监控', `${localTime(sample.at)}  |  ${sample.planType ?? '未知套餐'}  |  账号 ${sample.accountKey?.slice(0, 8) ?? '未识别'}`, ''];
  const core = sample.windows.filter(value => value.limitId === 'codex');
  for (const minutes of [300, 10080]) {
    if (!core.some(value => value.windowDurationMins === minutes)) lines.push(`普通 Codex · ${label(minutes)}：接口未返回`);
  }
  for (const value of sample.windows) {
    const heading = `${value.limitName === 'codex' ? '普通 Codex' : value.limitName} · ${label(value.windowDurationMins)}`;
    if (Number.isFinite(value.resetsAt) && value.resetsAt * 1000 <= sample.at) {
      lines.push(`${heading}：服务端返回的窗口已到期，当前进度待刷新`, '');
      continue;
    }
    const estimate = estimates[`${value.limitId}:${value.windowDurationMins}`];
    if (!details && value.usedPercent === 0 && !estimate?.totalTokens && !estimate?.requests
      && !estimate?.quotaDiscontinuity && !estimate?.creditsChanged && !estimate?.invalidRecords) {
      lines.push(`${heading}：未使用 · 剩余 100%`, '');
      continue;
    }
    const remaining = 100 - value.usedPercent;
    const filled = Math.round(remaining / 5);
    lines.push(heading,
      `  [${'█'.repeat(filled)}${'░'.repeat(20 - filled)}] 剩余 ${remaining}% · 已用 ${value.usedPercent}%`,
      value.resetsAt == null ? '  重置时间：接口未返回' : `  重置：${localTime(value.resetsAt * 1000)}（${duration(value.resetsAt * 1000 - sample.at)}）`);
    if (estimate?.status?.startsWith('period-')) {
      lines.push(`  本周期起点：${localTime(estimate.startsAt)}`,
        `  本周期本机累计：${estimate.totalTokens.toLocaleString('zh-CN')} tokens / ${estimate.requests} 次请求`,
        `  本周期已用 API 等值：${moneyRange(estimate.costUsdRange)}`);
      for (const model of estimate.models) {
        lines.push(`    ${model.model}：${model.totalTokens.toLocaleString('zh-CN')} tokens / ${model.unpriced ? '待定价' : moneyRange([model.minimumUsd, model.maximumUsd])}`);
        if (details) lines.push(`      非缓存输入 ${model.inputTokens.toLocaleString('zh-CN')} / 缓存读取 ${model.cacheReadTokens.toLocaleString('zh-CN')} / 缓存写入 ${model.cacheCreationTokens.toLocaleString('zh-CN')} / 输出 ${model.outputTokens.toLocaleString('zh-CN')}`);
      }
      if (estimate.unknownSpeed) lines.push(`  ${estimate.unknownSpeed} 次请求未记录速度档位；这部分按普通～Fast 给出金额范围。`);
      if (details) lines.push(`  本机记录来源：${estimate.providers.join('、')}`);
      if (estimate.status === 'period-estimated') {
        lines.push(`  按本周期已用 ${value.usedPercent}% 推算：满额 ${moneyRange(estimate.totalUsdRange)} / 剩余 ${moneyRange(estimate.remainingUsdRange)}`);
        if (details && estimate.roundingUsdRange) lines.push(`  再计入 ±1 个百分点取整误差：满额 ${moneyRange(estimate.roundingUsdRange)}`);
      } else {
        const reasons = [];
        if (value.usedPercent === 0) reasons.push('等待额度已用比例大于 0%');
        if (!estimate.requests) reasons.push('尚无本周期请求记录');
        if (!estimate.historyBound) reasons.push('账号周期历史未完整绑定');
        if (estimate.unpriced) reasons.push('部分请求尚不可定价');
        if (estimate.invalidRecords) reasons.push('用量日志不完整，暂停外推');
        if (estimate.quotaDiscontinuity) reasons.push('本周期额度比例回退或重置券减少，暂停外推');
        if (estimate.creditsChanged) reasons.push('本周期额外 credits 发生变化，暂停外推');
        lines.push(`  满额估算：${reasons.join('；') || '等待有效的本周期用量'}。`);
      }
    } else if (value.limitId === 'codex') {
      lines.push('  美元估算：当前不可用，等待有效的本周期用量。');
    }
    lines.push('');
  }
  if (sample.credits != null) lines.push(`额外 credits（独立于周限／5h）：${sample.credits} credits`);
  if (sample.resetCredits != null) lines.push(`可用重置券：${sample.resetCredits} 张`);
  lines.push(...sample.errors.map(error => `提示：${error}`), '',
    '按逐请求模型定价，计入已记录的 Fast 和长上下文附加费；美元为 API 等值，非实际账单。',
    '满额外推假设本机日志覆盖账号本周期用量；其他设备、日志缺失和上报延迟会影响结果。',
    `credits 独立于订阅额度。--details 查看完整明细。${manualRefresh ? '按 1 / R / 回车立即刷新。' : ''}Ctrl+C 停止。`);
  return lines.join('\n');
}

export function writeSnapshot(snapshot, { watch = false, json = false, details = false, manualRefresh = false } = {}, output = process.stdout) {
  // Long reports scroll above the viewport; clear that history too before redrawing.
  const clear = watch && !json && output.isTTY ? '\x1b[2J\x1b[3J\x1b[H' : '';
  output.write(`${clear}${json ? JSON.stringify(snapshot) : renderSnapshot(snapshot, { details, manualRefresh })}\n`);
}

export function writeProgress(message, { watch = false, json = false } = {}, output = process.stdout) {
  if (watch && !json && output.isTTY) output.write(`\r\x1b[2K${message}`);
}

/** Wake the serial collection loop on input, retaining at most one pending refresh. */
export function createRefreshControl({ watch = false, json = false }, controller, input = process.stdin, output = process.stdout) {
  const enabled = Boolean(watch && !json && input.isTTY && output.isTTY);
  const wasRaw = Boolean(input.isRaw);
  let requested = false;
  let waiting = null;
  const onData = chunk => {
    const keys = chunk.toString();
    if (keys.includes('\x03')) controller.abort();
    else if (/^[1rR\r\n]+$/.test(keys)) {
      requested = true;
      waiting?.abort();
    }
  };
  if (enabled) {
    input.setRawMode(true);
    input.on('data', onData);
    input.resume();
  }
  return {
    enabled,
    async wait(ms) {
      controller.signal.throwIfAborted();
      if (requested) { requested = false; return; }
      waiting = new AbortController();
      try {
        await sleep(ms, undefined, { signal: AbortSignal.any([controller.signal, waiting.signal]) });
      } catch (error) {
        if (!requested || controller.signal.aborted) throw error;
      } finally {
        requested = false;
        waiting = null;
      }
    },
    close() {
      if (!enabled) return;
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
    },
  };
}

async function acquireLock(directory) {
  const lockPath = path.join(directory, 'monitor.lock');
  try {
    const lock = await open(lockPath, 'wx');
    await lock.writeFile(String(process.pid));
    await lock.close();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(lockPath, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('监控锁文件无效，请检查 data/monitor.lock。');
    try { process.kill(pid, 0); }
    catch (checkError) {
      if (checkError.code !== 'ESRCH') throw new Error('另一监控进程仍在运行。');
      await unlink(lockPath);
      return acquireLock(directory);
    }
    throw new Error('已有监控进程运行，避免同时写入采样记录。');
  }
  return async () => { await unlink(lockPath); };
}

async function collect(executable, codexHome, signal, onProgress) {
  const errors = [];
  async function context() {
    try { return await readLocalContext(codexHome); }
    catch (error) { errors.push(error.message); return null; }
  }
  const before = await context();
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
    const scanStarted = Date.now();
    let lastProgress = 0;
    let lastPhase = null;
    try {
      scanned = await readRequestLogs(codexHome, Math.min(...starts), {
        signal,
        onProgress: ({ phase, completed, total }) => {
          const now = Date.now();
          if (phase === lastPhase && now - lastProgress < 250 && completed !== total) return;
          lastProgress = now;
          lastPhase = phase;
          const action = phase === 'filter' ? '筛选本周期日志' : '统计本周期日志';
          onProgress(`正在${action}：${completed} / ${total}（${Math.floor((now - scanStarted) / 1000)} 秒） Ctrl+C 停止。`);
        },
      });
    } catch {
      signal.throwIfAborted();
      errors.push('本轮请求日志读取失败，已保存用量仍保留，暂停满额推算。'); scanned.invalidRecords = 1;
    }
  }
  const after = await context();
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

async function main() {
  const { values } = parseArgs({ options: {
    watch: { type: 'boolean' }, json: { type: 'boolean' }, details: { type: 'boolean' }, help: { type: 'boolean' }, interval: { type: 'string', default: '60' },
  } });
  if (values.help) {
    console.log('node src/quota-monitor.mjs [--watch] [--json] [--details] [--interval 60]\n单次查询默认退出；--watch 持续刷新；--json 输出 JSON；--details 显示全部额度详情及本周期逐模型 token 分类。\n交互式 --watch 文本模式：按 1 / R / 回车立即刷新，Ctrl+C 停止。');
    return;
  }
  const interval = Number(values.interval);
  if (!Number.isFinite(interval) || interval < 30 || interval > 3600) throw new Error('--interval 必须在 30～3600 秒之间。');
  const progress = message => writeProgress(message, values);
  progress('正在启动 Codex 账号额度监控…');
  const codexHome = path.resolve(process.env.CODEX_HOME ?? path.join(homedir(), '.codex'));
  const executable = await findCodexExecutable();
  const dataDir = path.join(projectDir, 'data');
  await mkdir(dataDir, { recursive: true });
  const unlock = await acquireLock(dataDir);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let refresh;
  try {
    refresh = createRefreshControl(values, controller);
    progress('正在加载本地账本… Ctrl+C 停止。');
    let saved = await loadLedger(path.join(dataDir, 'ledger.json'));
    const homeKey = fingerprint(codexHome);
    if (saved.homeKey && saved.homeKey !== homeKey) throw new Error('当前 CODEX_HOME 与已绑定账本不同，请使用原日志目录。');
    saved.homeKey = homeKey;
    do {
      const startedAt = Date.now();
      const { sample, scanned } = await collect(executable, codexHome, controller.signal, progress);
      if (controller.signal.aborted) break;
      progress('正在汇总并保存本轮结果…');
      const result = updateLedger(saved, sample, scanned);
      saved = result.state;
      const snapshot = { sample, estimates: result.estimates };
      await appendFile(path.join(dataDir, 'samples.jsonl'), `${JSON.stringify(snapshot)}\n`);
      await saveLedger(path.join(dataDir, 'ledger.json'), saved);
      await writeFile(path.join(dataDir, 'latest.json'), JSON.stringify(snapshot, null, 2));
      writeSnapshot(snapshot, { ...values, manualRefresh: refresh.enabled });
      if (!values.watch) { if (sample.errors.length) process.exitCode = 1; break; }
      await refresh.wait(Math.max(1000, interval * 1000 - (Date.now() - startedAt)));
    } while (!controller.signal.aborted);
  } catch (error) { if (!controller.signal.aborted) throw error; }
  finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (values.watch && !values.json && process.stdout.isTTY) process.stdout.write('\n');
    try { refresh?.close(); }
    finally { await unlock(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
