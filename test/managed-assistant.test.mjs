import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedAssistant } from '../src/managed-assistant.mjs';

const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const FINGERPRINT = 'codex-process-fingerprint-1';
const INITIAL_STATE = {
  codex: 'running', cdp: 'closed', pageCount: 0,
  codexVersion: '26.1027.30824', codexBuild: '22943',
  port: null, launchSource: 'external', errorCode: null,
};

function fakeRuntime({ mode = 'ordinary-running', restoreAllowed = false, fingerprint = FINGERPRINT } = {}) {
  const calls = [];
  let currentMode = mode;
  return {
    calls,
    setMode(nextMode) { currentMode = nextMode; },
    async inspect() {
      calls.push('inspect');
      const state = currentMode === 'not-running'
        ? { ...INITIAL_STATE, codex: 'stopped', cdp: 'closed', pageCount: 0, port: null, launchSource: 'none' }
        : currentMode === 'cdp-ready'
          ? { ...INITIAL_STATE, cdp: 'verified', pageCount: 1, port: 9341 }
          : { ...INITIAL_STATE };
      return { mode: currentMode, restoreAllowed, processFingerprint: fingerprint, state };
    },
    async enable(options) {
      calls.push(['enable', options]);
      return { state: { ...INITIAL_STATE, cdp: 'verified', pageCount: 2, port: 9341 } };
    },
    async confirmRestart(options) {
      calls.push(['confirmRestart', options]);
      return { state: { ...INITIAL_STATE, cdp: 'verified', pageCount: 1, port: 9342, launchSource: 'app' } };
    },
    async restoreOrdinary(options) {
      calls.push(['restoreOrdinary', options]);
      return { state: { ...INITIAL_STATE, cdp: 'closed', pageCount: 0, port: null, launchSource: 'none' } };
    },
    async pause() {
      calls.push('pause');
      return { state: { ...INITIAL_STATE, cdp: 'verified', pageCount: 0, port: 9341 } };
    },
    async resume() {
      calls.push('resume');
      return { state: { ...INITIAL_STATE, cdp: 'verified', pageCount: 1, port: 9341 } };
    },
    async shutdown() {
      calls.push('shutdown');
      return { state: { ...INITIAL_STATE, cdp: 'verified', pageCount: 0, port: 9341 } };
    },
  };
}

function create(runtime, options = {}) {
  const emitted = [];
  const assistant = createManagedAssistant({
    runtime,
    clock: options.clock ?? (() => 1000),
    tokenFactory: options.tokenFactory ?? (() => TOKEN),
    emit: (message) => emitted.push(message),
  });
  return { assistant, emitted };
}

function request(action, id = '123e4567-e89b-42d3-a456-426614174001', extra = {}) {
  return { v: 1, type: 'request', id, action, ...extra };
}

test('startup refresh only observes and reports a safe state', async () => {
  const runtime = fakeRuntime();
  const { assistant, emitted } = create(runtime);
  await assistant.refresh();
  assert.deepEqual(runtime.calls, ['inspect']);
  assert.equal(emitted.at(-1).type, 'state');
  assert.equal(emitted.at(-1).worker, 'observing');
  assert.equal(Object.hasOwn(emitted.at(-1), 'processFingerprint'), false);
});

test('enable asks for confirmation before changing an ordinary Codex instance', async () => {
  const runtime = fakeRuntime();
  const { assistant, emitted } = create(runtime);
  const result = await assistant.enable(request('enable'));
  const confirmation = emitted.find((message) => message.type === 'confirmationRequired');
  assert.equal(result.code, 'confirmation-required');
  assert.equal(confirmation.reason, 'restartOrdinaryCodex');
  assert.equal(confirmation.expiresInSeconds, 60);
  assert.equal(runtime.calls.some((call) => Array.isArray(call) && call[0] === 'confirmRestart'), false);
});

test('cancelling restart confirmation leaves ordinary Codex untouched', async () => {
  const runtime = fakeRuntime();
  const { assistant, emitted } = create(runtime);
  await assistant.enable(request('enable'));
  const confirmation = emitted.find((message) => message.type === 'confirmationRequired');
  const result = await assistant.cancelConfirmation(request('cancelConfirmation',
    '123e4567-e89b-42d3-a456-426614174009', { confirmationId: confirmation.confirmationId }));

  assert.equal(result.code, 'confirmation-cancelled');
  assert.equal(emitted.at(-1).worker, 'observing');
  assert.equal(emitted.at(-1).codex, 'running');
  assert.equal(emitted.at(-1).cdp, 'closed');
  assert.equal(runtime.calls.some((call) => Array.isArray(call)
    && ['confirmRestart', 'enable', 'restoreOrdinary'].includes(call[0])), false);
});

test('confirmation is single-use and succeeds only for the same process fingerprint', async () => {
  const runtime = fakeRuntime();
  const { assistant, emitted } = create(runtime);
  await assistant.enable(request('enable'));
  await assistant.confirmRestart(request('confirmRestart', '123e4567-e89b-42d3-a456-426614174002', {
    confirmationId: TOKEN,
  }));
  assert.deepEqual(runtime.calls.at(-1), ['confirmRestart', { targetFingerprint: FINGERPRINT }]);
  assert.equal(emitted.at(-1).worker, 'active');
  await assert.rejects(
    assistant.confirmRestart(request('confirmRestart', '123e4567-e89b-42d3-a456-426614174003', {
      confirmationId: TOKEN,
    })),
    (error) => error.code === 'NO_PENDING_CONFIRMATION',
  );
});

test('expired confirmation never asks runtime to quit or restart Codex', async () => {
  const runtime = fakeRuntime();
  let now = 1000;
  const { assistant } = create(runtime, { clock: () => now });
  await assistant.enable(request('enable'));
  now += 60001;
  await assert.rejects(
    assistant.confirmRestart(request('confirmRestart', '123e4567-e89b-42d3-a456-426614174004', {
      confirmationId: TOKEN,
    })),
    (error) => error.code === 'CONFIRMATION_EXPIRED',
  );
  assert.equal(runtime.calls.some((call) => Array.isArray(call) && call[0] === 'confirmRestart'), false);
});

test('process identity change after confirmation blocks the restart action', async () => {
  const runtime = fakeRuntime();
  const originalInspect = runtime.inspect.bind(runtime);
  let inspectCount = 0;
  runtime.inspect = async () => {
    inspectCount += 1;
    const result = await originalInspect();
    if (inspectCount > 1) result.processFingerprint = 'different-process';
    return result;
  };
  const { assistant } = create(runtime);
  await assistant.enable(request('enable'));
  await assert.rejects(
    assistant.confirmRestart(request('confirmRestart', '123e4567-e89b-42d3-a456-426614174005', {
      confirmationId: TOKEN,
    })),
    (error) => error.code === 'PROCESS_CHANGED',
  );
  assert.equal(runtime.calls.some((call) => Array.isArray(call) && call[0] === 'confirmRestart'), false);
});

test('restore ordinary Codex requires a tool-owned verified process', async () => {
  const runtime = fakeRuntime({ mode: 'cdp-ready', restoreAllowed: false });
  const { assistant } = create(runtime);
  await assert.rejects(assistant.restoreOrdinary(request('restoreOrdinary')),
    (error) => error.code === 'EXTERNAL_PROCESS');
  assert.equal(runtime.calls.some((call) => Array.isArray(call) && call[0] === 'restoreOrdinary'), false);
});

test('cancelled restore confirmation preserves the paused worker state', async () => {
  const runtime = fakeRuntime({ mode: 'cdp-ready', restoreAllowed: true });
  const { assistant, emitted } = create(runtime);
  await assistant.enable(request('enable'));
  await assistant.pause(request('pause', '123e4567-e89b-42d3-a456-426614174008'));
  assert.equal(emitted.at(-1).worker, 'paused');

  const restore = await assistant.restoreOrdinary(request('restoreOrdinary',
    '123e4567-e89b-42d3-a456-426614174011'));
  const confirmation = emitted.findLast((message) => message.type === 'confirmationRequired');
  assert.equal(restore.code, 'confirmation-required');
  assert.equal(confirmation.reason, 'restoreOrdinaryCodex');
  assert.equal(emitted.at(-1).worker, 'paused');

  await assistant.cancelConfirmation(request('cancelConfirmation',
    '123e4567-e89b-42d3-a456-426614174012', { confirmationId: confirmation.confirmationId }));
  assert.equal(emitted.at(-1).worker, 'paused');
  assert.equal(runtime.calls.some((call) => Array.isArray(call) && call[0] === 'restoreOrdinary'), false);
});

test('pause and resume keep Codex running and only alter the assistant state', async () => {
  const runtime = fakeRuntime({ mode: 'cdp-ready' });
  const { assistant, emitted } = create(runtime);
  await assistant.enable(request('enable'));
  await assistant.pause(request('pause', '123e4567-e89b-42d3-a456-426614174006'));
  assert.equal(emitted.at(-1).worker, 'paused');
  await assistant.resume(request('resume', '123e4567-e89b-42d3-a456-426614174007'));
  assert.equal(emitted.at(-1).worker, 'active');
  assert.deepEqual(runtime.calls.slice(-2), ['pause', 'resume']);
});

test('refresh drops the enabled state when the observed Codex process has exited', async () => {
  const runtime = fakeRuntime({ mode: 'cdp-ready' });
  const { assistant, emitted } = create(runtime);
  await assistant.enable(request('enable'));
  runtime.setMode('not-running');
  await assistant.refresh();
  assert.equal(emitted.at(-1).codex, 'stopped');
  assert.equal(emitted.at(-1).worker, 'observing');
});

test('shutdown is idempotent and only asks runtime to clean up this assistant', async () => {
  const runtime = fakeRuntime({ mode: 'cdp-ready' });
  const { assistant } = create(runtime);
  await assistant.shutdown();
  await assistant.shutdown();
  assert.equal(runtime.calls.filter((call) => call === 'shutdown').length, 1);
});
