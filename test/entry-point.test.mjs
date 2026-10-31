import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { isDirectExecution } from '../src/entry-point.mjs';

test('matches the exact module file path with spaces', () => {
  const moduleUrl = pathToFileURL('/tmp/Codex Helper/main.mjs').href;
  assert.equal(isDirectExecution(moduleUrl, '/tmp/Codex Helper/main.mjs'), true);
  assert.equal(isDirectExecution(moduleUrl, '/tmp/Codex Helper/ui-worker.mjs'), false);
});

test('does not classify missing or non-file entry paths as direct execution', () => {
  assert.equal(isDirectExecution('app://main.mjs', '/tmp/main.mjs'), false);
  assert.equal(isDirectExecution('file:///tmp/main.mjs', undefined), false);
});
