import { execFile } from 'node:child_process';
import { open, mkdir, lstat, readFile, rename, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

const LOCK_FILE = 'assistant.lock';
const MAX_ACQUIRE_ATTEMPTS = 3;
const UNPARSEABLE_LOCK_GRACE_MS = 5_000;

const execFileAsync = promisify(execFile);

function lockError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validLockInput({ stateRoot, pid, processStartTime, token } = {}) {
  return typeof stateRoot === 'string' && path.isAbsolute(stateRoot)
    && Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff
    && typeof processStartTime === 'string' && processStartTime.length > 0
    && processStartTime.length <= 128 && !/[\r\n\0]/u.test(processStartTime)
    && typeof token === 'string' && /^[A-Za-z0-9_-]{8,128}$/u.test(token);
}

/** 读取任意进程的启动时间；ps正常查不到时返回null，其他失败向上抛出以免误判。 */
export async function readProcessStartTime(pid) {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]);
    return stdout.trim() || null;
  } catch (error) {
    if (error?.code === 1) return null;
    throw error;
  }
}

function validLockRecord(record) {
  return record !== null && typeof record === 'object'
    && record.version === 1
    && Number.isInteger(record.pid) && record.pid > 0 && record.pid <= 0x7fffffff
    && typeof record.processStartTime === 'string' && record.processStartTime.length > 0
    && record.processStartTime.length <= 128 && !/[\r\n\0]/u.test(record.processStartTime)
    && typeof record.token === 'string' && /^[A-Za-z0-9_-]{8,128}$/u.test(record.token);
}

async function readLockSnapshot(lockPath) {
  try {
    const [raw, stats] = await Promise.all([readFile(lockPath, 'utf8'), lstat(lockPath)]);
    let record = null;
    try { record = JSON.parse(raw); } catch { /* 半写入的锁按无法解析处理 */ }
    return { raw, mtimeMs: stats.mtimeMs, record: validLockRecord(record) ? record : null };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** 只有PID存活且启动时间一致才算锁的真实持有者，避免PID复用导致误判。 */
async function lockOwnerIsAlive(record) {
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if (error?.code !== 'EPERM') return false;
  }
  let actualStartTime;
  try { actualStartTime = await readProcessStartTime(record.pid); } catch { return true; }
  return actualStartTime !== null && actualStartTime === record.processStartTime;
}

/** 用rename原子移走旧锁，并核对移动后内容仍然是观察到的那份，避免误删并发写入的新锁。 */
async function removeStaleLock(lockPath, observedRaw) {
  const tombstone = `${lockPath}.stale-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await rename(lockPath, tombstone);
  } catch (error) {
    return error?.code === 'ENOENT';
  }
  try {
    const moved = await readFile(tombstone, 'utf8');
    if (moved !== observedRaw) {
      try { await link(tombstone, lockPath); } catch { /* 恢复失败时保留tombstone供人工检查 */ }
      return false;
    }
  } catch {
    return false;
  }
  try { await unlink(tombstone); } catch { /* 残留tombstone不影响锁路径 */ }
  return true;
}

async function isStaleLock(snapshot) {
  if (snapshot.record) return !(await lockOwnerIsAlive(snapshot.record));
  // 无法解析说明写入过程被中断；超过宽限期仍无人修复即视为损坏锁。
  return Date.now() - snapshot.mtimeMs >= UNPARSEABLE_LOCK_GRACE_MS;
}

/** 用O_EXCL实现跨CLI/App worker排他；仅清理已确认的僵尸锁，活跃锁一律拒绝。 */
export async function acquireAssistantLock(options) {
  if (!validLockInput(options)) throw lockError('INVALID_LOCK_DATA');
  const { stateRoot, pid, processStartTime, token } = options;
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const directory = await lstat(stateRoot);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw lockError('INVALID_STATE_DIRECTORY');

  const lockPath = path.join(stateRoot, LOCK_FILE);
  const record = { version: 1, pid, processStartTime, token };

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const snapshot = await readLockSnapshot(lockPath);
      if (!snapshot) continue;
      if (!(await isStaleLock(snapshot))) throw lockError('ASSISTANT_LOCK_HELD');
      if (!(await removeStaleLock(lockPath, snapshot.raw))) throw lockError('ASSISTANT_LOCK_HELD');
      continue;
    }

    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        let current;
        try { current = JSON.parse(await readFile(lockPath, 'utf8')); } catch { return; }
        if (current?.version !== 1 || current.pid !== pid
          || current.processStartTime !== processStartTime || current.token !== token) return;
        try { await unlink(lockPath); } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      },
    };
  }
  throw lockError('ASSISTANT_LOCK_HELD');
}
