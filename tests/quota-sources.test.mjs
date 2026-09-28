import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fingerprint, normalizeLimits, readLocalContext } from '../src/quota-sources.mjs';

const window = (usedPercent, minutes = 10080) => ({ usedPercent, windowDurationMins: minutes, resetsAt: 1_900_000_000 });

test('uses window duration rather than assuming primary means 5h; buckets stay separate', () => {
  const result = normalizeLimits({ rateLimits: { primary: window(90) }, rateLimitsByLimitId: {
    codex: { primary: window(6), secondary: null },
    spark: { primary: window(0, 300), secondary: window(0) },
  } });
  assert.equal(result.length, 3);
  assert.equal(result.find(x => x.limitId === 'codex').windowDurationMins, 10080);
  assert.equal(result.find(x => x.limitId === 'codex').remainingPercent, 94);
  assert.equal(result.filter(x => x.limitId === 'codex' && x.windowDurationMins === 300).length, 0);
});

test('null or malformed values never become zero usage or unlimited', () => {
  assert.deepEqual(normalizeLimits({ rateLimits: { primary: { usedPercent: null, windowDurationMins: 300 } } }), []);
  assert.deepEqual(normalizeLimits({ rateLimits: { primary: window(101) } }), []);
  assert.deepEqual(normalizeLimits({ rateLimitsByLimitId: {}, rateLimits: { primary: window(0) } }), []);
});

test('local context exposes only account and configuration fingerprints', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quota-context-test-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('quota-context-test-')) {
      throw new Error('Unexpected fixture path');
    }
    await rm(resolved, { recursive: true, force: true });
  });
  assert.deepEqual(await readLocalContext(directory), { accountKey: null, configKey: fingerprint('') });
  await writeFile(path.join(directory, 'auth.json'), JSON.stringify({ tokens: { account_id: 'example-account' } }));
  const config = 'model = "example-model"\n';
  await writeFile(path.join(directory, 'config.toml'), config);
  const context = await readLocalContext(directory);
  assert.deepEqual(context, { accountKey: fingerprint('example-account'), configKey: fingerprint(config) });
  assert.doesNotMatch(JSON.stringify(context), /example-account|example-model/);
});
