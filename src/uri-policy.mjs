import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

/**
 * 将Codex中的本地文件链接转换成Vault内现有笔记的Obsidian链接。
 * 拒绝模糊或越界目标；调用方应把null视作普通链接而不拦截。
 */
export async function resolveVaultFileHref(href, { vaultRoot, vaultName }) {
  if (typeof href !== 'string' || typeof vaultRoot !== 'string' || typeof vaultName !== 'string') {
    return null;
  }

  let url;
  let absolutePath;
  try {
    url = new URL(href);
    if (url.protocol !== 'file:' || url.host !== '' || url.username || url.password
      || url.port || url.search) return null;
    absolutePath = fileURLToPath(url);
  } catch {
    return null;
  }

  if (path.extname(absolutePath).toLowerCase() !== '.md') return null;
  let heading = '';
  if (url.hash) {
    try {
      heading = decodeURIComponent(url.hash.slice(1));
    } catch {
      return null;
    }
    if (/[\u0000-\u001f\u007f]/u.test(heading)) return null;
  }

  try {
    // 同时对根目录和笔记做真实路径比较，拒绝通过符号链接离开Vault。
    const [realVaultRoot, realNotePath] = await Promise.all([
      realpath(vaultRoot),
      realpath(absolutePath),
    ]);
    if (!isWithin(realVaultRoot, realNotePath)) return null;
    const relativeNote = path.relative(realVaultRoot, realNotePath).split(path.sep).join('/');
    if (path.extname(relativeNote).toLowerCase() !== '.md') return null;

    const params = new URLSearchParams();
    params.set('vault', vaultName);
    params.set('file', heading ? `${relativeNote}#${heading}` : relativeNote);
    return `obsidian://open?${params.toString()}`;
  } catch {
    return null;
  }
}
