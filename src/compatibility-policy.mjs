const APPROVED_BUNDLE_ID = 'com.openai.codex';
const APPROVED_TEAM_ID = '2DC432GLL2';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

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
