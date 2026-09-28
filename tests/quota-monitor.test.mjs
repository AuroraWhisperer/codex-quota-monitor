import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import xterm from '@xterm/headless';
import { createRefreshControl, renderSnapshot, writeSnapshot, writeProgress } from '../src/quota-monitor.mjs';

function snapshot(accountKey, full = true) {
  const at = Date.UTC(2026, 0, 8, 9);
  const windows = full ? [
    { limitId: 'spark', limitName: 'GPT-5.3-Codex-Spark', windowDurationMins: 300, usedPercent: 0 },
    { limitId: 'spark', limitName: 'GPT-5.3-Codex-Spark', windowDurationMins: 10080, usedPercent: 0 },
    { limitId: 'codex', limitName: 'codex', windowDurationMins: 10080, usedPercent: 10 },
  ].map(value => ({ ...value, resetsAt: at / 1000 + value.windowDurationMins * 60 })) : [];
  return {
    sample: { at, accountKey, planType: 'pro', windows, credits: full ? '100.5' : null, resetCredits: full ? 2 : null, errors: [] },
    estimates: Object.fromEntries(windows.map(value => [`${value.limitId}:${value.windowDurationMins}`, {
      status: 'period-estimated', startsAt: at, totalTokens: 1000, requests: 1, costUsdRange: [1, 1],
      totalUsdRange: [10, 10], remainingUsdRange: [9, 9], historyBound: true, providers: ['openai'],
      models: value.limitId === 'codex' ? ['gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.6-sol'].map(model => ({
        model, totalTokens: 1000, minimumUsd: 1, maximumUsd: 1,
        inputTokens: 400, cacheReadTokens: 500, cacheCreationTokens: 0, outputTokens: 100,
      })) : [],
    }])),
  };
}

function capture(value, options, isTTY = true) {
  let text = '';
  writeSnapshot(value, options, { isTTY, write(chunk) { text += chunk; return true; } });
  return text;
}

test('terminal rendering differentiates unknown quotas, credits, and estimates', () => {
  const value = snapshot('example-account', false);
  Object.assign(value.sample, { credits: '100.5', resetCredits: 2, errors: ['查询失败'] });
  const text = renderSnapshot(value);
  assert.match(text, /5 小时：接口未返回/);
  assert.match(text, /周限额：接口未返回/);
  assert.match(text, /100\.5 credits/);
  assert.match(text, /额外 credits（独立于周限／5h）/);
  assert.doesNotMatch(text, /\$100\.5/);
  assert.match(text, /查询失败/);
});

test('expired upstream percentages are not rendered as current progress', () => {
  const value = snapshot('example-account');
  value.sample.windows = [{ limitId: 'codex', limitName: 'codex', usedPercent: 92,
    windowDurationMins: 10080, resetsAt: value.sample.at / 1000 - 1 }];
  const text = renderSnapshot(value);
  assert.match(text, /窗口已到期，当前进度待刷新/);
  assert.doesNotMatch(text, /已用 92%/);
});

test('pending period estimates explain the actual blockers instead of unrelated missing data', () => {
  const cases = [
    [{ quotaDiscontinuity: true }, /额度比例回退或重置券减少/],
    [{ creditsChanged: true }, /额外 credits 发生变化/],
    [{ invalidRecords: 1 }, /用量日志不完整/],
    [{ historyBound: false }, /账号周期历史未完整绑定/],
    [{ unpriced: 1 }, /部分请求尚不可定价/],
    [{ requests: 0 }, /尚无本周期请求记录/],
  ];
  for (const [fields, reason] of cases) {
    const value = snapshot('pending');
    Object.assign(value.estimates['codex:10080'], fields, { status: 'period-pending', totalUsdRange: null });
    const line = renderSnapshot(value).split('\n').find(line => line.includes('满额估算：'));
    assert.match(line, reason);
    assert.doesNotMatch(line, /等待非零额度比例/);
  }
  const value = snapshot('zero');
  value.sample.windows.find(window => window.limitId === 'codex').usedPercent = 0;
  value.estimates['codex:10080'].status = 'period-pending';
  assert.match(renderSnapshot(value), /等待额度已用比例大于 0%/);
});

function bufferText(terminal) {
  const buffer = terminal.buffer.active;
  return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index).translateToString(true)).join('\n').trimEnd();
}

test('the entry point prints startup status before executable discovery', { timeout: 5000 }, async () => {
  const entry = fileURLToPath(new URL('../src/quota-monitor.mjs', import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, [
    '--import=data:text/javascript,process.stdout.isTTY=true', entry, '--watch',
  ], {
    env: { ...process.env, PATH: '', CODEX_BIN: '' }, windowsHide: true, timeout: 4000,
  }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /正在启动 Codex 账号额度监控/);
    assert.match(error.stderr, /找不到 Codex 原生程序|第一版支持 Windows/);
    return true;
  });
});

test('startup progress appears immediately and replaces the previous status line', async t => {
  const terminal = new xterm.Terminal({ cols: 100, rows: 24, convertEol: true, allowProposedApi: true });
  t.after(() => terminal.dispose());
  const write = promisify(terminal.write.bind(terminal));
  let text = '';
  const output = { isTTY: true, write(chunk) { text += chunk; } };
  writeProgress('正在启动 Codex 账号额度监控，请稍候…', { watch: true }, output);
  assert.match(text, /正在启动/);
  await write(text);
  assert.match(bufferText(terminal), /正在启动/);
  text = '';
  writeProgress('正在扫描：1 / 20', { watch: true }, output);
  await write(text);
  assert.equal(bufferText(terminal), '正在扫描：1 / 20');
  await write(capture(snapshot('ready'), { watch: true }));
  assert.doesNotMatch(bufferText(terminal), /正在扫描|正在启动/);
  assert.match(bufferText(terminal), /Codex 账号额度监控/);
});

test('single queries, JSON and redirected output do not contain progress', () => {
  for (const [options, isTTY] of [[{}, true], [{ watch: true, json: true }, true],
    [{ watch: true }, false], [{ watch: true, json: true }, false]]) {
    let text = '';
    writeProgress('正在启动', options, { isTTY, write(chunk) { text += chunk; } });
    assert.equal(text, '');
  }
});

for (const [name, cols, rows, shrink, resize] of [
  ['reports taller than the viewport', 200, 30, false, false],
  ['a shorter report following a tall report', 200, 24, true, false],
  ['Chinese text wrapping in a narrow window', 60, 12, false, false],
  ['the terminal being resized between refreshes', 160, 30, false, true],
]) {
  test(`watch replaces both screen and scrollback after ${name}`, async t => {
    const terminal = new xterm.Terminal({ cols, rows, convertEol: true, allowProposedApi: true });
    t.after(() => terminal.dispose());
    const write = promisify(terminal.write.bind(terminal));
    await write(capture(snapshot('old'), { watch: true, details: true }));
    assert.ok(terminal.buffer.active.baseY > 0, 'the old heading must scroll outside the viewport');
    if (resize) terminal.resize(50, 10);
    for (let index = 0; index < 3; index++) {
      const current = snapshot(`new${index}`, !shrink);
      await write(capture(current, { watch: true }));
      const text = bufferText(terminal);
      assert.equal(text.match(/Codex 账号额度监控/g)?.length, 1, 'only the current heading remains, including scrollback');
      assert.equal(text.replace(/\s/g, ''), renderSnapshot(current).replace(/\s/g, ''));
    }
  });
}

test('single snapshots and redirected watch output remain plain text', () => {
  const value = snapshot('single');
  for (const [options, isTTY] of [[{}, true], [{ watch: true }, false], [{ details: true }, true]]) {
    assert.equal(capture(value, options, isTTY), `${renderSnapshot(value, options)}\n`);
  }
});

test('JSON watch output remains newline-delimited JSON in terminals and pipes', () => {
  const values = [snapshot('first'), snapshot('second')];
  for (const isTTY of [true, false]) {
    const output = values.map(value => capture(value, { watch: true, json: true }, isTTY)).join('');
    assert.deepEqual(output.trimEnd().split('\n').map(line => JSON.parse(line)), values);
  }
});

function refreshFixture(t, { options = { watch: true }, inputTTY = true, outputTTY = true, isRaw = false } = {}) {
  const input = new PassThrough();
  input.isTTY = inputTTY;
  input.isRaw = isRaw;
  input.setRawMode = value => { input.isRaw = value; };
  const controller = new AbortController();
  const refresh = createRefreshControl(options, controller, input, { isTTY: outputTTY });
  t.after(() => { controller.abort(); refresh.close(); input.destroy(); });
  return { input, controller, refresh };
}

test('1, r, R and Enter immediately wake a scheduled refresh without aborting the monitor', { timeout: 2000 }, async t => {
  const { input, controller, refresh } = refreshFixture(t);
  assert.equal(input.isRaw, true);
  for (const key of ['1', 'r', 'R', '\r', '\n']) {
    const waiting = refresh.wait(60_000);
    input.write(key);
    await waiting;
    assert.equal(controller.signal.aborted, false);
  }
});

test('refresh keys received during collection coalesce into one subsequent refresh', { timeout: 2000 }, async t => {
  const { input, refresh } = refreshFixture(t);
  input.write('111\r\n');
  input.write('R');
  await refresh.wait(60_000);
  let completed = false;
  const waiting = refresh.wait(60_000).then(() => { completed = true; });
  await nextTurn();
  assert.equal(completed, false, 'the burst must not queue another refresh');
  input.write('1');
  await waiting;
});

test('automatic refresh still runs after a manual refresh', { timeout: 2000 }, async t => {
  const { input, refresh } = refreshFixture(t);
  const manual = refresh.wait(60_000);
  input.write('1');
  await manual;
  await refresh.wait(1);
});

test('unrelated keys do not refresh, and Ctrl+C cancels the current wait', { timeout: 2000 }, async t => {
  const { input, controller, refresh } = refreshFixture(t);
  let completed = false;
  const waiting = refresh.wait(60_000).then(() => { completed = true; });
  for (const key of ['2', 'x', '\x1b[A', '\x1b[11~']) input.write(key);
  await nextTurn();
  assert.equal(completed, false);
  const stopped = assert.rejects(waiting, { name: 'AbortError' });
  input.write('\x03');
  await stopped;
  assert.equal(controller.signal.aborted, true);
});

test('Ctrl+C during collection cancels the monitor even with a refresh queued', async t => {
  const { input, controller, refresh } = refreshFixture(t);
  input.write('1');
  input.write('\x03');
  assert.equal(controller.signal.aborted, true);
  await assert.rejects(refresh.wait(60_000), { name: 'AbortError' });
});

test('external cancellation wakes the scheduled refresh and terminal cleanup restores input', { timeout: 2000 }, async t => {
  for (const isRaw of [false, true]) {
    const { input, controller, refresh } = refreshFixture(t, { isRaw });
    const stopped = assert.rejects(refresh.wait(60_000), { name: 'AbortError' });
    controller.abort();
    await stopped;
    refresh.close();
    assert.equal(input.isRaw, isRaw);
    assert.equal(input.listenerCount('data'), 0);
    assert.equal(input.isPaused(), true);
  }
});

test('single queries, JSON and redirected input or output never enable keyboard capture', async t => {
  for (const settings of [{ options: {} }, { options: { watch: true, json: true } }, { inputTTY: false }, { outputTTY: false }]) {
    const { input, refresh } = refreshFixture(t, settings);
    assert.equal(refresh.enabled, false);
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount('data'), 0);
    assert.equal(input.readableFlowing, null);
    await refresh.wait(1);
  }
});

test('interactive reports explain the manual refresh shortcuts', () => {
  assert.match(capture(snapshot('manual'), { watch: true, manualRefresh: true }), /1.*R.*回车.*刷新/);
  assert.doesNotMatch(capture(snapshot('single'), {}), /回车/);
});
