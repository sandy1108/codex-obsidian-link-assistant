import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** 只让直接执行的模块启动CLI；worker和测试导入时不触发Codex副作用。 */
export function isDirectExecution(moduleUrl, executablePath) {
  if (typeof moduleUrl !== 'string' || typeof executablePath !== 'string' || !executablePath) return false;
  try {
    return fileURLToPath(moduleUrl) === path.resolve(executablePath);
  } catch {
    return false;
  }
}
