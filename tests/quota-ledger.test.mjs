import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseUsageLines, mergeRequests, priceRequest, readRequestLogs, updateLedger, loadLedger, saveLedger } from '../src/quota-ledger.mjs';
import { renderSnapshot } from '../src/quota-monitor.mjs';

const start = Date.UTC(2026, 0, 8, 13, 30, 0);
const end = start + 7 * 86400_000;
const usage = (input = 100, cached = 20, output = 10) => ({ input_tokens: input, cached_input_tokens: cached,
  cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 5, total_tokens: input + output });
const window = { limitId: 'codex', limitName: 'codex', windowDurationMins: 10080, resetsAt: end / 1000, usedPercent: 10 };
const sample = (at = start + 3600_000, overrides = {}) => ({ at, accountKey: 'a', windows: [window], credits: '100', ...overrides });
const ledger = () => ({ version: 1, accounts: {}, last: null, bindings: [{ accountKey: 'a', from: start, until: null, confirmedByUser: true }] });
const request = (id, at = start + 60_000, overrides = {}) => ({ id, at, usage: usage(), model: 'gpt-6-astra',
  tier: 'default', original: true, provider: 'openai', windows: [], credits: '100', source: 'response', ...overrides });
const scan = requests => ({ requests, invalidRecords: 0 });
const weekly = result => result.estimates['codex:10080'];
const line = (type, payload, at = start) => JSON.stringify({ type, payload, timestamp: new Date(at).toISOString() });
const meta = () => line('session_meta', { id: 'thread', timestamp: new Date(start).toISOString(), model_provider: 'openai' });
const turn = model => line('turn_context', { model });
const record = (id = 'r1', at = start + 1000) => line('token_usage_record', { thread_id: 'thread', response_id: id, usage: usage() }, at);
const count = (total = usage(), at = start + 1000, resetsAt = end / 1000) => line('event_msg', { type: 'token_count', info: {
  last_token_usage: usage(), total_token_usage: total }, rate_limits: { limit_id: 'codex', primary: {
    used_percent: 10, window_minutes: 10080, resets_at: resetsAt }, credits: { balance: '100' } } }, at);

async function removeFixture(directory) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !/^quota-(ledger|rollout)-test-/.test(path.basename(resolved))) {
    throw new Error('Unexpected fixture path');
  }
  await rm(resolved, { recursive: true, force: true });
}

test('pairs response usage with quota metadata and ignores repeated cumulative notifications', async () => {
  const parsed = await parseUsageLines([meta(), turn('gpt-6-astra'), record(), count(), count()]);
  assert.equal(parsed.requests.length, 1);
  assert.equal(parsed.requests[0].usage.total_tokens, 110);
  assert.equal(parsed.requests[0].windows[0].resetsAt, end / 1000);
  assert.equal(parsed.invalidRecords, 0);
});

test('uses each turn model and recorded speed, leaving initial speed unknown', async () => {
  const parsed = await parseUsageLines([meta(), turn('gpt-6-astra'), record(), count(),
    line('event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.6-sol', service_tier: 'priority' } }),
    turn('gpt-5.6-sol'), record('r2', start + 2000), count(usage(200, 40, 20), start + 2000)]);
  assert.equal(parsed.requests[0].tier, null);
  assert.equal(parsed.requests[1].tier, 'priority');
  assert.equal(parsed.requests[1].model, 'gpt-5.6-sol');
});

test('fork copies and partially repeated response records are counted once', () => {
  const original = request('r');
  const copy = { ...original, original: false, model: 'gpt-5.6-sol' };
  const final = { ...original, usage: usage(100, 20, 20) };
  const result = mergeRequests([copy, original, final, original]);
  assert.equal(result.length, 1);
  assert.equal(result[0].model, 'gpt-6-astra');
  assert.equal(result[0].usage.total_tokens, 120);
});

test('fork metadata cannot replace original model or speed in either import order', () => {
  const original = request('r', start, { tier: null, assumedTier: 'default' });
  const copy = { ...original, original: false, model: 'gpt-5.6-sol', tier: 'priority',
    assumedTier: null, usage: usage(100, 20, 20), windows: [window] };
  const before = structuredClone([original, copy]);
  for (const records of [[original, copy], [copy, original]]) {
    const merged = mergeRequests(records);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].original, true);
    assert.equal(merged[0].model, 'gpt-6-astra');
    assert.equal(merged[0].tier, null);
    assert.equal(merged[0].assumedTier, 'default');
    assert.equal(merged[0].usage.total_tokens, 120);
    assert.equal(priceRequest(merged[0]).unknownSpeed, false);
    assert.deepEqual(mergeRequests([...merged, ...records]), merged);
  }
  assert.deepEqual([original, copy], before);
});

test('metadata enrichment keeps complete usage and recorded tiers override assumptions', () => {
  const complete = request('r', start, { usage: usage(100, 20, 20), tier: null,
    assumedTier: 'priority', credits: null });
  const partial = request('r', start, { windows: [window] });
  const forward = mergeRequests([complete, partial]);
  const reverse = mergeRequests([partial, complete]);
  assert.deepEqual(forward, reverse);
  assert.equal(forward[0].usage.total_tokens, 120);
  assert.equal(forward[0].tier, 'default');
  assert.deepEqual(forward[0].windows, [window]);
  assert.equal(forward[0].credits, '100');
  assert.equal(priceRequest(forward[0]).minimum, priceRequest({ ...complete, tier: 'default' }).minimum);
  assert.deepEqual(mergeRequests([...forward, partial, complete]), forward);
});

test('corrupt middle lines are reported even when the damaged type cannot be recognized', async () => {
  for (const broken of ['{"type":"token_usage_record","payload":', '{"type":"token_us', 'not-json']) {
    const parsed = await parseUsageLines([meta(), turn('gpt-6-astra'), record(), broken,
      record('r2', start + 2000)]);
    assert.equal(parsed.invalidRecords, 1);
    assert.equal(parsed.requests.length, 2);
    assert.equal(weekly(updateLedger(ledger(), sample(), parsed)).status, 'period-pending');
  }
});

test('only an unterminated final JSON fragment can wait for completion', async () => {
  const prefix = [meta(), turn('gpt-6-astra'), record()];
  const broken = '{"type":"token_usage_record","payload":';
  assert.equal((await parseUsageLines([...prefix, broken])).invalidRecords, 0);
  assert.equal((await parseUsageLines([...prefix, `${broken}\n`])).invalidRecords, 1);
  assert.equal((await parseUsageLines([...prefix, broken, ''])).invalidRecords, 1);
});

test('legacy cumulative logs use deltas and exclude inherited pre-session history', async () => {
  const parsed = await parseUsageLines([meta(), turn('gpt-6-astra'), count(usage(), start - 1000),
    count(usage(200, 40, 20), start + 1000), count(usage(200, 40, 20), start + 2000)]);
  assert.equal(parsed.requests.length, 1);
  assert.equal(parsed.requests[0].usage.total_tokens, 110);
});

test('cache discount, reasoning inclusion, exact long-context threshold and Fast pricing', () => {
  const ordinary = priceRequest(request('r'));
  assert.ok(Math.abs(ordinary.minimum - 0.00132) < 1e-10);
  const exact = priceRequest(request('r', start, { usage: usage(272000, 200000, 10) }));
  const over = priceRequest(request('r', start, { usage: usage(272001, 200000, 10), tier: 'priority' }));
  assert.equal(exact.longContext, false);
  assert.equal(over.longContext, true);
  assert.ok(Math.abs(over.minimum - ((72001 * 10 + 200000) * 2 + 10 * 50 * 1.5) * 2 / 1e6) < 1e-10);
  const unknown = priceRequest(request('r', start, { tier: null }));
  assert.equal(unknown.maximum, unknown.minimum * 2);
});

test('period backfill uses the account seven-day boundary, not calendar dates or monitor start', () => {
  const result = updateLedger(ledger(), sample(), scan([
    request('old', start - 1), request('first', start), request('second', start + 1000), request('future', end),
  ]));
  assert.equal(weekly(result).requests, 2);
  assert.equal(weekly(result).totalTokens, 220);
  assert.equal(weekly(result).startsAt, start);
  assert.equal(weekly(result).status, 'period-estimated');
  assert.ok(Math.abs(weekly(result).totalUsdRange[0] - 0.0264) < 1e-10);
});

test('confirmed account history preserves recorded provider metadata', () => {
  const result = updateLedger(ledger(), sample(), scan([request('a', start + 1000, { provider: 'provider-a' }),
    request('b', start + 2000, { provider: 'provider-b' })]));
  assert.equal(weekly(result).requests, 2);
  assert.deepEqual(weekly(result).providers, ['provider-a', 'provider-b']);
});

test('user-confirmed Standard resolves missing historical speed without overriding recorded Fast', () => {
  const saved = ledger();
  saved.bindings[0].defaultTier = 'default';
  const result = updateLedger(saved, sample(), scan([request('missing', start + 1000, { tier: null })]));
  assert.equal(weekly(result).unknownSpeed, 0);
  assert.equal(weekly(result).costUsdRange[0], weekly(result).costUsdRange[1]);
  assert.equal(result.state.accounts.a.records.missing.tier, null);
  assert.equal(result.state.accounts.a.records.missing.assumedTier, 'default');
  const fast = priceRequest(request('fast', start, { tier: 'priority', assumedTier: 'default' }));
  assert.ok(Math.abs(fast.minimum - 0.00264) < 1e-10);
});

test('restart backfills downtime exactly once and survives a missing source file', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quota-ledger-test-'));
  t.after(() => removeFixture(directory));
  const file = path.join(directory, 'ledger.json');
  const first = updateLedger(ledger(), sample(), scan([request('one')]));
  await saveLedger(file, first.state);
  const resumed = updateLedger(await loadLedger(file), sample(start + 7200_000), scan([request('one'), request('two', start + 4000_000)]));
  assert.equal(weekly(resumed).requests, 2);
  assert.equal(weekly(updateLedger(resumed.state, sample(start + 8000_000), scan([]))).requests, 2);
});

test('new week keeps old records out of the new period', () => {
  const first = updateLedger(ledger(), sample(), scan([request('old')]));
  const next = sample(end + 3600_000, { windows: [{ ...window, resetsAt: end / 1000 + 7 * 86400, usedPercent: 1 }] });
  const result = updateLedger(first.state, next, scan([request('old'), request('new', end)]));
  assert.equal(weekly(result).requests, 1);
  assert.equal(weekly(result).startsAt, end);
  assert.equal(Object.keys(result.state.accounts.a.periods).length, 2);
});

test('an early reset starts a fresh estimate and excludes delayed requests carrying the old window', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quota-ledger-test-'));
  t.after(() => removeFixture(directory));
  const file = path.join(directory, 'ledger.json');
  const first = updateLedger(ledger(), sample(start + 3600_000, { resetCredits: 2 }), scan([request('old')]));
  const resetAt = start + 7200_000;
  const nextWindow = { ...window, resetsAt: (resetAt + 7 * 86400_000) / 1000, usedPercent: 22 };
  const current = sample(resetAt + 3600_000, { windows: [nextWindow], credits: '80', resetCredits: 1, errors: [] });
  const requests = [
    request('late-old', resetAt, { windows: [window], credits: '90' }),
    request('new', resetAt + 1000, { windows: [nextWindow], credits: '80' }),
    request('no-window', resetAt + 2000, { credits: null }),
    request('late-old-again', resetAt + 3000, { windows: [window], credits: '100' }),
  ];
  const result = updateLedger(first.state, current, scan(requests));
  assert.equal(weekly(result).requests, 2);
  assert.equal(weekly(result).totalTokens, 220);
  assert.equal(weekly(result).creditsChanged, false);
  assert.equal(weekly(result).quotaDiscontinuity, false);
  assert.equal(weekly(result).status, 'period-estimated');
  assert.ok(Math.abs(weekly(result).totalUsdRange[0] - 0.012) < 1e-10);
  assert.ok(Math.abs(weekly(result).remainingUsdRange[0] - 0.00936) < 1e-10);
  assert.equal(Object.keys(result.state.accounts.a.records).length, 5, 'delayed records remain in the ledger');
  assert.deepEqual(result.state.accounts.a.periods[weekly(first).periodKey], first.state.accounts.a.periods[weekly(first).periodKey]);
  assert.match(renderSnapshot({ sample: current, estimates: result.estimates }), /按本周期已用 22% 推算：满额/);
  await saveLedger(file, result.state);
  const restored = updateLedger(await loadLedger(file), { ...current, at: current.at + 60_000 }, scan([]));
  assert.deepEqual(weekly(restored), weekly(result));
  const changed = updateLedger(restored.state, { ...current, at: current.at + 120_000, credits: '79', resetCredits: 0 }, scan([]));
  assert.equal(weekly(changed).creditsChanged, true);
  assert.equal(weekly(changed).quotaDiscontinuity, true);
  assert.equal(weekly(changed).totalUsdRange, null);
});

test('a new 5h window does not hide credit and reset changes within the ongoing week', () => {
  const short = { ...window, windowDurationMins: 300, resetsAt: (start + 5 * 3600_000) / 1000 };
  const first = updateLedger(ledger(), sample(start + 3600_000, { windows: [window, short], resetCredits: 2 }),
    scan([request('old', start, { credits: null })]));
  const current = sample(start + 6 * 3600_000, { windows: [window, { ...short, resetsAt: (start + 10 * 3600_000) / 1000 }],
    credits: '80', resetCredits: 1 });
  const result = updateLedger(first.state, current, scan([request('new', start + 5 * 3600_000, { credits: '80', windows: [window] })]));
  assert.equal(weekly(result).status, 'period-pending');
  assert.equal(weekly(result).quotaDiscontinuity, true);
  assert.equal(result.estimates['codex:300'].status, 'period-estimated');
  assert.equal(result.estimates['codex:300'].requests, 1);
});

test('credit changes within a new period still pause a first observation after the reset', () => {
  const first = updateLedger(ledger(), sample(start + 3600_000, { resetCredits: 2 }), scan([request('old')]));
  const resetAt = start + 7200_000;
  const nextWindow = { ...window, resetsAt: (resetAt + 7 * 86400_000) / 1000 };
  const result = updateLedger(first.state, sample(resetAt + 3600_000, {
    windows: [nextWindow], credits: '80', resetCredits: 1,
  }), scan([request('new', resetAt + 1000, { windows: [nextWindow], credits: '85' })]));
  assert.equal(weekly(result).creditsChanged, true);
  assert.equal(weekly(result).totalUsdRange, null);
});

test('moving reset timestamps of unused Spark do not create endless saved periods', () => {
  let state = ledger();
  for (let minute = 0; minute < 3; minute++) {
    const at = start + (60 + minute) * 60_000;
    state = updateLedger(state, sample(at, { windows: [{ ...window, limitId: 'codex_bengalfox',
      resetsAt: at / 1000 + 7 * 86400, usedPercent: 0 }] }), scan([])).state;
  }
  assert.deepEqual(state.accounts.a.periods, {});
});

test('5h boundary has its own sum and does not change the weekly sum', () => {
  const current = sample(start + 10 * 3600_000, { windows: [window,
    { ...window, windowDurationMins: 300, resetsAt: (start + 12 * 3600_000) / 1000 }] });
  const result = updateLedger(ledger(), current, scan([request('old'), request('new', start + 8 * 3600_000)]));
  assert.equal(weekly(result).requests, 2);
  assert.equal(result.estimates['codex:300'].requests, 1);
});

test('quota rollback pauses only that period, survives reload, and clears in the next period', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quota-ledger-test-'));
  t.after(() => removeFixture(directory));
  const file = path.join(directory, 'ledger.json');
  const short = { ...window, windowDurationMins: 300, resetsAt: (start + 5 * 3600_000) / 1000, usedPercent: 40 };
  const first = updateLedger(ledger(), sample(start + 3600_000, {
    windows: [{ ...window, usedPercent: 80 }, short], resetCredits: 2,
  }), scan([request('r')]));
  const current = sample(start + 7200_000, { windows: [window, { ...short, usedPercent: 41 }],
    resetCredits: 2, errors: [] });
  const rolledBack = updateLedger(first.state, current, scan([]));
  assert.equal(weekly(rolledBack).quotaDiscontinuity, true);
  assert.equal(weekly(rolledBack).status, 'period-pending');
  assert.equal(weekly(rolledBack).totalUsdRange, null);
  assert.equal(weekly(rolledBack).remainingUsdRange, null);
  assert.equal(weekly(rolledBack).roundingUsdRange, null);
  assert.deepEqual(weekly(rolledBack).costUsdRange, weekly(first).costUsdRange);
  assert.equal(rolledBack.estimates['codex:300'].status, 'period-estimated');
  assert.match(renderSnapshot({ sample: current, estimates: rolledBack.estimates }), /额度.*回退.*暂停/);
  await saveLedger(file, rolledBack.state);
  const restored = updateLedger(await loadLedger(file), sample(start + 10800_000, {
    windows: [{ ...window, usedPercent: 12 }], resetCredits: 2,
  }), scan([]));
  assert.equal(weekly(restored).status, 'period-pending');
  const next = updateLedger(restored.state, sample(end + 3600_000, {
    windows: [{ ...window, resetsAt: end / 1000 + 7 * 86400 }], resetCredits: 2,
  }), scan([request('next', end)]));
  assert.equal(weekly(next).quotaDiscontinuity, false);
  assert.equal(weekly(next).status, 'period-estimated');
  assert.equal(weekly(next).requests, 1);
});

test('a reset-credit decrease pauses extrapolation without a percentage rollback', () => {
  const first = updateLedger(ledger(), sample(start + 3600_000, { resetCredits: 2 }), scan([request('r')]));
  const gap = updateLedger(first.state, sample(start + 7200_000, { resetCredits: null }), scan([]));
  const changed = updateLedger(gap.state, sample(start + 10800_000, {
    windows: [{ ...window, usedPercent: 11 }], resetCredits: 1,
  }), scan([]));
  assert.equal(weekly(changed).quotaDiscontinuity, true);
  assert.equal(weekly(changed).status, 'period-pending');
  const repeated = updateLedger(changed.state, sample(start + 14400_000, {
    windows: [{ ...window, usedPercent: 12 }], resetCredits: 2,
  }), scan([]));
  assert.equal(weekly(repeated).totalUsdRange, null);
});

test('snapshot-only credit changes survive missing observations and a disk reload', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quota-ledger-test-'));
  t.after(() => removeFixture(directory));
  const file = path.join(directory, 'ledger.json');
  const first = updateLedger(ledger(), sample(), scan([request('r', start + 1000, { credits: null })]));
  const gap = updateLedger(first.state, sample(start + 7200_000, { credits: null }), scan([]));
  assert.equal(weekly(gap).creditsChanged, false);
  await saveLedger(file, gap.state);
  const changed = updateLedger(await loadLedger(file), sample(start + 10800_000, { credits: '50' }), scan([]));
  assert.equal(weekly(changed).creditsChanged, true);
  assert.equal(weekly(changed).status, 'period-pending');
  assert.equal(weekly(changed).totalUsdRange, null);
  assert.deepEqual(weekly(changed).costUsdRange, weekly(first).costUsdRange);
  const repeated = updateLedger(changed.state, sample(start + 14400_000, { credits: '100' }), scan([]));
  assert.equal(weekly(repeated).creditsChanged, true);
  assert.equal(weekly(repeated).totalUsdRange, null);
  const next = updateLedger(repeated.state, sample(end + 3600_000, {
    windows: [{ ...window, resetsAt: end / 1000 + 7 * 86400 }], credits: '100',
  }), scan([request('next', end, { credits: null })]));
  assert.equal(weekly(next).creditsChanged, false);
  assert.equal(weekly(next).status, 'period-estimated');
});

test('equivalent credit formats are unchanged, but changes from zero are detected', () => {
  for (const [balance, equivalent] of [['100.000', 100], ['0.000', 0]]) {
    const first = updateLedger(ledger(), sample(start + 3600_000, { credits: balance }),
      scan([request('r', start, { credits: equivalent })]));
    assert.equal(weekly(first).creditsChanged, false);
    assert.equal(weekly(first).status, 'period-estimated');
    const same = updateLedger(first.state, sample(start + 7200_000, { credits: equivalent }), scan([]));
    assert.equal(weekly(same).creditsChanged, false);
    const changed = updateLedger(same.state, sample(start + 10800_000, { credits: '1.0' }), scan([]));
    assert.equal(weekly(changed).creditsChanged, true);
  }
});

test('quota and credit observations are isolated between accounts', () => {
  const first = updateLedger(ledger(), sample(start + 3600_000, { resetCredits: 2 }),
    scan([request('a', start, { credits: null })]));
  const switched = updateLedger(first.state, sample(start + 7200_000, {
    accountKey: 'b', windows: [{ ...window, usedPercent: 1 }], credits: '50', resetCredits: 1,
  }), scan([request('b', start + 7200_000, { credits: null })]));
  assert.equal(weekly(switched).quotaDiscontinuity, false);
  assert.equal(weekly(switched).creditsChanged, false);
  const back = updateLedger(switched.state, sample(start + 10800_000, { resetCredits: 2 }), scan([]));
  assert.equal(weekly(back).quotaDiscontinuity, false);
  assert.equal(weekly(back).creditsChanged, false);
});

test('empty periods and missing windows do not lose observed balance or reset changes', () => {
  const first = updateLedger(ledger(), sample(start + 3600_000, {
    windows: [{ ...window, usedPercent: 0 }], resetCredits: 2,
  }), scan([]));
  assert.deepEqual(first.state.accounts.a.periods, {});
  const gap = updateLedger(first.state, sample(start + 7200_000, {
    windows: [], credits: '50', resetCredits: 1,
  }), scan([]));
  const observed = updateLedger(gap.state, sample(start + 10800_000, {
    credits: '100', resetCredits: 2,
  }), scan([request('r', start + 1000, { credits: null })]));
  assert.equal(weekly(observed).creditsChanged, true);
  assert.equal(weekly(observed).quotaDiscontinuity, true);
  assert.equal(weekly(observed).totalUsdRange, null);
});

test('switching accounts closes the old binding and cannot claim another account history', () => {
  const first = updateLedger(ledger(), sample(), scan([request('a')]));
  const switched = updateLedger(first.state, sample(start + 7200_000, { accountKey: 'b' }), scan([request('a')]));
  assert.equal(weekly(switched).requests, 0);
  assert.equal(weekly(switched).status, 'period-pending');
  const b = updateLedger(switched.state, sample(start + 8000_000, { accountKey: 'b' }), scan([request('b', start + 7500_000)]));
  const back = updateLedger(b.state, sample(start + 9000_000), scan([request('a'), request('b', start + 7500_000)]));
  assert.equal(weekly(back).requests, 1);
  assert.equal(weekly(back).historyBound, false);
});

test('zero percentage, unknown pricing, credit changes and unreadable logs never yield a false full quota', () => {
  for (const [current, scanned] of [
    [sample(start + 3600_000, { windows: [{ ...window, usedPercent: 0 }] }), scan([request('a')])],
    [sample(), scan([request('a', start + 1000, { model: 'unknown' })])],
    [sample(start + 3600_000, { credits: '50' }), scan([request('a')])],
    [sample(), { requests: [request('a')], invalidRecords: 1 }],
  ]) {
    const result = weekly(updateLedger(ledger(), current, scanned));
    assert.equal(result.status, 'period-pending');
    assert.equal(result.totalUsdRange, null);
  }
});

test('active/archive duplicate files and response IDs deduplicate in the real reader', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quota-rollout-test-'));
  t.after(() => removeFixture(directory));
  for (const sub of ['sessions', 'archived_sessions']) await mkdir(path.join(directory, sub));
  const contents = [meta(), turn('gpt-6-astra'), record(), count()].join('\n');
  await writeFile(path.join(directory, 'sessions', 'same.jsonl'), contents);
  await writeFile(path.join(directory, 'archived_sessions', 'same.jsonl'), contents);
  await writeFile(path.join(directory, 'archived_sessions', 'fork.jsonl'), contents);
  assert.equal((await readRequestLogs(directory, start)).requests.length, 1);
});

for (const sub of ['sessions', 'archived_sessions']) {
  test(`${sub} requests after a reset are read even when file modification time stays old`, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'quota-rollout-test-'));
    t.after(() => removeFixture(directory));
    await mkdir(path.join(directory, sub));
    const file = path.join(directory, sub, 'ongoing.jsonl');
    const resetAt = start + 2 * 3600_000;
    const nextReset = (resetAt + 7 * 86400_000) / 1000;
    const oldMtime = new Date(start);
    await writeFile(file, [meta(), turn('gpt-6-astra'), record('before'), count(),
      record('after', resetAt), count(usage(200, 40, 20), resetAt, nextReset), ''].join('\n'));
    await utimes(file, oldMtime, oldMtime);

    const cold = await readRequestLogs(directory, resetAt);
    assert.equal(cold.requests.length, 1);
    assert.equal(cold.requests[0].at, resetAt);
    assert.equal(cold.requests[0].usage.total_tokens, 110);
    assert.equal(cold.invalidRecords, 0);

    // Reuse a scan from the earlier quota window, as a continuously running monitor does.
    assert.equal((await readRequestLogs(directory, start)).requests.length, 2);
    assert.deepEqual(await readRequestLogs(directory, resetAt), cold);
    await appendFile(file, [record('later', resetAt + 1000),
      count(usage(300, 60, 30), resetAt + 1000, nextReset), ''].join('\n'));
    await utimes(file, oldMtime, oldMtime);
    const appended = await readRequestLogs(directory, resetAt);
    assert.equal(appended.requests.length, 2);
    assert.equal(appended.requests.reduce((sum, value) => sum + value.usage.total_tokens, 0), 220);
    assert.deepEqual(await readRequestLogs(directory, resetAt), appended);

    const current = sample(resetAt + 3600_000, { windows: [{ ...window,
      resetsAt: (resetAt + 7 * 86400_000) / 1000, usedPercent: 3 }] });
    const result = updateLedger(ledger(), current, appended);
    assert.equal(weekly(result).requests, 2);
    assert.equal(weekly(result).totalTokens, 220);
    assert.ok(weekly(result).costUsdRange[0] > 0);
    assert.deepEqual(weekly(updateLedger(result.state, current, appended)), weekly(result));
  });
}

test('file scans distinguish incomplete tails from completed bad lines and recover after repair', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quota-rollout-test-'));
  t.after(() => removeFixture(directory));
  await mkdir(path.join(directory, 'sessions'));
  const file = path.join(directory, 'sessions', 'tail.jsonl');
  const prefix = [meta(), turn('gpt-6-astra'), record(), count()].join('\r\n');
  const broken = '{"type":"token_usage_record","payload":';
  await writeFile(file, `${prefix}\r\n${broken}`);
  assert.equal((await readRequestLogs(directory, start)).invalidRecords, 0);
  await writeFile(file, `${prefix}\r\n${broken}\r\n`);
  assert.equal((await readRequestLogs(directory, start)).invalidRecords, 1);
  await writeFile(file, `${prefix}\r\n${broken}\r\n${record('r2', start + 2000)}\r\n`);
  const corrupt = await readRequestLogs(directory, start);
  assert.equal(corrupt.invalidRecords, 1);
  assert.equal(corrupt.requests.length, 2);
  await writeFile(file, `${prefix}\r\n${record('r2', start + 2000)}\r\n`);
  const repaired = await readRequestLogs(directory, start);
  assert.equal(repaired.invalidRecords, 0);
  assert.equal(repaired.requests.length, 2);
});

test('JSON strings containing Unicode line separators do not become corrupt physical lines', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quota-rollout-test-'));
  t.after(() => removeFixture(directory));
  await mkdir(path.join(directory, 'sessions'));
  const context = line('turn_context', { model: 'gpt-6-astra', note: 'first\u2028second\u2029third' });
  const contents = [meta(), context, record(), count()].join('\n');
  await writeFile(path.join(directory, 'sessions', 'unicode.jsonl'), contents);
  const parsed = await readRequestLogs(directory, start);
  assert.equal(parsed.invalidRecords, 0);
  assert.equal(parsed.requests.length, 1);
  assert.equal(parsed.requests[0].model, 'gpt-6-astra');
});

test('log scanning reports progress for cold and cached files without double-counting archives', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quota-rollout-test-'));
  t.after(() => removeFixture(directory));
  for (const name of ['sessions', 'archived_sessions']) {
    await mkdir(path.join(directory, name));
    await writeFile(path.join(directory, name, 'same.jsonl'), [meta(), turn('gpt-6-astra'), record()].join('\n'));
  }
  await writeFile(path.join(directory, 'sessions', 'second.jsonl'),
    [meta(), turn('gpt-6-astra'), record('r2')].join('\n'));
  for (let attempt = 0; attempt < 2; attempt++) {
    const progress = [];
    const parsed = await readRequestLogs(directory, start, { onProgress: value => progress.push(value) });
    assert.deepEqual(progress, ['filter', 'parse'].flatMap(phase => [0, 1, 2].map(completed => ({ phase, completed, total: 2 }))));
    assert.equal(parsed.requests.length, 2);
  }
});

test('empty log directories report completed progress', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quota-rollout-test-'));
  t.after(() => removeFixture(directory));
  const progress = [];
  const parsed = await readRequestLogs(directory, start, { onProgress: value => progress.push(value) });
  assert.deepEqual(progress, ['filter', 'parse'].map(phase => ({ phase, completed: 0, total: 0 })));
  assert.deepEqual(parsed, { requests: [], invalidRecords: 0 });
});

test('cancelling a scan rejects instead of returning partial usage and allows a clean retry', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quota-rollout-test-'));
  t.after(() => removeFixture(directory));
  await mkdir(path.join(directory, 'sessions'));
  for (const id of ['r1', 'r2']) {
    await writeFile(path.join(directory, 'sessions', `${id}.jsonl`),
      [meta(), turn('gpt-6-astra'), record(id)].join('\n'));
  }
  const controller = new AbortController();
  await assert.rejects(readRequestLogs(directory, start, {
    signal: controller.signal,
    onProgress: ({ phase, completed }) => { if (phase === 'parse' && completed === 1) controller.abort(); },
  }), { name: 'AbortError' });
  await assert.rejects(readRequestLogs(directory, start, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal((await readRequestLogs(directory, start)).requests.length, 2);
});

test('period screening skips old log bodies and only parses relevant sessions', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quota-rollout-test-'));
  t.after(() => removeFixture(directory));
  await mkdir(path.join(directory, 'sessions'));
  const old = path.join(directory, 'sessions', 'old.jsonl');
  const oldTail = `${line('event_msg', { type: 'task_complete' }, start - 1000)}\n`.repeat(1000);
  // Old damage outside the screened tail must not be parsed as current-period damage.
  await writeFile(old, `old damaged record\n${oldTail}`);
  await utimes(old, new Date(start - 1000), new Date(start - 1000));
  await writeFile(path.join(directory, 'sessions', 'current.jsonl'), [meta(), turn('gpt-6-astra'), record()].join('\n'));
  const progress = [];
  const parsed = await readRequestLogs(directory, start, { onProgress: value => progress.push(value) });
  assert.equal(parsed.requests.length, 1);
  assert.equal(parsed.invalidRecords, 0);
  assert.deepEqual(progress.filter(value => value.phase === 'parse'),
    [{ phase: 'parse', completed: 0, total: 1 }, { phase: 'parse', completed: 1, total: 1 }]);
});

test('an excluded old session is picked up after an append even when mtime stays old', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quota-rollout-test-'));
  t.after(() => removeFixture(directory));
  await mkdir(path.join(directory, 'sessions'));
  const file = path.join(directory, 'sessions', 'ongoing.jsonl');
  const since = start + 3600_000;
  await writeFile(file, [meta(), turn('gpt-6-astra'), record('old'), count(), ''].join('\n'));
  await utimes(file, new Date(start), new Date(start));
  assert.deepEqual(await readRequestLogs(directory, since), { requests: [], invalidRecords: 0 });
  await appendFile(file, [record('new', since), count(usage(200, 40, 20), since), ''].join('\n'));
  await utimes(file, new Date(start), new Date(start));
  const parsed = await readRequestLogs(directory, since);
  assert.equal(parsed.requests.length, 1);
  assert.equal(parsed.requests[0].at, since);
  assert.equal(parsed.requests[0].model, 'gpt-6-astra');
  assert.equal((await readRequestLogs(directory, start)).requests.length, 2, 'an earlier period invalidates the filtered cache');
});

test('recently modified logs retain current usage even when their tail replays older events', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quota-rollout-test-'));
  t.after(() => removeFixture(directory));
  await mkdir(path.join(directory, 'sessions'));
  const oldTail = `${line('event_msg', { type: 'task_complete' }, start - 1000)}\n`.repeat(1000);
  const file = path.join(directory, 'sessions', 'replay.jsonl');
  await writeFile(file, [meta(), turn('gpt-6-astra'), record(), count(), oldTail].join('\n'));
  await utimes(file, new Date(start + 2000), new Date(start + 2000));
  assert.equal((await readRequestLogs(directory, start)).requests.length, 1);
});

for (const [name, tail, invalidRecords] of [
  ['an incomplete final record', '{"timestamp":', 0],
  ['a damaged final record', '{broken}\n', 1],
  ['a line larger than the tail probe', line('event_msg', { type: 'task_complete', text: '中'.repeat(30_000) }, start - 1000), 0],
  ['a record without a usable timestamp', '{"type":"event_msg"}\n', 0],
]) {
  test(`period screening falls back to full parsing for ${name}`, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'quota-rollout-test-'));
    t.after(() => removeFixture(directory));
    await mkdir(path.join(directory, 'sessions'));
    const file = path.join(directory, 'sessions', 'uncertain.jsonl');
    const oldTail = `${line('event_msg', { type: 'task_complete' }, start - 1000)}\n`.repeat(1000);
    await writeFile(file, [meta(), turn('gpt-6-astra'), record(), count(), oldTail, tail].join('\n'));
    await utimes(file, new Date(start - 1000), new Date(start - 1000));
    const parsed = await readRequestLogs(directory, start);
    assert.equal(parsed.requests.length, 1);
    assert.equal(parsed.invalidRecords, invalidRecords);
  });
}

test('cancelling period screening stops before parsing candidate files', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quota-rollout-test-'));
  t.after(() => removeFixture(directory));
  await mkdir(path.join(directory, 'sessions'));
  await writeFile(path.join(directory, 'sessions', 'current.jsonl'), [meta(), turn('gpt-6-astra'), record()].join('\n'));
  const controller = new AbortController();
  const phases = [];
  await assert.rejects(readRequestLogs(directory, start, {
    signal: controller.signal,
    onProgress: ({ phase, completed }) => {
      phases.push(phase);
      if (phase === 'filter' && completed === 1) controller.abort();
    },
  }), { name: 'AbortError' });
  assert.ok(!phases.includes('parse'));
});

test('panel displays immediate period totals, model breakdown and extrapolated quota', () => {
  const current = { ...sample(), planType: 'pro', resetCredits: 2, errors: [], cost: null };
  const result = updateLedger(ledger(), current, scan([request('a')]));
  const text = renderSnapshot({ sample: current, estimates: result.estimates }, { details: true });
  assert.match(text, /本周期本机累计：110 tokens/);
  assert.match(text, /gpt-6-astra：110 tokens/);
  assert.match(text, /按本周期已用 10% 推算/);
  assert.doesNotMatch(text, /10 分钟、3 次采样/);
});
