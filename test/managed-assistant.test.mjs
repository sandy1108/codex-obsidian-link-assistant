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

function fakeRuntime({
  mode = 'ordinary-running', restoreAllowed = false, fingerprint = FINGERPRINT,
  configureError = null, connectPageCount = 2,
} = {}) {
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
    async launch(options) {
      calls.push(['launch', options]);
      return { state: { ...INITIAL_STATE, cdp: 'verified', pageCount: 0, port: 9341, launchSource: 'app' } };
    },
    async connect() {
      calls.push('connect');
      return { state: {
        ...INITIAL_STATE, cdp: 'verified', pageCount: connectPageCount, port: 9341, launchSource: 'app',
      } };
    },
    async confirmRestart(options) {
      calls.push(['confirmRestart', options]);
      return { state: { ...INITIAL_STATE, cdp: 'verified', pageCount: 0, port: 9342, launchSource: 'app' } };
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
    async configureVault(options) {
      calls.push(['configureVault', options]);
      if (configureError) throw Object.assign(new Error(configureError), { code: configureError });
      return { state: {
        ...INITIAL_STATE,
        cdp: options.wasActive ? 'verified' : INITIAL_STATE.cdp,
        vaultConfigured: true, vaultRoot: options.vaultRoot, vaultName: 'Notes',
      } };
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

test('saving a Vault updates the worker state without launching or restarting Codex', async () => {
  const runtime = fakeRuntime({ mode: 'cdp-ready' });
  const { assistant, emitted } = create(runtime);
  const result = await assistant.dispatch(request('configureVault', '123e4567-e89b-42d3-a456-426614174002', {
    vaultRoot: '/Users/example/Notes',
  }));
  assert.deepEqual(result, { ok: true, code: 'vault-configured' });
  assert.deepEqual(runtime.calls, [['configureVault', { vaultRoot: '/Users/example/Notes', wasActive: false }]]);
  assert.equal(emitted.at(-1).type, 'state');
  assert.equal(emitted.at(-1).vaultRoot, '/Users/example/Notes');
});

test('changing a Vault while active keeps the enhancement active without a Codex restart', async () => {
  const runtime = fakeRuntime({ mode: 'cdp-ready' });
  const { assistant, emitted } = create(runtime);
  await assistant.dispatch(request('connect', '123e4567-e89b-42d3-a456-426614174003'));
  const result = await assistant.dispatch(request('configureVault', '123e4567-e89b-42d3-a456-426614174004', {
    vaultRoot: '/Users/example/Other Notes',
  }));
  assert.deepEqual(result, { ok: true, code: 'vault-configured' });
  assert.deepEqual(runtime.calls.at(-1), ['configureVault', {
    vaultRoot: '/Users/example/Other Notes', wasActive: true,
  }]);
  assert.equal(emitted.at(-1).worker, 'active');
  assert.equal(runtime.calls.some((call) => Array.isArray(call) && call[0] === 'confirmRestart'), false);
});

test('rejecting a Vault change leaves the active assistant state intact', async () => {
  const runtime = fakeRuntime({ mode: 'cdp-ready', configureError: 'VAULT_DIRECTORY_INVALID' });
  const { assistant, emitted } = create(runtime);
  await assistant.dispatch(request('connect', '123e4567-e89b-42d3-a456-426614174005'));
  const result = await assistant.dispatch(request('configureVault', '123e4567-e89b-42d3-a456-426614174006', {
    vaultRoot: '/Users/example/not-a-vault',
  }));
  assert.deepEqual(result, { ok: false, code: 'vault-directory-invalid' });
  assert.equal(emitted.at(-1).worker, 'active');
});

test('launch asks for confirmation before changing an ordinary Codex instance', async () => {
  const runtime = fakeRuntime();
  const { assistant, emitted } = create(runtime);
  const result = await assistant.launch(request('launch'));
  const confirmation = emitted.find((message) => message.type === 'confirmationRequired');
  assert.equal(result.code, 'confirmation-required');
  assert.equal(confirmation.reason, 'restartOrdinaryCodex');
  assert.equal(confirmation.expiresInSeconds, 60);
  assert.equal(runtime.calls.some((call) => Array.isArray(call) && call[0] === 'confirmRestart'), false);
});

test('launch starts a stopped Codex but leaves injection to the connect action', async () => {
  const runtime = fakeRuntime({ mode: 'not-running' });
  const { assistant, emitted } = create(runtime);
  const result = await assistant.launch(request('launch'));
  assert.deepEqual(result, { ok: true, code: 'launched' });
  assert.deepEqual(runtime.calls.at(-1), ['launch', { expectedFingerprint: FINGERPRINT }]);
  assert.equal(emitted.at(-1).worker, 'observing');
  assert.equal(emitted.at(-1).cdp, 'verified');
  assert.equal(runtime.calls.includes('connect'), false);
});

test('launch does not restart Codex that already exposes a verified CDP endpoint', async () => {
  const runtime = fakeRuntime({ mode: 'cdp-ready' });
  const { assistant, emitted } = create(runtime);
  const result = await assistant.launch(request('launch'));
  assert.deepEqual(result, { ok: true, code: 'already-launched' });
  assert.equal(runtime.calls.some((call) => Array.isArray(call) && call[0] === 'launch'), false);
  assert.equal(emitted.at(-1).worker, 'observing');
  assert.equal(emitted.at(-1).cdp, 'verified');
});

test('connect requires a verified endpoint and never launches Codex itself', async () => {
  const notRunning = fakeRuntime({ mode: 'not-running' });
  const first = create(notRunning);
  await assert.rejects(first.assistant.connect(request('connect')),
    (error) => error.code === 'STATE_UNAVAILABLE');
  assert.equal(notRunning.calls.includes('connect'), false);

  const runtime = fakeRuntime({ mode: 'cdp-ready' });
  const { assistant, emitted } = create(runtime);
  const result = await assistant.connect(request('connect'));
  assert.deepEqual(result, { ok: true, code: 'connected' });
  assert.deepEqual(runtime.calls.at(-1), 'connect');
  assert.equal(emitted.at(-1).worker, 'active');
  assert.equal(emitted.at(-1).pageCount, 2);
});

test('connect reports zero attached pages as a warning instead of a full success', async () => {
  const runtime = fakeRuntime({ mode: 'cdp-ready', connectPageCount: 0 });
  const { assistant, emitted } = create(runtime);
  const result = await assistant.connect(request('connect'));
  assert.deepEqual(result, { ok: true, code: 'connected-no-pages' });
  assert.equal(emitted.at(-1).worker, 'active');
  assert.equal(emitted.at(-1).pageCount, 0);
});

test('supervisor exit downgrades a connected worker to observing after Codex quits', async () => {
  const runtime = fakeRuntime({ mode: 'cdp-ready' });
  const { assistant, emitted } = create(runtime);
  await assistant.connect(request('connect'));
  assert.equal(emitted.at(-1).worker, 'active');

  runtime.setMode('not-running');
  const result = await assistant.supervisorExited();
  assert.deepEqual(result, { ok: true, code: 'supervisor-exited' });
  assert.equal(emitted.at(-1).worker, 'observing');
  assert.equal(emitted.at(-1).codex, 'stopped');
  assert.equal(emitted.at(-1).pageCount, 0);
});

test('supervisor exit after shutdown does not publish a new state', async () => {
  const runtime = fakeRuntime({ mode: 'cdp-ready' });
  const { assistant, emitted } = create(runtime);
  await assistant.connect(request('connect'));
  await assistant.shutdown();
  const countAfterShutdown = emitted.length;
  runtime.setMode('not-running');
  await assistant.supervisorExited();
  assert.equal(emitted.length, countAfterShutdown);
});

test('cancelling restart confirmation leaves ordinary Codex untouched', async () => {
  const runtime = fakeRuntime();
  const { assistant, emitted } = create(runtime);
  await assistant.launch(request('launch'));
  const confirmation = emitted.find((message) => message.type === 'confirmationRequired');
  const result = await assistant.cancelConfirmation(request('cancelConfirmation',
    '123e4567-e89b-42d3-a456-426614174009', { confirmationId: confirmation.confirmationId }));

  assert.equal(result.code, 'confirmation-cancelled');
  assert.equal(emitted.at(-1).worker, 'observing');
  assert.equal(emitted.at(-1).codex, 'running');
  assert.equal(emitted.at(-1).cdp, 'closed');
  assert.equal(runtime.calls.some((call) => Array.isArray(call)
    && ['confirmRestart', 'launch', 'connect', 'restoreOrdinary'].includes(call[0])), false);
});

test('confirmation is single-use and succeeds only for the same process fingerprint', async () => {
  const runtime = fakeRuntime();
  const { assistant, emitted } = create(runtime);
  await assistant.launch(request('launch'));
  const confirmed = await assistant.confirmRestart(request('confirmRestart', '123e4567-e89b-42d3-a456-426614174002', {
    confirmationId: TOKEN,
  }));
  assert.deepEqual(runtime.calls.at(-1), ['confirmRestart', { targetFingerprint: FINGERPRINT }]);
  assert.equal(confirmed.code, 'launched');
  // 重启后只完成CDP启动，注入留给用户单独点击连接。
  assert.equal(emitted.at(-1).worker, 'observing');
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
  await assistant.launch(request('launch'));
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
  await assistant.launch(request('launch'));
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
  await assistant.connect(request('connect'));
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
  await assistant.connect(request('connect'));
  await assistant.pause(request('pause', '123e4567-e89b-42d3-a456-426614174006'));
  assert.equal(emitted.at(-1).worker, 'paused');
  await assistant.resume(request('resume', '123e4567-e89b-42d3-a456-426614174007'));
  assert.equal(emitted.at(-1).worker, 'active');
  assert.deepEqual(runtime.calls.slice(-2), ['pause', 'resume']);
});

test('refresh drops the active state when the observed Codex process has exited', async () => {
  const runtime = fakeRuntime({ mode: 'cdp-ready' });
  const { assistant, emitted } = create(runtime);
  await assistant.connect(request('connect'));
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
