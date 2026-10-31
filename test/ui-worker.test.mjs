import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { createManagedAssistant } from '../src/managed-assistant.mjs';
import { runWorker } from '../src/ui-worker.mjs';

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174010';
const STATE = {
  codex: 'stopped', cdp: 'closed', pageCount: 0,
  codexVersion: null, codexBuild: null, port: null, launchSource: 'none', errorCode: null,
};

function runtime(calls) {
  return {
    async inspect() { calls.push('inspect'); return { mode: 'not-running', state: { ...STATE } }; },
    async launch() { calls.push('launch'); return { state: { ...STATE } }; },
    async connect() { calls.push('connect'); return { state: { ...STATE } }; },
    async confirmRestart() { calls.push('confirmRestart'); return { state: { ...STATE } }; },
    async restoreOrdinary() { calls.push('restoreOrdinary'); return { state: { ...STATE } }; },
    async pause() { calls.push('pause'); return { state: { ...STATE } }; },
    async resume() { calls.push('resume'); return { state: { ...STATE } }; },
    async shutdown() { calls.push('shutdown'); return { state: { ...STATE } }; },
  };
}

async function runLines(lines, calls = [], logs = [], runtimeFactory = runtime) {
  const messages = [];
  const stdin = Readable.from(lines.map((line) => Buffer.from(line)));
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      messages.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      callback();
    },
  });
  const assistant = createManagedAssistant({ runtime: runtimeFactory(calls), emit() {} });
  await runWorker({
    stdin,
    stdout,
    assistant,
    logger: async (event, detail = '') => { logs.push(`${event} ${detail}`.trim()); },
  });
  return { messages: messages.map((line) => JSON.parse(line)), calls, logs };
}

function request(action, id = REQUEST_ID) {
  return `${JSON.stringify({ v: 1, type: 'request', id, action })}\n`;
}

test('accepts a valid request and emits accepted, state, and final result messages', async () => {
  const { messages, calls } = await runLines([request('refresh')]);
  assert.deepEqual(messages.map((message) => message.type), ['accepted', 'state', 'result', 'state']);
  assert.equal(messages[0].id, REQUEST_ID);
  assert.equal(messages[2].code, 'refreshed');
  assert.deepEqual(calls, ['inspect', 'shutdown']);
});

test('duplicate request IDs replay the prior result without re-running the action', async () => {
  const line = request('launch');
  const { messages, calls } = await runLines([line, line]);
  assert.equal(calls.filter((call) => call === 'launch').length, 1);
  assert.equal(messages.filter((message) => message.type === 'accepted').length, 1);
  assert.equal(messages.filter((message) => message.type === 'result').length, 2);
});

test('malformed lines return only a fixed protocol error and do not dispatch actions', async () => {
  const { messages, calls } = await runLines(['not-json\n']);
  assert.equal(messages[0].type, 'error');
  assert.equal(messages[0].code, 'INVALID_JSON');
  assert.equal(calls.includes('launch'), false);
  assert.equal(calls.filter((call) => call === 'shutdown').length, 1);
});

test('records each action and its failure code in the shared log', async () => {
  const logs = [];
  const failingRuntime = (calls) => ({
    async inspect() {
      calls.push('inspect');
      return {
        mode: 'cdp-ready',
        restoreAllowed: false,
        processFingerprint: 'fingerprint-1',
        state: { ...STATE, codex: 'running', cdp: 'verified', port: 9341, launchSource: 'external' },
      };
    },
    async connect() {
      calls.push('connect');
      throw Object.assign(new Error('connect failed'), { code: 'CDP_UNTRUSTED' });
    },
    async shutdown() { calls.push('shutdown'); return { state: { ...STATE } }; },
  });
  const { messages } = await runLines([request('connect')], [], logs, failingRuntime);
  assert.equal(messages.find((message) => message.type === 'result').code, 'cdp-untrusted');
  assert.ok(logs.some((line) => line === 'action-received action=connect'));
  assert.ok(logs.some((line) => line.startsWith('action-failed action=connect code=CDP_UNTRUSTED')));
});

test('oversized lines are discarded through newline and the next request is still handled', async () => {
  const { messages, calls } = await runLines([`${'x'.repeat(16 * 1024 + 1)}\n`, request('refresh')]);
  assert.equal(messages[0].type, 'error');
  assert.equal(messages[0].code, 'MESSAGE_TOO_LARGE');
  assert.ok(messages.some((message) => message.type === 'result' && message.code === 'refreshed'));
  assert.equal(calls.filter((call) => call === 'inspect').length, 1);
});

test('stdin EOF runs assistant cleanup exactly once', async () => {
  const calls = [];
  const { messages } = await runLines([], calls);
  assert.deepEqual(messages.map((message) => message.type), ['state']);
  assert.equal(messages[0].worker, 'stopping');
  assert.equal(calls.filter((call) => call === 'shutdown').length, 1);
});
