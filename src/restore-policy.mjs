/**
 * 恢复普通Codex前的统一前置条件：已验证CDP、确由本助手启动、指纹与确认目标一致。
 * 返回固定错误码或null；调用方在停止注入前后各检查一次，避免引用已变化的进程。
 */
export function restorePrecondition(current, targetFingerprint) {
  if (!current || current.mode !== 'cdp-ready' || current.restoreAllowed !== true) {
    return 'PROCESS_CHANGED';
  }
  if (typeof targetFingerprint !== 'string' || targetFingerprint.length === 0
    || current.processFingerprint !== targetFingerprint) {
    return 'PROCESS_CHANGED';
  }
  return null;
}
