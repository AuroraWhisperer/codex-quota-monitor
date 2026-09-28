import { createReadStream } from 'node:fs';
import { readdir, stat, open, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { STANDARD_PRICES, COST_BASIS, fingerprint } from './quota-sources.mjs';

export const LEDGER_PRICE_BASIS = `${COST_BASIS}:request-272k-fast2-v1`;
const USAGE_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const fileCache = new Map();
const validNumber = value => Number.isSafeInteger(value) && value >= 0;
const normalizeCredits = value => value == null ? null : String(value).trim().replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
export const periodKey = window => `${window.limitId}:${window.windowDurationMins}:${window.resetsAt}`;
export const periodStart = window => (window.resetsAt - window.windowDurationMins * 60) * 1000;

function usageCounts(usage) {
  if (!usage) return null;
  const values = Object.fromEntries(USAGE_FIELDS.map(field => [field, usage[field] ?? (field === 'cache_write_input_tokens' || field === 'reasoning_output_tokens' ? 0 : null)]));
  if (!Object.values(values).every(validNumber)
    || values.cached_input_tokens + values.cache_write_input_tokens > values.input_tokens
    || values.reasoning_output_tokens > values.output_tokens
    || values.input_tokens + values.output_tokens !== values.total_tokens) return null;
  return values;
}

function quotaWindows(quota) {
  if (!quota) return [];
  return [quota.primary, quota.secondary].filter(value => value && Number.isFinite(value.resets_at)
    && Number.isFinite(value.window_minutes) && Number.isFinite(value.used_percent)).map(value => ({
    limitId: quota.limit_id ?? 'codex', windowDurationMins: value.window_minutes,
    resetsAt: value.resets_at, usedPercent: value.used_percent,
  }));
}

/** Read usage metadata only; response IDs deduplicate replayed parent/fork history. */
export async function parseUsageLines(lines, { since = 0, sourceKey = '' } = {}) {
  let sessionId = sourceKey;
  let createdAt = 0;
  let model = null;
  let tier = null;
  let provider = null;
  let pending = null;
  let previousTotal = null;
  const requests = [];
  let invalidRecords = 0;
  let incompleteTail = false;
  function emit(request, quota = null) {
    if (request.at < since) return;
    if (!request.usage) { invalidRecords++; return; }
    requests.push({ ...request, windows: quotaWindows(quota), credits: quota?.credits?.balance ?? null });
  }
  for await (const line of lines) {
    // A following physical line proves the previous fragment was not an unfinished tail.
    if (incompleteTail) { invalidRecords++; incompleteTail = false; }
    if (!line.trim()) continue;
    // Validate every line, but retain only usage metadata, never conversation content.
    let record;
    try { record = JSON.parse(line); }
    catch {
      if (/[\r\n]$/.test(line)) invalidRecords++;
      else incompleteTail = true;
      continue;
    }
    const payload = record?.payload;
    const at = Date.parse(record?.timestamp);
    if (!payload || !Number.isFinite(at)) continue;
    if (record.type === 'session_meta') {
      sessionId = payload.id ?? payload.session_id ?? sourceKey;
      createdAt = Date.parse(payload.timestamp ?? record.timestamp);
      provider = payload.model_provider ?? provider;
    } else if (record.type === 'turn_context') {
      model = payload.model ?? null;
      if (Object.hasOwn(payload, 'service_tier')) tier = payload.service_tier;
    } else if (record.type === 'event_msg' && payload.type === 'thread_settings_applied') {
      const settings = payload.thread_settings ?? {};
      model = settings.model ?? model;
      tier = settings.service_tier ?? null;
      provider = settings.model_provider_id ?? provider;
    } else if (record.type === 'token_usage_record') {
      if (pending) emit(pending);
      pending = { id: fingerprint(payload.response_id ? `response:${payload.response_id}`
        : `record:${payload.thread_id ?? sessionId}:${at}:${JSON.stringify(payload.usage)}`),
      at, model, tier, provider, usage: usageCounts(payload.usage),
      original: !payload.thread_id || payload.thread_id === sessionId, source: 'response' };
    } else if (record.type === 'event_msg' && payload.type === 'token_count' && payload.info) {
      const total = usageCounts(payload.info.total_token_usage);
      if (pending) {
        emit(pending, payload.rate_limits);
        pending = null;
      } else if (total && (!previousTotal || total.total_tokens !== previousTotal.total_tokens)) {
        let delta = usageCounts(payload.info.last_token_usage);
        if (previousTotal && USAGE_FIELDS.every(field => total[field] >= previousTotal[field])) {
          delta = usageCounts(Object.fromEntries(USAGE_FIELDS.map(field => [field, total[field] - previousTotal[field]])));
        }
        // Legacy replay prefixes predate the child session; keep the baseline only.
        if (at >= createdAt) emit({ id: fingerprint(`legacy:${sessionId}:${at}:${JSON.stringify(total)}`),
          at, model, tier, provider, usage: delta, original: true, source: 'legacy' }, payload.rate_limits);
      }
      previousTotal = total ?? previousTotal;
    }
  }
  if (pending) emit(pending);
  return { requests, invalidRecords };
}

/** Preserve original metadata; enrich compatible copies without reducing confirmed usage. */
export function mergeRequests(requests) {
  const unique = new Map();
  for (const request of requests) {
    const previous = unique.get(request.id);
    if (!previous) { unique.set(request.id, request); continue; }
    const primary = previous.original !== request.original ? (previous.original ? previous : request)
      : previous.usage.total_tokens >= request.usage.total_tokens ? previous : request;
    const other = primary === previous ? request : previous;
    const merged = { ...primary, usage: other.usage.total_tokens > primary.usage.total_tokens ? other.usage : primary.usage };
    if (primary.original === other.original && primary.model === other.model) {
      merged.tier = primary.tier ?? other.tier;
      merged.assumedTier = merged.tier == null ? primary.assumedTier ?? other.assumedTier ?? null : null;
      merged.windows = primary.windows.length ? primary.windows : other.windows;
      merged.credits = primary.credits ?? other.credits;
    }
    unique.set(request.id, merged);
  }
  return [...unique.values()].sort((left, right) => left.at - right.at);
}

/** JSONL uses LF/CRLF, not Unicode separators inside JSON strings; keep delimiters. */
async function* readJsonLines(file, signal) {
  let buffered = '';
  for await (const chunk of createReadStream(file, { encoding: 'utf8', signal })) {
    buffered += chunk;
    let end;
    while ((end = buffered.indexOf('\n')) !== -1) {
      yield buffered.slice(0, end + 1);
      buffered = buffered.slice(end + 1);
    }
  }
  if (buffered) yield buffered;
}

/** Probe chronological log tails; uncertain or recently modified files keep the full parser. */
async function mayContainPeriod(file, info, since, signal) {
  if (!Number.isFinite(since) || since <= 0 || info.mtimeMs >= since) return true;
  const handle = await open(file, 'r');
  try {
    signal?.throwIfAborted();
    const offset = Math.max(0, info.size - 64 * 1024);
    const buffer = Buffer.alloc(info.size - offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    signal?.throwIfAborted();
    if (bytesRead !== buffer.length) return true;
    const lines = buffer.toString('utf8').split('\n');
    if (offset) lines.shift(); // The probe can begin inside a UTF-8 character or JSON record.
    let hasTimestamp = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      let at;
      try { at = Date.parse(JSON.parse(line)?.timestamp); }
      catch { return true; }
      if (!Number.isFinite(at) || at >= since) return true;
      hasTimestamp = true;
    }
    return !hasTimestamp;
  } finally { await handle.close(); }
}

export async function readRequestLogs(codexHome, since, { signal, onProgress } = {}) {
  signal?.throwIfAborted();
  const files = new Map();
  // Active copies win over the same relative archived path.
  for (const directory of ['sessions', 'archived_sessions']) {
    signal?.throwIfAborted();
    const root = path.join(codexHome, directory);
    let entries;
    try { entries = await readdir(root, { recursive: true, withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(entry.parentPath, entry.name);
      const relative = path.relative(root, file);
      if (!files.has(relative)) files.set(relative, file);
    }
  }
  const selected = [];
  let completed = 0;
  onProgress?.({ phase: 'filter', completed, total: files.size });
  for (const file of files.values()) {
    signal?.throwIfAborted();
    const info = await stat(file);
    // Open Windows logs can keep an old mtime while growing; filter by request timestamps.
    let cached = fileCache.get(file);
    if (cached && (cached.size !== info.size || cached.modifiedAt !== info.mtimeMs || cached.since > since)) cached = null;
    if (cached) {
      if (cached.invalidRecords || cached.requests.some(request => request.at >= since)) selected.push({ file, info, cached });
    } else if (await mayContainPeriod(file, info, since, signal)) {
      selected.push({ file, info, cached: null });
    } else {
      fileCache.set(file, { requests: [], invalidRecords: 0, size: info.size, modifiedAt: info.mtimeMs, since });
    }
    onProgress?.({ phase: 'filter', completed: ++completed, total: files.size });
  }
  signal?.throwIfAborted();
  let invalidRecords = 0;
  const requests = [];
  completed = 0;
  onProgress?.({ phase: 'parse', completed, total: selected.length });
  for (const entry of selected) {
    signal?.throwIfAborted();
    const { file, info } = entry;
    let { cached } = entry;
    if (!cached) {
      const result = await parseUsageLines(readJsonLines(file, signal), { since, sourceKey: fingerprint(file) });
      cached = { ...result, size: info.size, modifiedAt: info.mtimeMs, since };
      fileCache.set(file, cached);
    }
    invalidRecords += cached.invalidRecords;
    requests.push(...cached.requests.filter(request => request.at >= since));
    onProgress?.({ phase: 'parse', completed: ++completed, total: selected.length });
  }
  signal?.throwIfAborted();
  return { requests: mergeRequests(requests), invalidRecords };
}

/** API-equivalent price per request; unknown speed is a Standard-to-Fast interval. */
export function priceRequest(request) {
  const rate = Object.hasOwn(STANDARD_PRICES, request.model) ? STANDARD_PRICES[request.model] : null;
  if (!rate) return null;
  const usage = request.usage;
  const longContext = usage.input_tokens > 272_000;
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  const ordinaryInput = usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens;
  const base = ((ordinaryInput * rate.input + usage.cached_input_tokens * rate.cacheRead
    + usage.cache_write_input_tokens * rate.cacheCreation) * inputMultiplier
    + usage.output_tokens * rate.output * outputMultiplier) / 1_000_000;
  const tier = request.tier ?? request.assumedTier;
  if (['priority', 'fast'].includes(tier)) return { minimum: base * 2, maximum: base * 2, unknownSpeed: false, longContext };
  if (tier === 'default') return { minimum: base, maximum: base, unknownSpeed: false, longContext };
  if (['flex', 'batch'].includes(tier)) return { minimum: base / 2, maximum: base / 2, unknownSpeed: false, longContext };
  return { minimum: base, maximum: base * 2, unknownSpeed: true, longContext };
}

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
      minimum += price.minimum; maximum += price.maximum;
      entry.minimumUsd += price.minimum; entry.maximumUsd += price.maximum;
      unknownSpeed += Number(price.unknownSpeed);
    } else { unpriced++; entry.unpriced++; }
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
export function updateLedger(ledger, sample, scanned) {
  const state = structuredClone(ledger);
  const accountKey = sample.accountKey;
  if (!accountKey) return { state, estimates: {} };
  const windows = sample.windows.filter(window => Number.isFinite(window.resetsAt) && periodStart(window) <= sample.at && window.resetsAt * 1000 > sample.at);
  if (state.last?.accountKey && state.last.accountKey !== accountKey) {
    for (const binding of state.bindings) {
      if (binding.until == null) binding.until = state.last.at;
    }
  }
  // A newly seen account is trusted only from its observation onward.
  if (!state.bindings.some(binding => binding.accountKey === accountKey && binding.until == null)) {
    state.bindings.push({ accountKey, from: sample.at, until: null, confirmedByUser: false });
  }
  const account = state.accounts[accountKey] ?? { records: {}, periods: {} };
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
  const alreadyOwned = new Set(Object.entries(state.accounts).filter(([key]) => key !== accountKey)
    .flatMap(([, value]) => Object.keys(value.records)));
  for (const request of scanned.requests) {
    if (request.at > sample.at || alreadyOwned.has(request.id)) continue;
    const bucket = /spark/i.test(request.model ?? '') ? 'codex_bengalfox' : 'codex';
    const inWindow = windows.some(window => window.limitId === bucket && request.at >= periodStart(window) && request.at < window.resetsAt * 1000);
    if (!inWindow) continue;
    const bound = state.bindings.find(binding => binding.accountKey === accountKey && request.at >= binding.from
      && (binding.until == null || request.at <= binding.until));
    if (bound) {
      const priced = { ...request, assumedTier: request.tier == null ? bound.defaultTier ?? null : null };
      account.records[request.id] = mergeRequests([...(account.records[request.id] ? [account.records[request.id]] : []), priced])[0];
    }
  }
  const estimates = {};
  for (const window of windows) {
    const previous = account.periods[periodKey(window)];
    const start = periodStart(window);
    const records = Object.values(account.records).filter(request => {
      if (request.at < start || request.at >= window.resetsAt * 1000 || request.at > sample.at
        || (/spark/i.test(request.model ?? '') ? 'codex_bengalfox' : 'codex') !== window.limitId) return false;
      // In-flight responses can finish after a reset while still belonging to the old quota.
      const recordedWindow = request.windows.find(value => value.limitId === window.limitId
        && value.windowDurationMins === window.windowDurationMins);
      return !recordedWindow || recordedWindow.resetsAt === window.resetsAt;
    });
    const result = summarizePeriod(records, window, scanned.invalidRecords, sample.credits);
    // A change first noticed after a reset can belong to the previous period.
    const resetChangedSince = observation.resetCreditsDecreasedSince ?? observation.resetCreditsDecreasedAt;
    const creditsChangedSince = observation.creditsChangedSince ?? observation.creditsChangedAt;
    result.quotaDiscontinuity = Boolean(previous?.quotaDiscontinuity
      || (Number.isFinite(previous?.usedPercent) && window.usedPercent < previous.usedPercent)
      || (Number.isFinite(resetChangedSince) && resetChangedSince >= start));
    result.creditsChanged ||= Boolean(previous?.creditsChanged
      || (Number.isFinite(creditsChangedSince) && creditsChangedSince >= start));
    result.historyBound = state.bindings.some(binding => binding.accountKey === accountKey && binding.from <= start
      && (binding.until == null || binding.until >= sample.at));
    if (!result.historyBound || result.quotaDiscontinuity || result.creditsChanged) {
      result.status = 'period-pending';
      result.totalUsdRange = result.remainingUsdRange = result.roundingUsdRange = null;
    }
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
