import { setTimeout as sleep } from 'node:timers/promises';

const money = value => `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
const localTime = value => new Date(value).toLocaleString('zh-CN', { hour12: false });

function moneyRange(values) {
  if (!values) return '待定价';
  if (Math.abs(values[0] - values[1]) < 0.000001) return money(values[0]);
  return values.map(money).join('～');
}

function windowLabel(minutes) {
  if (minutes === 300) return '5 小时';
  if (minutes === 10080) return '周限额';
  return `${minutes} 分钟`;
}

function duration(ms) {
  if (ms <= 0) return '等待接口更新';
  const minutes = Math.ceil(ms / 60_000);
  return `${Math.floor(minutes / 1440)}天 ${Math.floor(minutes % 1440 / 60)}小时 ${minutes % 60}分`;
}

function renderPeriodEstimate(estimate, usedPercent, details) {
  const lines = [
    `  本周期起点：${localTime(estimate.startsAt)}`,
    `  本周期本机累计：${estimate.totalTokens.toLocaleString('zh-CN')} tokens / ${estimate.requests} 次请求`,
    `  本周期已用 API 等值：${moneyRange(estimate.costUsdRange)}`,
  ];
  for (const model of estimate.models) {
    lines.push(`    ${model.model}：${model.totalTokens.toLocaleString('zh-CN')} tokens / ${model.unpriced ? '待定价' : moneyRange([model.minimumUsd, model.maximumUsd])}`);
    if (details) lines.push(`      非缓存输入 ${model.inputTokens.toLocaleString('zh-CN')} / 缓存读取 ${model.cacheReadTokens.toLocaleString('zh-CN')} / 缓存写入 ${model.cacheCreationTokens.toLocaleString('zh-CN')} / 输出 ${model.outputTokens.toLocaleString('zh-CN')}`);
  }
  if (estimate.unknownSpeed) lines.push(`  ${estimate.unknownSpeed} 次请求未记录速度档位；这部分按普通～Fast 给出金额范围。`);
  if (details) lines.push(`  本机记录来源：${estimate.providers.join('、')}`);
  if (estimate.status === 'period-estimated') {
    lines.push(`  按本周期已用 ${usedPercent}% 推算：满额 ${moneyRange(estimate.totalUsdRange)} / 剩余 ${moneyRange(estimate.remainingUsdRange)}`);
    if (details && estimate.roundingUsdRange) lines.push(`  再计入 ±1 个百分点取整误差：满额 ${moneyRange(estimate.roundingUsdRange)}`);
    return lines;
  }
  const reasons = [];
  if (usedPercent === 0) reasons.push('等待额度已用比例大于 0%');
  if (!estimate.requests) reasons.push('尚无本周期请求记录');
  if (!estimate.historyBound) reasons.push('账号周期历史未完整绑定');
  if (estimate.unpriced) reasons.push('部分请求尚不可定价');
  if (estimate.invalidRecords) reasons.push('用量日志不完整，暂停外推');
  if (estimate.quotaDiscontinuity) reasons.push('本周期额度比例回退或重置券减少，暂停外推');
  if (estimate.creditsChanged) reasons.push('本周期额外 credits 发生变化，暂停外推');
  lines.push(`  满额估算：${reasons.join('；') || '等待有效的本周期用量'}。`);
  return lines;
}

function renderWindow(window, estimate, at, details) {
  const heading = `${window.limitName === 'codex' ? '普通 Codex' : window.limitName} · ${windowLabel(window.windowDurationMins)}`;
  if (Number.isFinite(window.resetsAt) && window.resetsAt * 1000 <= at) {
    return [`${heading}：服务端返回的窗口已到期，当前进度待刷新`, ''];
  }
  if (!details && window.usedPercent === 0 && !estimate?.totalTokens && !estimate?.requests
    && !estimate?.quotaDiscontinuity && !estimate?.creditsChanged && !estimate?.invalidRecords) {
    return [`${heading}：未使用 · 剩余 100%`, ''];
  }
  const remaining = 100 - window.usedPercent;
  const filled = Math.round(remaining / 5);
  const lines = [heading,
    `  [${'█'.repeat(filled)}${'░'.repeat(20 - filled)}] 剩余 ${remaining}% · 已用 ${window.usedPercent}%`,
    window.resetsAt == null ? '  重置时间：接口未返回' : `  重置：${localTime(window.resetsAt * 1000)}（${duration(window.resetsAt * 1000 - at)}）`,
  ];
  if (estimate?.status?.startsWith('period-')) {
    lines.push(...renderPeriodEstimate(estimate, window.usedPercent, details));
  } else if (window.limitId === 'codex') {
    lines.push('  美元估算：当前不可用，等待有效的本周期用量。');
  }
  lines.push('');
  return lines;
}

export function renderSnapshot(snapshot, { details = false, manualRefresh = false } = {}) {
  const { sample, estimates } = snapshot;
  const lines = ['Codex 账号额度监控', `${localTime(sample.at)}  |  ${sample.planType ?? '未知套餐'}  |  账号 ${sample.accountKey?.slice(0, 8) ?? '未识别'}`, ''];
  const core = sample.windows.filter(window => window.limitId === 'codex');
  for (const minutes of [300, 10080]) {
    if (!core.some(window => window.windowDurationMins === minutes)) lines.push(`普通 Codex · ${windowLabel(minutes)}：接口未返回`);
  }
  for (const window of sample.windows) {
    const estimate = estimates[`${window.limitId}:${window.windowDurationMins}`];
    lines.push(...renderWindow(window, estimate, sample.at, details));
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
      if (requested) {
        requested = false;
        return;
      }
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
