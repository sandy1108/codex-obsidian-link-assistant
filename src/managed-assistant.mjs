const FIXED_ERROR_CODES = new Set([
  'ASSISTANT_LOCK_HELD', 'CODEX_NOT_FOUND', 'SIGNATURE_MISMATCH', 'VERSION_UNSUPPORTED',
  'PROCESS_AMBIGUOUS', 'CDP_UNTRUSTED', 'CDP_TIMEOUT', 'PROCESS_CHANGED',
  'PROCESS_IDENTITY_UNAVAILABLE', 'CONFIRMATION_EXPIRED', 'NO_PENDING_CONFIRMATION',
  'INVALID_CONFIRMATION', 'EXTERNAL_PROCESS', 'COMPATIBILITY_MISSING', 'INJECTION_FAILED',
  'WORKER_STOPPING', 'STATE_UNAVAILABLE', 'RUNTIME_ERROR', 'PROCESS_EXIT_TIMEOUT', 'CODEX_LAUNCH_FAILED',
]);
const CONFIRMATION_TTL_MS = 60_000;
const CONFIRMATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;

function assistantError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function fixedErrorCode(error) {
  return FIXED_ERROR_CODES.has(error?.code) ? error.code : 'RUNTIME_ERROR';
}

function normalizedState(source = {}) {
  const stringOrNull = (value) => typeof value === 'string' ? value : null;
  return {
    codex: ['stopped', 'running', 'unknown'].includes(source.codex) ? source.codex : 'unknown',
    cdp: ['closed', 'verified', 'unknown'].includes(source.cdp) ? source.cdp : 'unknown',
    pageCount: Number.isInteger(source.pageCount) && source.pageCount >= 0 && source.pageCount <= 1000
      ? source.pageCount : 0,
    codexVersion: stringOrNull(source.codexVersion),
    codexBuild: stringOrNull(source.codexBuild),
    port: Number.isInteger(source.port) && source.port >= 1024 && source.port <= 65535 ? source.port : null,
    launchSource: ['none', 'app', 'external', 'unknown'].includes(source.launchSource)
      ? source.launchSource : 'unknown',
    errorCode: FIXED_ERROR_CODES.has(source.errorCode) ? source.errorCode : null,
  };
}

/**
 * 管理一次助手运行。runtime负责实际进程/CDP操作；此状态机负责确认票据、去重之外的动作语义和安全状态回报。
 */
export function createManagedAssistant({ runtime, clock = Date.now, tokenFactory, emit = () => {} }) {
  if (!runtime || typeof runtime.inspect !== 'function' || typeof emit !== 'function') {
    throw new TypeError('managed assistant requires a runtime and emitter');
  }

  let emitter = emit;
  let workerState = 'observing';
  let current = normalizedState();
  let sequence = 0;
  let pendingConfirmation = null;
  let shutdownComplete = false;
  let queue = Promise.resolve();

  function enqueue(operation, request) {
    const result = queue.then(() => operation(request));
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function publishState() {
    sequence += 1;
    await emitter({ v: 1, type: 'state', seq: sequence, ...current, worker: workerState });
  }

  function applyRuntimeResult(result) {
    current = normalizedState(result?.state);
  }

  async function inspect() {
    let result;
    try {
      result = await runtime.inspect();
      if (!result || typeof result !== 'object') throw assistantError('STATE_UNAVAILABLE');
    } catch (error) {
      workerState = 'error';
      current.errorCode = fixedErrorCode(error);
      await publishState();
      throw assistantError(current.errorCode);
    }
    return result;
  }

  async function requestConfirmation(request, reason, inspected) {
    const targetFingerprint = inspected.processFingerprint;
    if (typeof targetFingerprint !== 'string' || targetFingerprint.length < 16 || targetFingerprint.length > 256) {
      throw assistantError('PROCESS_IDENTITY_UNAVAILABLE');
    }
    const confirmationId = tokenFactory?.();
    if (typeof confirmationId !== 'string' || !CONFIRMATION_TOKEN_PATTERN.test(confirmationId)) {
      throw assistantError('RUNTIME_ERROR');
    }
    pendingConfirmation = {
      requestId: request.id,
      confirmationId,
      expiresAt: clock() + CONFIRMATION_TTL_MS,
      reason,
      targetFingerprint,
      workerStateAtRequest: workerState,
    };
    await emitter({
      v: 1,
      type: 'confirmationRequired',
      requestId: request.id,
      confirmationId,
      reason,
      expiresInSeconds: 60,
    });
    return { ok: true, code: 'confirmation-required' };
  }

  async function fail(error) {
    workerState = 'error';
    current.errorCode = fixedErrorCode(error);
    await publishState();
    throw assistantError(current.errorCode);
  }

  async function refreshImpl() {
    if (shutdownComplete) throw assistantError('WORKER_STOPPING');
    try {
      const inspected = await inspect();
      if (pendingConfirmation && inspected.processFingerprint !== pendingConfirmation.targetFingerprint) {
        pendingConfirmation = null;
      }
      applyRuntimeResult(inspected);
      // 刷新后的运行时快照才是启用状态的依据；进程/CDP证据失效时不能继续显示active或paused。
      if (current.errorCode) workerState = 'error';
      else if (workerState === 'error') workerState = 'observing';
      else if (['active', 'paused'].includes(workerState)
        && (current.codex !== 'running' || current.cdp !== 'verified')) workerState = 'observing';
      await publishState();
      return { ok: true, code: 'refreshed' };
    } catch (error) {
      if (workerState === 'error') throw assistantError(current.errorCode ?? fixedErrorCode(error));
      return fail(error);
    }
  }

  async function enableImpl(request) {
    if (shutdownComplete) throw assistantError('WORKER_STOPPING');
    try {
      const inspected = await inspect();
      applyRuntimeResult(inspected);
      if (current.errorCode) throw assistantError(current.errorCode);
      if (inspected.mode === 'ordinary-running') {
        workerState = 'observing';
        const result = await requestConfirmation(request, 'restartOrdinaryCodex', inspected);
        await publishState();
        return result;
      }
      if (!['not-running', 'cdp-ready'].includes(inspected.mode)) {
        throw assistantError(inspected.mode === 'ambiguous' ? 'PROCESS_AMBIGUOUS'
          : inspected.mode === 'incompatible' ? 'VERSION_UNSUPPORTED' : 'STATE_UNAVAILABLE');
      }
      const result = await runtime.enable({ expectedFingerprint: inspected.processFingerprint ?? null });
      applyRuntimeResult(result);
      workerState = 'active';
      await publishState();
      return { ok: true, code: 'enabled' };
    } catch (error) { return fail(error); }
  }

  async function restoreOrdinaryImpl(request) {
    if (shutdownComplete) throw assistantError('WORKER_STOPPING');
    try {
      const inspected = await inspect();
      applyRuntimeResult(inspected);
      if (current.errorCode) throw assistantError(current.errorCode);
      if (inspected.mode !== 'cdp-ready' || inspected.restoreAllowed !== true) {
        throw assistantError(inspected.mode === 'ambiguous' ? 'PROCESS_AMBIGUOUS' : 'EXTERNAL_PROCESS');
      }
      if (workerState === 'error') workerState = 'observing';
      const result = await requestConfirmation(request, 'restoreOrdinaryCodex', inspected);
      await publishState();
      return result;
    } catch (error) { return fail(error); }
  }

  async function confirmRestartImpl(request) {
    if (shutdownComplete) throw assistantError('WORKER_STOPPING');
    const pending = pendingConfirmation;
    if (!pending) throw assistantError('NO_PENDING_CONFIRMATION');
    if (request.confirmationId !== pending.confirmationId) throw assistantError('INVALID_CONFIRMATION');
    pendingConfirmation = null;
    if (clock() >= pending.expiresAt) return fail(assistantError('CONFIRMATION_EXPIRED'));

    try {
      const inspected = await inspect();
      if (inspected.processFingerprint !== pending.targetFingerprint) throw assistantError('PROCESS_CHANGED');
      let result;
      if (pending.reason === 'restartOrdinaryCodex') {
        if (inspected.mode !== 'ordinary-running') throw assistantError('PROCESS_CHANGED');
        result = await runtime.confirmRestart({ targetFingerprint: pending.targetFingerprint });
        workerState = 'active';
      } else {
        if (inspected.mode !== 'cdp-ready' || inspected.restoreAllowed !== true) {
          throw assistantError('PROCESS_CHANGED');
        }
        result = await runtime.restoreOrdinary({ targetFingerprint: pending.targetFingerprint, confirmed: true });
        workerState = 'observing';
      }
      applyRuntimeResult(result);
      await publishState();
      return { ok: true, code: pending.reason === 'restartOrdinaryCodex' ? 'enabled' : 'ordinary-restored' };
    } catch (error) { return fail(error); }
  }

  async function cancelConfirmationImpl(request) {
    if (shutdownComplete) throw assistantError('WORKER_STOPPING');
    if (!pendingConfirmation) throw assistantError('NO_PENDING_CONFIRMATION');
    const pending = pendingConfirmation;
    if (request.confirmationId !== pending.confirmationId) throw assistantError('INVALID_CONFIRMATION');
    pendingConfirmation = null;
    try {
      const inspected = await inspect();
      applyRuntimeResult(inspected);
      const sameTarget = inspected.processFingerprint === pending.targetFingerprint;
      const canRestorePriorState = pending.reason === 'restoreOrdinaryCodex'
        && sameTarget && inspected.mode === 'cdp-ready' && current.cdp === 'verified'
        && ['active', 'paused'].includes(pending.workerStateAtRequest);
      workerState = current.errorCode ? 'error'
        : canRestorePriorState ? pending.workerStateAtRequest : 'observing';
      await publishState();
      return { ok: true, code: 'confirmation-cancelled' };
    } catch (error) { return fail(error); }
  }

  async function pauseImpl() {
    if (shutdownComplete) throw assistantError('WORKER_STOPPING');
    if (workerState !== 'active') throw assistantError('STATE_UNAVAILABLE');
    try {
      const result = await runtime.pause();
      applyRuntimeResult(result);
      workerState = 'paused';
      await publishState();
      return { ok: true, code: 'paused' };
    } catch (error) { return fail(error); }
  }

  async function resumeImpl() {
    if (shutdownComplete) throw assistantError('WORKER_STOPPING');
    if (workerState !== 'paused') throw assistantError('STATE_UNAVAILABLE');
    try {
      const result = await runtime.resume();
      applyRuntimeResult(result);
      workerState = 'active';
      await publishState();
      return { ok: true, code: 'resumed' };
    } catch (error) { return fail(error); }
  }

  async function shutdownImpl() {
    if (shutdownComplete) return { ok: true, code: 'shutdown' };
    shutdownComplete = true;
    pendingConfirmation = null;
    workerState = 'stopping';
    try {
      const result = await runtime.shutdown();
      applyRuntimeResult(result);
      await publishState();
      return { ok: true, code: 'shutdown' };
    } catch (error) {
      current.errorCode = fixedErrorCode(error);
      await publishState();
      throw assistantError(current.errorCode);
    }
  }

  return {
    setEmitter(nextEmitter) {
      if (typeof nextEmitter !== 'function') throw new TypeError('emitter must be a function');
      emitter = nextEmitter;
    },
    snapshot() {
      return { v: 1, type: 'state', seq: sequence, ...current, worker: workerState };
    },
    dispatch(request) {
      const action = request?.action;
      return this[action]?.(request) ?? Promise.reject(assistantError('INVALID_REQUEST'));
    },
    refresh: (request) => enqueue(refreshImpl, request),
    enable: (request) => enqueue(enableImpl, request),
    confirmRestart: (request) => enqueue(confirmRestartImpl, request),
    cancelConfirmation: (request) => enqueue(cancelConfirmationImpl, request),
    pause: (request) => enqueue(pauseImpl, request),
    resume: (request) => enqueue(resumeImpl, request),
    restoreOrdinary: (request) => enqueue(restoreOrdinaryImpl, request),
    shutdown: (request) => enqueue(shutdownImpl, request),
  };
}
