import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveVaultFileHref } from '../src/uri-policy.mjs';

const vaultName = 'ExampleVault';

async function withVault(run) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'obsidian-link-'));
  const vaultRoot = path.join(temp, vaultName);
  const notePath = path.join(vaultRoot, 'Notes', '开发 计划.md');
  await mkdir(path.dirname(notePath), { recursive: true });
  await writeFile(notePath, '# 示例');
  try {
    await run({ temp, vaultRoot, notePath });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test('maps an existing Chinese Markdown file URI to an encoded Obsidian URI', async () => {
  await withVault(async ({ vaultRoot, notePath }) => {
    const href = pathToFileURL(notePath).href;
    const result = await resolveVaultFileHref(href, { vaultRoot, vaultName });
    assert.equal(
      result,
      'obsidian://open?vault=ExampleVault&file=Notes%2F%E5%BC%80%E5%8F%91+%E8%AE%A1%E5%88%92.md',
    );
  });
});

test('preserves a fragment as a note heading', async () => {
  await withVault(async ({ vaultRoot, notePath }) => {
    const href = `${pathToFileURL(notePath).href}#Heading%20one`;
    const result = await resolveVaultFileHref(href, { vaultRoot, vaultName });
    assert.match(result, /file=.*%23Heading\+one$/);
  });
});

test('ignores external, malformed, queried, credentialed, and non-Markdown URLs', async () => {
  await withVault(async ({ vaultRoot, notePath }) => {
    for (const href of [
      'https://example.com/note.md',
      'obsidian://open?vault=ExampleVault&file=missing.md',
      `${pathToFileURL(notePath).href}?download=1`,
      `file://user@${notePath}`,
      pathToFileURL(notePath.replace(/\.md$/, '.txt')).href,
      'file:///tmp/%E0%A4%A.md',
    ]) {
      assert.equal(await resolveVaultFileHref(href, { vaultRoot, vaultName }), null, href);
    }
  });
});

test('rejects a symbolic link that resolves outside the selected vault', async () => {
  await withVault(async ({ temp, vaultRoot, notePath }) => {
    const outside = path.join(temp, 'private.md');
    await writeFile(outside, 'private');
    const escape = path.join(vaultRoot, 'escape.md');
    await symlink(outside, escape);
    assert.equal(
      await resolveVaultFileHref(pathToFileURL(escape).href, { vaultRoot, vaultName }),
      null,
    );
  });
});
