import { stat } from 'node:fs/promises';

async function defaultStatFile(file) {
  try {
    const value = await stat(file, { bigint: true });
    // inode/大小/纳秒时间任一变化都会让签名与ASAR哈希结果失效。
    return `${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
  } catch {
    return null;
  }
}

function sameState(previous, next) {
  if (previous.length !== next.length) return false;
  return previous.every((value, index) => value === next[index]);
}

/**
 * 按文件元数据缓存耗时的兼容性核验结果。
 * 键是参与签名/版本判断的文件集合；同一进程内复用，文件变化或缺失时重新计算。
 */
export function createCompatibilityCache({ statFile = defaultStatFile, maxEntries = 8 } = {}) {
  const entries = new Map();
  return {
    async getOrCompute(paths, compute) {
      const key = paths.join('\u0000');
      const state = await Promise.all(paths.map((file) => statFile(file)));
      const cached = entries.get(key);
      if (cached && sameState(cached.state, state)) return cached.value;
      const value = await compute();
      entries.delete(key);
      entries.set(key, { state, value });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return value;
    },
  };
}
