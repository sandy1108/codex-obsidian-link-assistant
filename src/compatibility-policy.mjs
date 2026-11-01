import { createHash } from 'node:crypto';

const APPROVED_BUNDLE_ID = 'com.openai.codex';
const APPROVED_TEAM_ID = '2DC432GLL2';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function identityMaterial(facts) {
  if (!facts) return null;
  const { bundleId, teamId, version, build, appAsarSha256, nodeMajor } = facts;
  if (typeof bundleId !== 'string' || typeof teamId !== 'string'
    || typeof version !== 'string' || typeof build !== 'string'
    || typeof appAsarSha256 !== 'string' || !SHA256_PATTERN.test(appAsarSha256)
    || !Number.isInteger(nodeMajor)) {
    return null;
  }
  // 固定数组顺序序列化，避免键序变化造成同一个安装算出不同身份键。
  return JSON.stringify([bundleId, teamId, version, build, appAsarSha256.toLowerCase(), nodeMajor]);
}

/**
 * 强兼容授权的身份键：绑定签名身份、版本、build、ASAR哈希与内置Node主版本。
 * Codex再次更新后任一字段变化即得到新键，旧授权自动失效。
 */
export function compatibilityIdentityKey(facts) {
  const material = identityMaterial(facts);
  return material ? createHash('sha256').update(material).digest('hex') : null;
}

function validCompatibilityDocument(value) {
  return Boolean(value && typeof value === 'object'
    && value.bundleId === APPROVED_BUNDLE_ID
    && value.teamId === APPROVED_TEAM_ID
    && typeof value.version === 'string' && /^\d+(?:\.\d+){1,4}$/u.test(value.version)
    && typeof value.build === 'string' && /^\d{1,20}$/u.test(value.build)
    && typeof value.appAsarSha256 === 'string' && SHA256_PATTERN.test(value.appAsarSha256)
    && Number.isInteger(value.minimumNodeMajor) && value.minimumNodeMajor >= 24 && value.minimumNodeMajor <= 99);
}

/** 精确匹配签名身份、版本、build、ASAR哈希与Node下限，任一不同即关闭启用能力。 */
export function compatibilityErrorCode(installed, approved) {
  if (!validCompatibilityDocument(approved)) return 'COMPATIBILITY_MISSING';
  if (!installed || installed.bundleId !== approved.bundleId || installed.teamId !== approved.teamId) {
    return 'SIGNATURE_MISMATCH';
  }
  if (installed.version !== approved.version || installed.build !== approved.build
    || installed.appAsarSha256 !== approved.appAsarSha256
    || !Number.isInteger(installed.nodeMajor) || installed.nodeMajor < approved.minimumNodeMajor) {
    return 'VERSION_UNSUPPORTED';
  }
  return null;
}

/**
 * 用户一次性「强行兼容」的判定：只跳过与清单的版本、build和ASAR哈希比对。
 * 签名身份、清单缺失与内置Node硬下限永不因授权而放行；授权身份键与当前安装不一致即失效。
 */
export function forceCompatibilityErrorCode({ installed, approved, authorizedKey }) {
  if (!validCompatibilityDocument(approved)) return 'COMPATIBILITY_MISSING';
  if (!installed || installed.bundleId !== approved.bundleId || installed.teamId !== approved.teamId) {
    return 'SIGNATURE_MISMATCH';
  }
  if (compatibilityErrorCode(installed, approved) === null) return null;
  if (typeof authorizedKey !== 'string' || !SHA256_PATTERN.test(authorizedKey)) return 'VERSION_UNSUPPORTED';
  if (compatibilityIdentityKey(installed) !== authorizedKey) return 'VERSION_UNSUPPORTED';
  if (installed.nodeMajor < approved.minimumNodeMajor) return 'VERSION_UNSUPPORTED';
  return null;
}
