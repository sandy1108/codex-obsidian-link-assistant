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

test('preserves a fragment as an encoded note heading', async () => {
  await withVault(async ({ vaultRoot, notePath }) => {
    const href = `${pathToFileURL(notePath).href}#Heading%20one`;
    const result = await resolveVaultFileHref(href, { vaultRoot, vaultName });
    const url = new URL(result);
    assert.equal(url.protocol, 'obsidian:');
    assert.equal(url.searchParams.get('vault'), vaultName);
    assert.equal(url.searchParams.get('file'), 'Notes/开发 计划.md#Heading one');
    // #必须保留为%23；裸#会被Obsidian当作URI片段，标题无法传给笔记。
    assert.match(result, /%23Heading\+one$/u);
  });
});

test('ignores external, malformed, queried, and credentialed URLs', async () => {
  await withVault(async ({ vaultRoot, notePath }) => {
    for (const href of [
      'https://example.com/note.md',
      'obsidian://open?vault=ExampleVault&file=missing.md',
      `${pathToFileURL(notePath).href}?download=1`,
      `file://user@${notePath}`,
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

test('maps a POSIX absolute note path with a Codex line and column suffix', async () => {
  await withVault(async ({ vaultRoot, notePath }) => {
    assert.equal(
      await resolveVaultFileHref(`${notePath}:18:4`, { vaultRoot, vaultName }),
      'obsidian://open?vault=ExampleVault&file=Notes%2F%E5%BC%80%E5%8F%91+%E8%AE%A1%E5%88%92.md',
    );
  });
});

test('prefers a real filename ending in a colon and number over a line suffix', async () => {
  await withVault(async ({ vaultRoot }) => {
    const literal = path.join(vaultRoot, '真实文件.md:12');
    await writeFile(literal, 'literal');
    assert.equal(
      await resolveVaultFileHref(literal, { vaultRoot, vaultName }),
      'obsidian://open?vault=ExampleVault&file=%E7%9C%9F%E5%AE%9E%E6%96%87%E4%BB%B6.md%3A12',
    );
  });
});

test('creates Obsidian targets for existing attachments as well as Markdown', async () => {
  await withVault(async ({ vaultRoot }) => {
    const image = path.join(vaultRoot, 'attachments', '截图 1.png');
    await mkdir(path.dirname(image), { recursive: true });
    await writeFile(image, 'image');
    assert.equal(
      await resolveVaultFileHref(image, { vaultRoot, vaultName }),
      'obsidian://open?vault=ExampleVault&file=attachments%2F%E6%88%AA%E5%9B%BE+1.png',
    );
  });
});

test('preserves literal percent and hash characters in POSIX filenames', async () => {
  await withVault(async ({ vaultRoot }) => {
    const file = path.join(vaultRoot, 'attachments', 'hash#percent%.txt');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'text');
    assert.equal(
      await resolveVaultFileHref(file, { vaultRoot, vaultName }),
      'obsidian://open?vault=ExampleVault&file=attachments%2Fhash%23percent%25.txt',
    );
  });
});

test('rejects missing files, directories, management folders, and sibling-prefix paths', async () => {
  await withVault(async ({ temp, vaultRoot, notePath }) => {
    const sibling = `${vaultRoot}-backup${notePath.slice(vaultRoot.length)}`;
    const configFile = path.join(vaultRoot, '.obsidian', 'app.json');
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, '{}');
    for (const target of [
      path.join(vaultRoot, 'missing.md'),
      path.dirname(notePath),
      configFile,
      sibling,
      path.join(temp, 'outside.md'),
    ]) {
      assert.equal(await resolveVaultFileHref(target, { vaultRoot, vaultName }), null, target);
    }
  });
});

test('rejects a symbolic link to an attachment outside the selected vault', async () => {
  await withVault(async ({ temp, vaultRoot }) => {
    const outside = path.join(temp, 'private.pdf');
    await writeFile(outside, 'private');
    const escape = path.join(vaultRoot, 'escape.pdf');
    await symlink(outside, escape);
    assert.equal(await resolveVaultFileHref(escape, { vaultRoot, vaultName }), null);
  });
});
