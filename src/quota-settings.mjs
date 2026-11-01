import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_QUOTA_REFRESH_MINUTES = 5;
export function validQuotaRefreshMinutes(value) {
  return Number.isInteger(value) && value >= 1 && value <= 60;
}

/** 独立于Vault配置，避免迁移已有settings.json；仅保存1–60分钟整数。 */
export function createQuotaSettingsStore({ stateRoot }) {
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)) throw new TypeError('stateRoot必须为绝对路径');
  const settingsPath = path.join(stateRoot, 'quota-settings.json');
  async function read() {
    try {
      const info = await lstat(settingsPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('invalid');
      const value = JSON.parse(await readFile(settingsPath, 'utf8'));
      if (Object.keys(value).length !== 2 || value.version !== 1
        || !validQuotaRefreshMinutes(value.refreshMinutes)) throw new Error('invalid');
      return { refreshMinutes: value.refreshMinutes };
    } catch { return { refreshMinutes: DEFAULT_QUOTA_REFRESH_MINUTES }; }
  }
  async function save(refreshMinutes) {
    if (!validQuotaRefreshMinutes(refreshMinutes)) throw new TypeError('刷新间隔必须为1–60分钟');
    const temporary = `${settingsPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await mkdir(stateRoot, { recursive: true, mode: 0o700 });
      await writeFile(temporary, `${JSON.stringify({ version: 1, refreshMinutes })}\n`, {
        mode: 0o600, flag: 'wx',
      });
      await rename(temporary, settingsPath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    const saved = await read();
    if (saved.refreshMinutes !== refreshMinutes) throw new Error('刷新间隔保存后核对失败');
    return saved;
  }
  return { read, save, settingsPath };
}
