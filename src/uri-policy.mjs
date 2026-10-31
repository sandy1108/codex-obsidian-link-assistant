import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const MANAGEMENT_DIRECTORIES = new Set(['.obsidian', '.git', '.trash']);

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function parseReference(href) {
  if (typeof href !== 'string' || /[\u0000-\u001f\u007f]/u.test(href)) return null;

  if (href.startsWith('/')) return { absolutePath: href, heading: '' };
  try {
    const url = new URL(href);
    if (url.protocol !== 'file:' || url.host !== '' || url.username || url.password
      || url.port || url.search) return null;
    let heading = '';
    if (url.hash) {
      try { heading = decodeURIComponent(url.hash.slice(1)); } catch { return null; }
      if (/[\u0000-\u001f\u007f]/u.test(heading)) return null;
    }
    return { absolutePath: fileURLToPath(url), heading };
  } catch {
    return null;
  }
}

function candidatePaths(absolutePath) {
  // 先尝试完整文件名；只有找不到时才把末尾的Codex行列号当作定位后缀。
  const candidates = [absolutePath];
  const match = /^(.*\.[^/:]+):[1-9]\d*(?::[1-9]\d*)?$/u.exec(absolutePath);
  if (match?.[1]) candidates.push(match[1]);
  return candidates;
}

function containsManagementDirectory(relativePath) {
  return relativePath.split(path.sep).some((segment) => MANAGEMENT_DIRECTORIES.has(segment));
}

/**
 * 将Codex原生绝对路径或旧版file URL转换为Vault文件的Obsidian链接。
 * 路径前缀只用于筛查；真实路径、文件类型与符号链接边界都在worker复核。
 */
export async function resolveVaultFileHref(href, { vaultRoot, vaultName }) {
  if (typeof vaultRoot !== 'string' || typeof vaultName !== 'string') return null;
  const reference = parseReference(href);
  if (!reference || !path.isAbsolute(reference.absolutePath)) return null;

  try {
    const realVaultRoot = await realpath(vaultRoot);
    let realNotePath = null;
    let noteStat = null;
    for (const candidate of candidatePaths(reference.absolutePath)) {
      try {
        const [resolved, info] = await Promise.all([realpath(candidate), stat(candidate)]);
        if (!info.isFile()) continue;
        realNotePath = resolved;
        noteStat = info;
        break;
      } catch { /* 不存在的完整路径可能是Codex追加行号后的值，继续验证去掉后缀的路径。 */ }
    }
    if (!realNotePath || !noteStat || !isWithin(realVaultRoot, realNotePath)) return null;

    const relativeNote = path.relative(realVaultRoot, realNotePath);
    if (containsManagementDirectory(relativeNote)) return null;
    const normalizedRelativeNote = relativeNote.split(path.sep).join('/');
    const extension = path.extname(normalizedRelativeNote).toLowerCase();
    if (reference.heading && extension !== '.md') return null;

    const params = new URLSearchParams();
    params.set('vault', vaultName);
    params.set('file', reference.heading
      ? `${normalizedRelativeNote}#${reference.heading}` : normalizedRelativeNote);
    return `obsidian://open?${params.toString()}`;
  } catch {
    return null;
  }
}
