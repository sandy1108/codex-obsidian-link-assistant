import { open, mkdir, lstat, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const LOCK_FILE = 'assistant.lock';

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

/** 用O_EXCL实现跨CLI/App worker排他；不自动抢占任何现存锁。 */
export async function acquireAssistantLock(options) {
  if (!validLockInput(options)) throw lockError('INVALID_LOCK_DATA');
  const { stateRoot, pid, processStartTime, token } = options;
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const directory = await lstat(stateRoot);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw lockError('INVALID_STATE_DIRECTORY');

  const lockPath = path.join(stateRoot, LOCK_FILE);
  const record = { version: 1, pid, processStartTime, token };
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw lockError('ASSISTANT_LOCK_HELD');
    throw error;
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
