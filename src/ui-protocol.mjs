export const MAX_JSON_LINE_BYTES = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONFIRMATION_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;
const ACTIONS = new Set([
  'refresh', 'enable', 'confirmRestart', 'cancelConfirmation',
  'pause', 'resume', 'restoreOrdinary', 'shutdown',
]);
const CONFIRMATION_ACTIONS = new Set(['confirmRestart', 'cancelConfirmation']);

function protocolError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, requiredKeys, optionalKeys = []) {
  const keys = Object.keys(value);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  return requiredKeys.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function hasValidConfirmationId(value) {
  return typeof value === 'string' && CONFIRMATION_ID_PATTERN.test(value);
}

/** 校验UI到worker的单行协议；未知字段和任意路径/URI均在边界处拒绝。 */
export function parseWorkerRequest(line) {
  if (typeof line !== 'string') throw protocolError('INVALID_REQUEST');
  if (Buffer.byteLength(line, 'utf8') > MAX_JSON_LINE_BYTES) throw protocolError('MESSAGE_TOO_LARGE');
  if (line.includes('\n') || line.includes('\r')) throw protocolError('INVALID_REQUEST');

  let request;
  try { request = JSON.parse(line); } catch { throw protocolError('INVALID_JSON'); }
  if (!isRecord(request) || request.v !== 1 || request.type !== 'request'
    || !isUuid(request.id) || !ACTIONS.has(request.action)) {
    throw protocolError('INVALID_REQUEST');
  }

  const confirmationAction = CONFIRMATION_ACTIONS.has(request.action);
  const expectedKeys = confirmationAction
    ? ['v', 'type', 'id', 'action', 'confirmationId']
    : ['v', 'type', 'id', 'action'];
  if (!exactKeys(request, expectedKeys)
    || (confirmationAction && !hasValidConfirmationId(request.confirmationId))) {
    throw protocolError('INVALID_REQUEST');
  }
  return request;
}

function validWorkerMessage(message) {
  if (!isRecord(message) || message.v !== 1 || typeof message.type !== 'string') return false;
  switch (message.type) {
    case 'accepted':
      return exactKeys(message, ['v', 'type', 'id']) && isUuid(message.id);
    case 'error':
      return exactKeys(message, ['v', 'type', 'code'])
        && typeof message.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(message.code);
    case 'confirmationRequired':
      return exactKeys(message, ['v', 'type', 'requestId', 'confirmationId', 'reason', 'expiresInSeconds'])
        && isUuid(message.requestId)
        && hasValidConfirmationId(message.confirmationId)
        && ['restartOrdinaryCodex', 'restoreOrdinaryCodex'].includes(message.reason)
        && Number.isInteger(message.expiresInSeconds)
        && message.expiresInSeconds > 0 && message.expiresInSeconds <= 60;
    case 'state': {
      const required = ['v', 'type', 'seq', 'codex', 'cdp', 'worker', 'pageCount'];
      const optional = ['codexVersion', 'codexBuild', 'port', 'launchSource', 'errorCode'];
      return exactKeys(message, required, optional)
        && Number.isSafeInteger(message.seq) && message.seq >= 0
        && ['stopped', 'running', 'unknown'].includes(message.codex)
        && ['closed', 'verified', 'unknown'].includes(message.cdp)
        && ['observing', 'active', 'paused', 'stopping', 'error'].includes(message.worker)
        && Number.isInteger(message.pageCount) && message.pageCount >= 0 && message.pageCount <= 1000
        && (message.codexVersion === undefined || message.codexVersion === null
          || (typeof message.codexVersion === 'string' && /^\d+(?:\.\d+){1,4}$/u.test(message.codexVersion)))
        && (message.codexBuild === undefined || message.codexBuild === null
          || (typeof message.codexBuild === 'string' && /^\d{1,20}$/u.test(message.codexBuild)))
        && (message.port === undefined || message.port === null
          || (Number.isInteger(message.port) && message.port >= 1024 && message.port <= 65535))
        && (message.launchSource === undefined || ['none', 'app', 'external', 'unknown'].includes(message.launchSource))
        && (message.errorCode === undefined || message.errorCode === null
          || (typeof message.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(message.errorCode)));
    }
    case 'result':
      return exactKeys(message, ['v', 'type', 'id', 'ok', 'code'])
        && isUuid(message.id) && typeof message.ok === 'boolean'
        && typeof message.code === 'string' && /^[a-z][A-Za-z0-9-]{0,63}$/u.test(message.code);
    default:
      return false;
  }
}

/** worker只输出受限的固定消息结构，不允许把路径、URI或任意文本带入UI通道。 */
export function serializeWorkerMessage(message) {
  if (!validWorkerMessage(message)) throw protocolError('INVALID_MESSAGE');
  const line = JSON.stringify(message);
  if (Buffer.byteLength(line, 'utf8') > MAX_JSON_LINE_BYTES) throw protocolError('MESSAGE_TOO_LARGE');
  return line;
}
