import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibilityErrorCode } from '../src/compatibility-policy.mjs';

const approved = {
  bundleId: 'com.openai.codex',
  teamId: '2DC432GLL2',
  version: '26.1027.30824',
  build: '22943',
  appAsarSha256: '36bf3d2b35e95e11852074b9ca9459b89efbecd6b8311345d060cf66de8f0ba6',
  minimumNodeMajor: 24,
};

const installed = {
  bundleId: approved.bundleId,
  teamId: approved.teamId,
  version: approved.version,
  build: approved.build,
  appAsarSha256: approved.appAsarSha256,
  nodeMajor: 24,
};

test('accepts only the exact approved Codex identity and runtime hash', () => {
  assert.equal(compatibilityErrorCode(installed, approved), null);
});

test('blocks a different signing team before version comparisons', () => {
  assert.equal(compatibilityErrorCode({ ...installed, teamId: 'OTHERTEAM1' }, approved), 'SIGNATURE_MISMATCH');
});

test('blocks changed version, build, asar hash, or too-old Node runtime', () => {
  assert.equal(compatibilityErrorCode({ ...installed, version: '26.1100.1' }, approved), 'VERSION_UNSUPPORTED');
  assert.equal(compatibilityErrorCode({ ...installed, build: '99999' }, approved), 'VERSION_UNSUPPORTED');
  assert.equal(compatibilityErrorCode({ ...installed, appAsarSha256: '0'.repeat(64) }, approved), 'VERSION_UNSUPPORTED');
  assert.equal(compatibilityErrorCode({ ...installed, nodeMajor: 20 }, approved), 'VERSION_UNSUPPORTED');
});

test('blocks missing or malformed compatibility metadata', () => {
  assert.equal(compatibilityErrorCode(installed, null), 'COMPATIBILITY_MISSING');
  assert.equal(compatibilityErrorCode(installed, { ...approved, appAsarSha256: 'bad' }), 'COMPATIBILITY_MISSING');
});
