import { randomBytes } from 'node:crypto';
import { access, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

export const DEFAULT_VAULT_ROOT = '/Users/example/ExampleVault';
const SETTINGS_VERSION = 1;
const MAX_SETTINGS_BYTES = 16 * 1024;

function settingsError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function validatedRoot(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)
    || candidate.length > 8192 || /[\u0000-\u001f\u007f]/u.test(candidate)) {
    throw settingsError('VAULT_DIRECTORY_INVALID');
  }
  try {
    const root = await realpath(candidate);
    if (root === path.parse(root).root) throw settingsError('VAULT_DIRECTORY_INVALID');
    const rootStat = await stat(root);
    const obsidianStat = await stat(path.join(root, '.obsidian'));
    await access(root, fsConstants.R_OK | fsConstants.X_OK);
    if (!rootStat.isDirectory() || !obsidianStat.isDirectory()) {
      throw settingsError('VAULT_DIRECTORY_INVALID');
    }
    return { vaultRoot: root, vaultName: path.basename(root) };
  } catch (error) {
    if (error?.code === 'VAULT_DIRECTORY_INVALID') throw error;
    throw settingsError('VAULT_DIRECTORY_INVALID');
  }
}

/**
 * Vault配置只由worker写入；临时文件与settings.json同目录，使用rename原子替换。
 */
export function createVaultSettingsStore({ stateRoot, recommendedVaultRoot = DEFAULT_VAULT_ROOT } = {}) {
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)) {
    throw new TypeError('stateRoot必须是绝对路径');
  }
  const settingsPath = path.join(stateRoot, 'settings.json');
  let revision = 0;

  async function read() {
    let raw;
    try {
      const info = await lstat(settingsPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SETTINGS_BYTES) {
        return {
          configured: false, vaultRoot: null, vaultName: null,
          recommendedVaultRoot, errorCode: 'VAULT_SETTINGS_INVALID',
        };
      }
      raw = JSON.parse(await readFile(settingsPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return {
          configured: false, vaultRoot: null, vaultName: null,
          recommendedVaultRoot, errorCode: 'VAULT_NOT_CONFIGURED',
        };
      }
      return {
        configured: false, vaultRoot: null, vaultName: null,
        recommendedVaultRoot, errorCode: 'VAULT_SETTINGS_INVALID',
      };
    }

    if (!raw || Object.keys(raw).length !== 2 || raw.version !== SETTINGS_VERSION
      || typeof raw.vaultRoot !== 'string' || !path.isAbsolute(raw.vaultRoot)) {
      return {
        configured: false, vaultRoot: null, vaultName: null,
        recommendedVaultRoot, errorCode: 'VAULT_SETTINGS_INVALID',
      };
    }
    try {
      const canonical = await validatedRoot(raw.vaultRoot);
      return { configured: true, ...canonical, recommendedVaultRoot: null, errorCode: null };
    } catch {
      return {
        configured: false,
        vaultRoot: raw.vaultRoot,
        vaultName: path.basename(raw.vaultRoot),
        recommendedVaultRoot: null,
        errorCode: 'VAULT_DIRECTORY_INVALID',
      };
    }
  }

  async function save(candidate) {
    const validated = await validatedRoot(candidate);
    const temporaryPath = `${settingsPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      // 目录创建、临时文件写入和原子替换统一映射为UI可识别的固定错误码。
      await mkdir(stateRoot, { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, `${JSON.stringify({ version: SETTINGS_VERSION, vaultRoot: validated.vaultRoot })}\n`, {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      });
      await rename(temporaryPath, settingsPath);
    } catch {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw settingsError('VAULT_SETTINGS_WRITE_FAILED');
    }
    // 重读验证落盘结果，避免向UI报告未实际保存的配置。
    const saved = await read();
    if (!saved.configured || saved.vaultRoot !== validated.vaultRoot) {
      throw settingsError('VAULT_SETTINGS_WRITE_FAILED');
    }
    revision += 1;
    return saved;
  }

  return { read, save, settingsPath, get revision() { return revision; } };
}
