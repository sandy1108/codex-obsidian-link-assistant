import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCodexLaunchState } from '../src/launch-policy.mjs';

test('classifies stopped, ordinary, and verified CDP Codex states', () => {
  assert.equal(classifyCodexLaunchState(0, false), 'not-running');
  assert.equal(classifyCodexLaunchState(1, false), 'ordinary-running');
  assert.equal(classifyCodexLaunchState(1, true), 'cdp-ready');
});

test('refuses ambiguous process counts', () => {
  assert.throws(() => classifyCodexLaunchState(-1, false));
});
