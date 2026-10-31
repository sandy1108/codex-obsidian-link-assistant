import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

export const MAX_COMPATIBILITY_BYTES = 16 * 1024;

function manifestError() {
  const error = new Error('compatibility manifest unavailable');
  error.code = 'COMPATIBILITY_MISSING';
  return error;
}

/** 清单只接受普通文件且限制大小；缺失、符号链接、超限或JSON损坏统一失败关闭。 */
export async function readCompatibilityManifest(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw manifestError();
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_COMPATIBILITY_BYTES) {
      throw manifestError();
    }
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw manifestError();
    return parsed;
  } catch (error) {
    if (error?.code === 'COMPATIBILITY_MISSING') throw error;
    throw manifestError();
  }
}
