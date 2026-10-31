import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_JSON_LINE_BYTES, parseWorkerRequest, serializeWorkerMessage } from './ui-protocol.mjs';
import { acquireAssistantLock } from './single-instance-lock.mjs';
import { createManagedAssistant } from './managed-assistant.mjs';
import { ASSISTANT_STATE_ROOT, appendAssistantLog, createCodexRuntime, getCurrentProcessStartTime } from './main.mjs';
import { createVaultSettingsStore } from './vault-settings.mjs';
import { isDirectExecution } from './entry-point.mjs';

const MAX_REQUEST_IDS_PER_WORKER = 4096;
const STARTUP_ERROR_CODES = new Set([
  'ASSISTANT_LOCK_HELD', 'INVALID_LOCK_DATA', 'INVALID_STATE_DIRECTORY',
  'PROCESS_IDENTITY_UNAVAILABLE', 'COMPATIBILITY_MISSING', 'CODEX_NOT_FOUND',
  'SIGNATURE_MISMATCH', 'VERSION_UNSUPPORTED', 'PROCESS_AMBIGUOUS', 'CDP_UNTRUSTED',
  'CDP_TIMEOUT', 'PROCESS_CHANGED', 'PROCESS_EXIT_TIMEOUT', 'CODEX_LAUNCH_FAILED',
  'INJECTION_FAILED', 'WORKER_STOPPING', 'STATE_UNAVAILABLE', 'RUNTIME_ERROR',
  'VAULT_NOT_CONFIGURED', 'VAULT_SETTINGS_INVALID', 'VAULT_DIRECTORY_INVALID',
  'VAULT_SETTINGS_WRITE_FAILED', 'VAULT_APPLY_FAILED',
]);

async function writeMessage(stdout, message) {
  const line = `${serializeWorkerMessage(message)}\n`;
  if (!stdout.write(line, 'utf8')) await once(stdout, 'drain');
}

function safeResultCode(error) {
  if (typeof error?.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)) return 'runtime-error';
  return error.code.toLowerCase().replaceAll('_', '-');
}

/** 日志里只接受固定形态的代码，避免把任意输入写入日志行。 */
function logToken(value) {
  if (typeof value !== 'string') return 'unexpected';
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value) ? value : 'unexpected';
}

/** 逐字节读取有限长度JSONL；超长行丢弃至换行，避免把任意输入交给状态机。 */
export async function runWorker({ stdin, stdout, assistant, logger = appendAssistantLog }) {
  if (!stdin || !stdout || typeof assistant?.dispatch !== 'function'
    || typeof assistant?.setEmitter !== 'function') {
    throw new TypeError('worker requires streams and a managed assistant');
  }

  assistant.setEmitter((message) => writeMessage(stdout, message));
  const seen = new Map();
  let chunks = [];
  let bufferedBytes = 0;
  let discardingOversizedLine = false;
  let shutdownRequested = false;

  async function emitParseError(code) {
    await logger('request-rejected', `code=${logToken(code)}`);
    await writeMessage(stdout, { v: 1, type: 'error', code });
  }

  /** 每个用户动作都记录开始和结果；失败码来自状态机的固定错误码。 */
  async function dispatchLogged(request) {
    const startedAt = Date.now();
    try {
      const result = await assistant.dispatch(request);
      const code = logToken(result?.code);
      await logger(result?.ok === true ? 'action-result' : 'action-failed',
        `action=${logToken(request.action)} code=${code} ms=${Date.now() - startedAt}`);
      return result;
    } catch (error) {
      await logger('action-failed',
        `action=${logToken(request.action)} code=${logToken(error?.code)} ms=${Date.now() - startedAt}`);
      throw error;
    }
  }

  async function processLine(line) {
    let request;
    try { request = parseWorkerRequest(line); } catch (error) {
      await emitParseError(error?.code ?? 'INVALID_REQUEST');
      return;
    }

    if (seen.has(request.id)) {
      const previousResult = seen.get(request.id);
      if (previousResult) await writeMessage(stdout, previousResult);
      return;
    }
    if (seen.size >= MAX_REQUEST_IDS_PER_WORKER) {
      await logger('request-rejected', 'code=REQUEST_CAPACITY_REACHED');
      await writeMessage(stdout, { v: 1, type: 'accepted', id: request.id });
      await writeMessage(stdout, { v: 1, type: 'result', id: request.id, ok: false, code: 'request-capacity-reached' });
      return;
    }

    seen.set(request.id, null);
    await logger('action-received', `action=${logToken(request.action)}`);
    await writeMessage(stdout, { v: 1, type: 'accepted', id: request.id });
    let resultMessage;
    if (shutdownRequested) {
      resultMessage = { v: 1, type: 'result', id: request.id, ok: false, code: 'worker-stopping' };
    } else {
      try {
        const result = await dispatchLogged(request);
        resultMessage = {
          v: 1,
          type: 'result',
          id: request.id,
          ok: result?.ok === true,
          code: typeof result?.code === 'string' ? result.code : 'runtime-error',
        };
      } catch (error) {
        resultMessage = { v: 1, type: 'result', id: request.id, ok: false, code: safeResultCode(error) };
      }
    }
    seen.set(request.id, resultMessage);
    await writeMessage(stdout, resultMessage);
    if (request.action === 'shutdown' && resultMessage.ok) shutdownRequested = true;
  }

  async function processSegment(segment, hasNewline) {
    if (discardingOversizedLine) {
      if (hasNewline) {
        discardingOversizedLine = false;
        await emitParseError('MESSAGE_TOO_LARGE');
      }
      return;
    }

    if (bufferedBytes + segment.length > MAX_JSON_LINE_BYTES) {
      chunks = [];
      bufferedBytes = 0;
      if (hasNewline) await emitParseError('MESSAGE_TOO_LARGE');
      else discardingOversizedLine = true;
      return;
    }

    if (segment.length) {
      chunks.push(Buffer.from(segment));
      bufferedBytes += segment.length;
    }
    if (hasNewline) {
      const line = Buffer.concat(chunks, bufferedBytes).toString('utf8');
      chunks = [];
      bufferedBytes = 0;
      await processLine(line);
    }
  }

  for await (const inputChunk of stdin) {
    const chunk = Buffer.isBuffer(inputChunk) ? inputChunk : Buffer.from(inputChunk);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline;
      await processSegment(chunk.subarray(offset, end), newline >= 0);
      if (newline < 0) break;
      offset = newline + 1;
    }
  }

  if (discardingOversizedLine) await emitParseError('MESSAGE_TOO_LARGE');
  else if (bufferedBytes) await processLine(Buffer.concat(chunks, bufferedBytes).toString('utf8'));

  if (!shutdownRequested) {
    try { await assistant.shutdown(); } catch (error) {
      const code = /^[A-Z][A-Z0-9_]{0,63}$/u.test(error?.code ?? '') ? error.code : 'RUNTIME_ERROR';
      await logger('shutdown-failed', `code=${logToken(code)}`);
      await writeMessage(stdout, { v: 1, type: 'error', code });
    }
  }
}

function fixedStartupCode(error) {
  return STARTUP_ERROR_CODES.has(error?.code) ? error.code : 'RUNTIME_ERROR';
}

async function loadCompatibility() {
  // 打包时ui-worker位于Resources/worker/src，兼容清单固定放在Resources/worker。
  const compatibilityPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'compatibility.json');
  try { return JSON.parse(await readFile(compatibilityPath, 'utf8')); } catch {
    const error = new Error('compatibility file unavailable');
    error.code = 'COMPATIBILITY_MISSING';
    throw error;
  }
}

async function startUiWorker() {
  let lock;
  let assistant;
  await appendAssistantLog('worker-starting', `pid=${process.pid}`);
  try {
    lock = await acquireAssistantLock({
      stateRoot: ASSISTANT_STATE_ROOT,
      pid: process.pid,
      processStartTime: await getCurrentProcessStartTime(),
      token: randomBytes(32).toString('hex'),
    });
    const vaultSettingsStore = createVaultSettingsStore({ stateRoot: ASSISTANT_STATE_ROOT });
    const runtime = createCodexRuntime({
      compatibility: await loadCompatibility(),
      vaultSettingsStore,
      // Codex退出后supervisor会自行结束；把真实观察态推送回浮窗，避免界面残留active。
      onSupervisorExit: () => { void assistant?.supervisorExited().catch(() => {}); },
    });
    assistant = createManagedAssistant({ runtime, tokenFactory: () => randomBytes(32).toString('hex') });
    process.once('SIGTERM', () => process.stdin.destroy());
    try {
      await assistant.refresh();
    } catch (error) {
      // 状态错误已作为固定状态消息写到stdout；这里补日志，仍等用户操作。
      await appendAssistantLog('initial-refresh-failed', `code=${logToken(error?.code)}`);
    }
    await runWorker({ stdin: process.stdin, stdout: process.stdout, assistant });
    await appendAssistantLog('worker-stopped', 'reason=input-closed');
  } catch (error) {
    await appendAssistantLog('worker-startup-failed', `code=${logToken(fixedStartupCode(error))}`);
    try {
      process.stdout.write(`${serializeWorkerMessage({ v: 1, type: 'error', code: fixedStartupCode(error) })}\n`);
    } catch { /* stdout关闭时保留原退出状态，不转写原始错误文本 */ }
    process.exitCode = 1;
  } finally {
    if (assistant) {
      try { await assistant.shutdown(); } catch { /* 退出路径不掩盖最初的固定错误码 */ }
    }
    try { await lock?.release(); } catch { process.exitCode = 1; }
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) void startUiWorker();
