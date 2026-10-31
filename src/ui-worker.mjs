import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_JSON_LINE_BYTES, parseWorkerRequest, serializeWorkerMessage } from './ui-protocol.mjs';
import { acquireAssistantLock } from './single-instance-lock.mjs';
import { createManagedAssistant } from './managed-assistant.mjs';
import { ASSISTANT_STATE_ROOT, createCodexRuntime, getCurrentProcessStartTime } from './main.mjs';
import { isDirectExecution } from './entry-point.mjs';

const MAX_REQUEST_IDS_PER_WORKER = 4096;
const STARTUP_ERROR_CODES = new Set([
  'ASSISTANT_LOCK_HELD', 'INVALID_LOCK_DATA', 'INVALID_STATE_DIRECTORY',
  'PROCESS_IDENTITY_UNAVAILABLE', 'COMPATIBILITY_MISSING', 'CODEX_NOT_FOUND',
  'SIGNATURE_MISMATCH', 'VERSION_UNSUPPORTED', 'PROCESS_AMBIGUOUS', 'CDP_UNTRUSTED',
  'CDP_TIMEOUT', 'PROCESS_CHANGED', 'PROCESS_EXIT_TIMEOUT', 'CODEX_LAUNCH_FAILED',
  'INJECTION_FAILED', 'WORKER_STOPPING', 'STATE_UNAVAILABLE', 'RUNTIME_ERROR',
]);

async function writeMessage(stdout, message) {
  const line = `${serializeWorkerMessage(message)}\n`;
  if (!stdout.write(line, 'utf8')) await once(stdout, 'drain');
}

function safeResultCode(error) {
  if (typeof error?.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)) return 'runtime-error';
  return error.code.toLowerCase().replaceAll('_', '-');
}

/** 逐字节读取有限长度JSONL；超长行丢弃至换行，避免把任意输入交给状态机。 */
export async function runWorker({ stdin, stdout, assistant }) {
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
    await writeMessage(stdout, { v: 1, type: 'error', code });
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
      await writeMessage(stdout, { v: 1, type: 'accepted', id: request.id });
      await writeMessage(stdout, { v: 1, type: 'result', id: request.id, ok: false, code: 'request-capacity-reached' });
      return;
    }

    seen.set(request.id, null);
    await writeMessage(stdout, { v: 1, type: 'accepted', id: request.id });
    let resultMessage;
    if (shutdownRequested) {
      resultMessage = { v: 1, type: 'result', id: request.id, ok: false, code: 'worker-stopping' };
    } else {
      try {
        const result = await assistant.dispatch(request);
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
      await emitParseError(/^[A-Z][A-Z0-9_]{0,63}$/u.test(error?.code ?? '') ? error.code : 'RUNTIME_ERROR');
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
  try {
    lock = await acquireAssistantLock({
      stateRoot: ASSISTANT_STATE_ROOT,
      pid: process.pid,
      processStartTime: await getCurrentProcessStartTime(),
      token: randomBytes(32).toString('hex'),
    });
    const runtime = createCodexRuntime({ compatibility: await loadCompatibility() });
    assistant = createManagedAssistant({ runtime, tokenFactory: () => randomBytes(32).toString('hex') });
    process.once('SIGTERM', () => process.stdin.destroy());
    try { await assistant.refresh(); } catch { /* 状态错误已作为固定状态消息写到stdout；仍等用户操作 */ }
    await runWorker({ stdin: process.stdin, stdout: process.stdout, assistant });
  } catch (error) {
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
