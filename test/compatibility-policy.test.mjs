import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compatibilityErrorCode,
  compatibilityIdentityKey,
  forceCompatibilityErrorCode,
} from '../src/compatibility-policy.mjs';

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

// 真实场景：Codex升级后只命中版本类失败，签名身份仍然有效。
const upgraded = {
  ...installed,
  version: '26.1027.51404',
  build: '23880',
  appAsarSha256: '52e0a65f9fea51f4287bbd98c63343761f9424517bb793652bb554764bc0bcc8',
};

test('identity key binds every version-list field and is deterministic', () => {
  assert.equal(compatibilityErrorCode(upgraded, approved), 'VERSION_UNSUPPORTED');
  assert.match(String(compatibilityIdentityKey(upgraded)), /^[a-f0-9]{64}$/u);
  assert.equal(compatibilityIdentityKey(upgraded), compatibilityIdentityKey({ ...upgraded }));
  assert.notEqual(compatibilityIdentityKey(upgraded), compatibilityIdentityKey(installed));
  for (const changed of [
    { ...upgraded, bundleId: 'com.other.app' },
    { ...upgraded, teamId: 'OTHERTEAM1' },
    { ...upgraded, version: '26.1027.99999' },
    { ...upgraded, build: '99999' },
    { ...upgraded, appAsarSha256: 'f'.repeat(64) },
    { ...upgraded, nodeMajor: 25 },
  ]) {
    assert.notEqual(compatibilityIdentityKey(changed), compatibilityIdentityKey(upgraded));
  }
  assert.equal(compatibilityIdentityKey({ ...upgraded, build: undefined }), null);
  assert.equal(compatibilityIdentityKey(null), null);
});

test('a granted key unblocks only the version-list comparison', () => {
  const granted = compatibilityIdentityKey(upgraded);
  assert.equal(forceCompatibilityErrorCode({ installed: upgraded, approved, authorizedKey: granted }), null);
  // 清单本来命中时不需要授权键，强兼容路径不能把可用状态判成失败。
  assert.equal(forceCompatibilityErrorCode({ installed, approved, authorizedKey: null }), null);
});

test('a granted key never bypasses signing identity, manifest or Node floor', () => {
  const teamChanged = { ...installed, teamId: 'OTHERTEAM1' };
  assert.equal(forceCompatibilityErrorCode({
    installed: teamChanged, approved, authorizedKey: compatibilityIdentityKey(teamChanged),
  }), 'SIGNATURE_MISMATCH');
  assert.equal(forceCompatibilityErrorCode({
    installed: null, approved, authorizedKey: compatibilityIdentityKey(installed),
  }), 'SIGNATURE_MISMATCH');
  assert.equal(forceCompatibilityErrorCode({
    installed: upgraded, approved: null, authorizedKey: compatibilityIdentityKey(upgraded),
  }), 'COMPATIBILITY_MISSING');
  // 内置Node低于硬下限时强兼容也不放行。
  const tooOldNode = { ...upgraded, nodeMajor: 20 };
  assert.equal(forceCompatibilityErrorCode({
    installed: tooOldNode, approved, authorizedKey: compatibilityIdentityKey(tooOldNode),
  }), 'VERSION_UNSUPPORTED');
});

test('authorization expires as soon as the installed identity changes', () => {
  const grantedForOtherBuild = compatibilityIdentityKey({ ...upgraded, build: '20000' });
  for (const authorizedKey of [null, undefined, '', '0'.repeat(64), grantedForOtherBuild]) {
    assert.equal(
      forceCompatibilityErrorCode({ installed: upgraded, approved, authorizedKey }),
      'VERSION_UNSUPPORTED',
      `key ${authorizedKey} must not authorize this install`,
    );
  }
});
