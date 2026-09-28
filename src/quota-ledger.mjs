import { readFile, writeFile, rename } from 'node:fs/promises';
import { LEDGER_PRICE_BASIS, priceRequest } from './usage-pricing.mjs';
import { mergeRequests } from './usage-logs.mjs';

export { LEDGER_PRICE_BASIS, priceRequest } from './usage-pricing.mjs';
export { parseUsageLines, mergeRequests, readRequestLogs } from './usage-logs.mjs';

const normalizeCredits = value => value == null ? null : String(value).trim().replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
export const periodKey = window => `${window.limitId}:${window.windowDurationMins}:${window.resetsAt}`;
export const periodStart = window => (window.resetsAt - window.windowDurationMins * 60) * 1000;
const requestLimitId = request => /spark/i.test(request.model ?? '') ? 'codex_bengalfox' : 'codex';

export async function loadLedger(file) {
  try {
    const ledger = JSON.parse(await readFile(file, 'utf8'));
    if (ledger.version !== 1 || !ledger.accounts || !Array.isArray(ledger.bindings)) throw new Error('schema');
    return ledger;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, accounts: {}, bindings: [], last: null };
    throw new Error('无法读取周期账本，请保留 ledger.json 用于排查。');
  }
}

export async function saveLedger(file, ledger) {
  await writeFile(`${file}.tmp`, JSON.stringify(ledger, null, 2));
  await rename(`${file}.tmp`, file);
}

function summarizePeriod(records, window, invalidRecords, currentCredits) {
  const models = new Map();
  let minimum = 0;
  let maximum = 0;
  let totalTokens = 0;
  let unknownSpeed = 0;
  let unpriced = 0;
  let firstAt = null;
  let lastAt = null;
  const balances = new Set(currentCredits == null ? [] : [normalizeCredits(currentCredits)]);
  const providers = new Set();
  for (const request of records) {
    const usage = request.usage;
    const price = priceRequest(request);
    const model = request.model ?? '模型未记录';
    const entry = models.get(model) ?? { model, inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      outputTokens: 0, totalTokens: 0, requests: 0, minimumUsd: 0, maximumUsd: 0, unpriced: 0 };
    entry.inputTokens += usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens;
    entry.cacheReadTokens += usage.cached_input_tokens;
    entry.cacheCreationTokens += usage.cache_write_input_tokens;
    entry.outputTokens += usage.output_tokens;
    entry.totalTokens += usage.total_tokens;
    entry.requests++;
    if (price) {
      minimum += price.minimum;
      maximum += price.maximum;
      entry.minimumUsd += price.minimum;
      entry.maximumUsd += price.maximum;
      unknownSpeed += Number(price.unknownSpeed);
    } else {
      unpriced++;
      entry.unpriced++;
    }
    models.set(model, entry);
    totalTokens += usage.total_tokens;
    firstAt = firstAt == null ? request.at : Math.min(firstAt, request.at);
    lastAt = lastAt == null ? request.at : Math.max(lastAt, request.at);
    if (request.credits != null) balances.add(normalizeCredits(request.credits));
    providers.add(request.provider ?? '未记录');
  }
  const percent = window.usedPercent;
  const creditsChanged = balances.size > 1;
  const canEstimate = records.length > 0 && percent > 0 && !unpriced && !invalidRecords && !creditsChanged;
  const costs = unpriced ? null : [minimum, maximum];
  return { periodKey: periodKey(window), startsAt: periodStart(window), endsAt: window.resetsAt * 1000,
    requests: records.length, totalTokens, models: [...models.values()], costUsdRange: costs,
    unknownSpeed, unpriced, invalidRecords, creditsChanged, firstAt, lastAt, providers: [...providers],
    status: canEstimate ? 'period-estimated' : 'period-pending',
    totalUsdRange: canEstimate ? costs.map(value => value * 100 / percent) : null,
    remainingUsdRange: canEstimate ? costs.map(value => value * (100 - percent) / percent) : null,
    roundingUsdRange: canEstimate && percent > 1 ? [minimum * 100 / Math.min(100, percent + 1), maximum * 100 / (percent - 1)] : null };
}

/** Bind a single-account history range explicitly; detected account changes close it. */
function updateAccountBindings(state, sample) {
  const { accountKey, at } = sample;
  if (state.last?.accountKey && state.last.accountKey !== accountKey) {
    for (const binding of state.bindings) {
      if (binding.until == null) binding.until = state.last.at;
    }
  }
  // A newly seen account is trusted only from its observation onward.
  if (!state.bindings.some(binding => binding.accountKey === accountKey && binding.until == null)) {
    state.bindings.push({ accountKey, from: at, until: null, confirmedByUser: false });
  }
}

function recordQuotaObservation(account, sample) {
  const observation = account.quotaObservation ?? {};
  const credits = normalizeCredits(sample.credits);
  const resetCredits = Number.isFinite(sample.resetCredits) ? sample.resetCredits : null;
  // Keep known values and change evidence even when this sample has no usable windows.
  if (credits != null && observation.credits != null && credits !== observation.credits) {
    observation.creditsChangedAt = sample.at;
    observation.creditsChangedSince = observation.creditsAt ?? sample.at;
  }
  if (resetCredits != null && Number.isFinite(observation.resetCredits) && resetCredits < observation.resetCredits) {
    observation.resetCreditsDecreasedAt = sample.at;
    observation.resetCreditsDecreasedSince = observation.resetCreditsAt ?? sample.at;
  }
  if (credits != null) observation.creditsAt = sample.at;
  if (resetCredits != null) observation.resetCreditsAt = sample.at;
  observation.credits = credits ?? observation.credits ?? null;
  observation.resetCredits = resetCredits ?? observation.resetCredits ?? null;
  account.quotaObservation = observation;
}

function importAccountRequests(state, account, sample, windows, requests) {
  const { accountKey, at } = sample;
  const alreadyOwned = new Set(Object.entries(state.accounts).filter(([key]) => key !== accountKey)
    .flatMap(([, value]) => Object.keys(value.records)));
  for (const request of requests) {
    if (request.at > at || alreadyOwned.has(request.id)) continue;
    const bucket = requestLimitId(request);
    const inWindow = windows.some(window => window.limitId === bucket && request.at >= periodStart(window) && request.at < window.resetsAt * 1000);
    if (!inWindow) continue;
    const bound = state.bindings.find(binding => binding.accountKey === accountKey && request.at >= binding.from
      && (binding.until == null || request.at <= binding.until));
    if (!bound) continue;
    const boundRequest = { ...request, assumedTier: request.tier == null ? bound.defaultTier ?? null : null };
    const previous = account.records[request.id];
    account.records[request.id] = mergeRequests(previous ? [previous, boundRequest] : [boundRequest])[0];
  }
}

function estimatePeriod(account, bindings, sample, window, invalidRecords) {
  const previous = account.periods[periodKey(window)];
  const start = periodStart(window);
  const records = Object.values(account.records).filter(request => {
    if (request.at < start || request.at >= window.resetsAt * 1000 || request.at > sample.at
      || requestLimitId(request) !== window.limitId) return false;
    // In-flight responses can finish after a reset while still belonging to the old quota.
    const recordedWindow = request.windows.find(value => value.limitId === window.limitId
      && value.windowDurationMins === window.windowDurationMins);
    return !recordedWindow || recordedWindow.resetsAt === window.resetsAt;
  });
  const result = summarizePeriod(records, window, invalidRecords, sample.credits);
  const observation = account.quotaObservation;
  // A change first noticed after a reset can belong to the previous period.
  const resetChangedSince = observation.resetCreditsDecreasedSince ?? observation.resetCreditsDecreasedAt;
  const creditsChangedSince = observation.creditsChangedSince ?? observation.creditsChangedAt;
  result.quotaDiscontinuity = Boolean(previous?.quotaDiscontinuity
    || (Number.isFinite(previous?.usedPercent) && window.usedPercent < previous.usedPercent)
    || (Number.isFinite(resetChangedSince) && resetChangedSince >= start));
  result.creditsChanged ||= Boolean(previous?.creditsChanged
    || (Number.isFinite(creditsChangedSince) && creditsChangedSince >= start));
  result.historyBound = bindings.some(binding => binding.accountKey === sample.accountKey && binding.from <= start
    && (binding.until == null || binding.until >= sample.at));
  if (!result.historyBound || result.quotaDiscontinuity || result.creditsChanged) {
    result.status = 'period-pending';
    result.totalUsdRange = result.remainingUsdRange = result.roundingUsdRange = null;
  }
  return result;
}

export function updateLedger(ledger, sample, scanned) {
  const state = structuredClone(ledger);
  const accountKey = sample.accountKey;
  if (!accountKey) return { state, estimates: {} };
  const windows = sample.windows.filter(window => Number.isFinite(window.resetsAt)
    && periodStart(window) <= sample.at && window.resetsAt * 1000 > sample.at);
  updateAccountBindings(state, sample);
  const account = state.accounts[accountKey] ?? { records: {}, periods: {} };
  recordQuotaObservation(account, sample);
  importAccountRequests(state, account, sample, windows, scanned.requests);

  const estimates = {};
  for (const window of windows) {
    const result = estimatePeriod(account, state.bindings, sample, window, scanned.invalidRecords);
    estimates[`${window.limitId}:${window.windowDurationMins}`] = result;
    // Unused Spark reset times move on each query; do not accumulate empty periods.
    if (result.requests || window.usedPercent > 0) {
      account.periods[periodKey(window)] = { ...result, usedPercent: window.usedPercent, at: sample.at, priceBasis: LEDGER_PRICE_BASIS };
    }
  }
  state.accounts[accountKey] = account;
  state.last = { accountKey, at: sample.at };
  return { state, estimates };
}
