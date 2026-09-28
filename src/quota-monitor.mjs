import { mkdir, readFile, writeFile, appendFile, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadLedger, saveLedger, updateLedger } from './quota-ledger.mjs';
import { findCodexExecutable, projectDir } from './quota-sources.mjs';
import { fingerprint } from './fingerprint.mjs';
import { collectSnapshot } from './quota-collector.mjs';
import { writeSnapshot, writeProgress, createRefreshControl } from './quota-terminal.mjs';

export { renderSnapshot, writeSnapshot, writeProgress, createRefreshControl } from './quota-terminal.mjs';

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
      const { sample, scanned } = await collectSnapshot(executable, codexHome, controller.signal, progress);
      if (controller.signal.aborted) break;
      progress('正在汇总并保存本轮结果…');
      const result = updateLedger(saved, sample, scanned);
      saved = result.state;
      const snapshot = { sample, estimates: result.estimates };
      await appendFile(path.join(dataDir, 'samples.jsonl'), `${JSON.stringify(snapshot)}\n`);
      await saveLedger(path.join(dataDir, 'ledger.json'), saved);
      await writeFile(path.join(dataDir, 'latest.json'), JSON.stringify(snapshot, null, 2));
      writeSnapshot(snapshot, { ...values, manualRefresh: refresh.enabled });
      if (!values.watch) {
        if (sample.errors.length) process.exitCode = 1;
        break;
      }
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
