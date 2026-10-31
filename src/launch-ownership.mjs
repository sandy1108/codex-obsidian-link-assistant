import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

const OWNERSHIP_VERSION = 1;
const MAX_OWNERSHIP_BYTES = 4096;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * 保存“由本助手启动的Codex”进程指纹，供App重启后仍能恢复普通Codex。
 * 只接受固定字段的普通文件；读取失败或格式不符一律视为无记录，绝不回退到猜测。
 */
export function createLaunchOwnershipStore({ stateRoot } = {}) {
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)) {
    throw new TypeError('stateRoot必须是绝对路径');
  }
  const filePath = path.join(stateRoot, 'launch-ownership.json');
  let queue = Promise.resolve();

  function enqueue(task) {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  }

  async function read() {
    await queue;
    try {
      // O_NOFOLLOW避免lstat之后文件被换成符号链接的竞态；大小检查和读取使用同一描述符。
      const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      let raw;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_OWNERSHIP_BYTES) return null;
        raw = JSON.parse(await handle.readFile('utf8'));
      } finally {
        await handle.close();
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      if (Object.keys(raw).length !== 3 || raw.version !== OWNERSHIP_VERSION
        || typeof raw.fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(raw.fingerprint)
        || typeof raw.recordedAt !== 'string' || raw.recordedAt.length > 64) return null;
      return raw.fingerprint;
    } catch {
      return null;
    }
  }

  function remember(fingerprint) {
    if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) {
      return Promise.reject(new TypeError('进程指纹格式无效'));
    }
    const document = {
      version: OWNERSHIP_VERSION,
      fingerprint,
      recordedAt: new Date().toISOString(),
    };
    const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    return enqueue(async () => {
      try {
        await mkdir(stateRoot, { recursive: true, mode: 0o700 });
        await writeFile(temporaryPath, `${JSON.stringify(document)}\n`, {
          encoding: 'utf8', mode: 0o600, flag: 'wx',
        });
        await rename(temporaryPath, filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => {});
        throw error;
      }
    });
  }

  function forget() {
    return enqueue(() => rm(filePath, { force: true }));
  }

  return { read, remember, forget, filePath };
}

/** 只有可信CDP端点及同一进程指纹同时成立，持久化记录才能恢复“本助手启动”身份。 */
export async function isOwnedVerifiedProcess({ endpoint, fingerprint, store }) {
  if (!endpoint || typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) {
    return false;
  }
  return (await store.read()) === fingerprint;
}
