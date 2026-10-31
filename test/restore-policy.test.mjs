import test from 'node:test';
import assert from 'node:assert/strict';
import { restorePrecondition } from '../src/restore-policy.mjs';

const FINGERPRINT = 'codex-process-fingerprint-1';

function current(overrides = {}) {
  return {
    mode: 'cdp-ready',
    restoreAllowed: true,
    processFingerprint: FINGERPRINT,
    ...overrides,
  };
}

test('allows restore only for a verified tool-owned process with the same fingerprint', () => {
  assert.equal(restorePrecondition(current(), FINGERPRINT), null);
});

test('rejects ordinary, external, ambiguous and changed processes', () => {
  assert.equal(restorePrecondition(current({ mode: 'ordinary-running' }), FINGERPRINT), 'PROCESS_CHANGED');
  assert.equal(restorePrecondition(current({ restoreAllowed: false }), FINGERPRINT), 'PROCESS_CHANGED');
  assert.equal(restorePrecondition(current({ processFingerprint: 'other' }), FINGERPRINT), 'PROCESS_CHANGED');
  assert.equal(restorePrecondition(current(), 'other'), 'PROCESS_CHANGED');
  assert.equal(restorePrecondition(null, FINGERPRINT), 'PROCESS_CHANGED');
  assert.equal(restorePrecondition(current(), ''), 'PROCESS_CHANGED');
});
