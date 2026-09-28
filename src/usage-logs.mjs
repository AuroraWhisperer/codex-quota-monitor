import { createReadStream } from 'node:fs';
import { readdir, stat, open } from 'node:fs/promises';
import path from 'node:path';
import { fingerprint } from './fingerprint.mjs';

const USAGE_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const fileCache = new Map();
const validNumber = value => Number.isSafeInteger(value) && value >= 0;

function usageCounts(usage) {
  if (!usage) return null;
  const values = {};
  for (const field of USAGE_FIELDS) {
    const optional = field === 'cache_write_input_tokens' || field === 'reasoning_output_tokens';
    values[field] = usage[field] ?? (optional ? 0 : null);
  }
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
    if (!request.usage) {
      invalidRecords++;
      return;
    }
    requests.push({ ...request, windows: quotaWindows(quota), credits: quota?.credits?.balance ?? null });
  }
  for await (const line of lines) {
    // A following physical line proves the previous fragment was not an unfinished tail.
    if (incompleteTail) {
      invalidRecords++;
      incompleteTail = false;
    }
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
    if (!previous) {
      unique.set(request.id, request);
      continue;
    }
    let primary;
    if (previous.original !== request.original) {
      primary = previous.original ? previous : request;
    } else {
      primary = previous.usage.total_tokens >= request.usage.total_tokens ? previous : request;
    }
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

async function findSessionFiles(codexHome, signal) {
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
  return files;
}

export async function readRequestLogs(codexHome, since, { signal, onProgress } = {}) {
  signal?.throwIfAborted();
  const files = await findSessionFiles(codexHome, signal);
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
