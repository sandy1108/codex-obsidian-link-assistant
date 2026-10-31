import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_LOG_MAX_BYTES = 1024 * 1024;
const MAX_LOG_LINE_BYTES = 16 * 1024;

function boundedLine(line) {
  const body = line.endsWith('\n') ? line.slice(0, -1) : line;
  if (Buffer.byteLength(body, 'utf8') <= MAX_LOG_LINE_BYTES - 1) return `${body}\n`;
  let truncated = '';
  let bytes = 0;
  for (const character of body) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > MAX_LOG_LINE_BYTES - 1) break;
    truncated += character;
    bytes += size;
  }
  return `${truncated}\n`;
}

/**
 * 单文件追加日志：写前按大小轮转，只保留一个`.1`备份；日志失败静默，不改变调用方流程。
 * 同一writer内的写入串行化，避免并发轮转与追加交错。
 */
export function createLogWriter({ filePath, maxBytes = DEFAULT_LOG_MAX_BYTES } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new TypeError('日志路径必须是绝对路径');
  }
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('日志上限必须是正整数');
  }
  let queue = Promise.resolve();

  function append(line) {
    if (typeof line !== 'string' || line.length === 0) return queue;
    const bounded = boundedLine(line);
    queue = queue.then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      try {
        const info = await stat(filePath);
        if (info.isFile() && info.size > 0
          && info.size + Buffer.byteLength(bounded, 'utf8') > maxBytes) {
          await rm(`${filePath}.1`, { force: true });
          await rename(filePath, `${filePath}.1`);
        }
      } catch { /* 首次写入或无法读取旧日志时直接新建 */ }
      await appendFile(filePath, bounded, { encoding: 'utf8', mode: 0o600 });
    }).catch(() => {});
    return queue;
  }

  return { append, filePath };
}
