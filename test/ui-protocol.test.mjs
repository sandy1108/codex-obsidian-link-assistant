import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkerRequest, serializeWorkerMessage } from '../src/ui-protocol.mjs';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const confirmationId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function request(action, extra = {}) {
  return JSON.stringify({ v: 1, type: 'request', id: requestId, action, ...extra });
}

test('parses supported worker actions and requires a confirmation token only for confirmation replies', () => {
  assert.deepEqual(parseWorkerRequest(request('refresh')), {
    v: 1, type: 'request', id: requestId, action: 'refresh',
  });
  assert.deepEqual(parseWorkerRequest(request('launch')), {
    v: 1, type: 'request', id: requestId, action: 'launch',
  });
  assert.deepEqual(parseWorkerRequest(request('connect')), {
    v: 1, type: 'request', id: requestId, action: 'connect',
  });
  assert.deepEqual(parseWorkerRequest(request('confirmRestart', { confirmationId })), {
    v: 1, type: 'request', id: requestId, action: 'confirmRestart', confirmationId,
  });
  assert.deepEqual(parseWorkerRequest(request('cancelConfirmation', { confirmationId })), {
    v: 1, type: 'request', id: requestId, action: 'cancelConfirmation', confirmationId,
  });
  assert.deepEqual(parseWorkerRequest(request('configureVault', { vaultRoot: '/Users/example/Notes' })), {
    v: 1, type: 'request', id: requestId, action: 'configureVault', vaultRoot: '/Users/example/Notes',
  });
  assert.equal(parseWorkerRequest(request('configureQuotaRefresh', { refreshMinutes: 12 })).refreshMinutes, 12);
});

test('rejects malformed, unsupported, and extra-field requests', () => {
  for (const line of [
    '{',
    '[]',
    request('enable'),
    JSON.stringify({ v: 2, type: 'request', id: requestId, action: 'refresh' }),
    JSON.stringify({ v: 1, type: 'command', id: requestId, action: 'refresh' }),
    request('refresh', { path: '/tmp/note.md' }),
    request('configureVault'),
    request('configureVault', { vaultRoot: 'relative/path' }),
    request('configureVault', { vaultRoot: '/Users/example/Notes', extra: true }),
    request('configureVault', { vaultRoot: `/Users/${'a'.repeat(17000)}` }),
    request('configureQuotaRefresh'),
    request('configureQuotaRefresh', { refreshMinutes: 0 }),
    request('configureQuotaRefresh', { refreshMinutes: 61 }),
    request('configureQuotaRefresh', { refreshMinutes: 5, extra: true }),
    request('confirmRestart'),
    request('cancelConfirmation', { confirmationId, extra: true }),
    `${request('refresh')}\n{}`,
  ]) {
    assert.throws(() => parseWorkerRequest(line));
  }
});

test('enforces the protocol line limit in UTF-8 bytes', () => {
  assert.throws(() => parseWorkerRequest(' '.repeat(16 * 1024 + 1)));
  assert.throws(() => parseWorkerRequest(`"${'界'.repeat(6000)}"`));
});

test('serializes a valid worker message as exactly one bounded JSON line', () => {
  const line = serializeWorkerMessage({ v: 1, type: 'accepted', id: requestId });
  assert.equal(line, JSON.stringify({ v: 1, type: 'accepted', id: requestId }));
  assert.equal(line.includes('\n'), false);
  assert.deepEqual(JSON.parse(line), { v: 1, type: 'accepted', id: requestId });
});

test('serializes fixed protocol errors without adding raw input details', () => {
  const line = serializeWorkerMessage({ v: 1, type: 'error', code: 'INVALID_JSON' });
  assert.equal(line, '{"v":1,"type":"error","code":"INVALID_JSON"}');
});

test('rejects unknown fields, unsupported messages, and malformed identifiers', () => {
  assert.throws(() => serializeWorkerMessage({ v: 1, type: 'accepted', id: requestId, uri: 'obsidian://open' }));
  assert.throws(() => serializeWorkerMessage({ v: 1, type: 'unknown', id: requestId }));
  assert.throws(() => serializeWorkerMessage({ v: 1, type: 'accepted', id: requestId.repeat(5000) }));
});

test('state messages expose only bounded Vault settings fields', () => {
  const line = serializeWorkerMessage({
    v: 1, type: 'state', seq: 1, codex: 'stopped', cdp: 'closed', worker: 'observing', pageCount: 0,
    vaultConfigured: true, vaultRoot: '/Users/example/Notes', vaultName: 'Notes',
    recommendedVaultRoot: null,
  });
  assert.deepEqual(JSON.parse(line).vaultRoot, '/Users/example/Notes');
  assert.throws(() => serializeWorkerMessage({
    v: 1, type: 'state', seq: 1, codex: 'stopped', cdp: 'closed', worker: 'observing', pageCount: 0,
    vaultConfigured: true, vaultRoot: '/Users/example/Notes', vaultName: 'Notes',
    recommendedVaultRoot: null, obsidianUri: 'obsidian://open',
  }));
});
