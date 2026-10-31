import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// RED期让缺少的实现表现为普通断言失败，而不是模块加载错误。
const settingsModule = await import('../src/vault-settings.mjs').catch(() => null);
const createVaultSettingsStore = settingsModule?.createVaultSettingsStore ?? (() => ({
  read: async () => ({ configured: false }),
  save: async () => null,
}));

async function withDirectories(run) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-vault-settings-'));
  const stateRoot = path.join(temp, 'state');
  const vaultRoot = path.join(temp, '知识库 Notes');
  await mkdir(path.join(vaultRoot, '.obsidian'), { recursive: true });
  try { await run({ temp, stateRoot, vaultRoot }); }
  finally { await rm(temp, { recursive: true, force: true }); }
}

test('saves a validated single Vault atomically and reads the canonical path back', async () => {
  await withDirectories(async ({ stateRoot, vaultRoot }) => {
    const store = createVaultSettingsStore({ stateRoot, recommendedVaultRoot: vaultRoot });
    const canonicalVaultRoot = await realpath(vaultRoot);
    assert.deepEqual(await store.read(), {
      configured: false,
      vaultRoot: null,
      vaultName: null,
      recommendedVaultRoot: vaultRoot,
      errorCode: 'VAULT_NOT_CONFIGURED',
    });
    assert.equal(await stat(stateRoot).catch(() => null), null);

    const saved = await store.save(vaultRoot);
    assert.deepEqual(saved, {
      configured: true,
      vaultRoot: canonicalVaultRoot,
      vaultName: path.basename(canonicalVaultRoot),
      recommendedVaultRoot: null,
      errorCode: null,
    });
    assert.deepEqual(await store.read(), saved);
    const settingsFile = path.join(stateRoot, 'settings.json');
    assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')), { version: 1, vaultRoot: canonicalVaultRoot });
    assert.equal((await stat(settingsFile)).mode & 0o777, 0o600);
  });
});

test('does not embed a default Vault path and ignores an invalid recommendation', async () => {
  await withDirectories(async ({ stateRoot }) => {
    const store = createVaultSettingsStore({ stateRoot });
    assert.deepEqual(await store.read(), {
      configured: false,
      vaultRoot: null,
      vaultName: null,
      recommendedVaultRoot: null,
      errorCode: 'VAULT_NOT_CONFIGURED',
    });
    const invalidRecommendation = createVaultSettingsStore({
      stateRoot,
      recommendedVaultRoot: 'relative/path',
    });
    assert.equal((await invalidRecommendation.read()).recommendedVaultRoot, null);
  });
});

test('rejects a directory without an initialized Obsidian config and preserves saved settings', async () => {
  await withDirectories(async ({ temp, stateRoot, vaultRoot }) => {
    const invalidRoot = path.join(temp, 'ordinary folder');
    await mkdir(invalidRoot);
    const store = createVaultSettingsStore({ stateRoot, recommendedVaultRoot: vaultRoot });
    const canonicalVaultRoot = await realpath(vaultRoot);
    await store.save(vaultRoot);
    await assert.rejects(store.save(invalidRoot), (error) => error.code === 'VAULT_DIRECTORY_INVALID');
    assert.deepEqual(await store.read(), {
      configured: true,
      vaultRoot: canonicalVaultRoot,
      vaultName: path.basename(canonicalVaultRoot),
      recommendedVaultRoot: null,
      errorCode: null,
    });
  });
});

test('reports malformed settings without replacing them or silently choosing a Vault', async () => {
  await withDirectories(async ({ stateRoot, vaultRoot }) => {
    await mkdir(stateRoot, { recursive: true });
    const settingsFile = path.join(stateRoot, 'settings.json');
    await writeFile(settingsFile, '{broken');
    const store = createVaultSettingsStore({ stateRoot, recommendedVaultRoot: vaultRoot });
    assert.deepEqual(await store.read(), {
      configured: false,
      vaultRoot: null,
      vaultName: null,
      recommendedVaultRoot: vaultRoot,
      errorCode: 'VAULT_SETTINGS_INVALID',
    });
    assert.equal(await readFile(settingsFile, 'utf8'), '{broken');
  });
});

test('maps a blocked settings directory to the stable write-failed error code', async () => {
  await withDirectories(async ({ stateRoot, vaultRoot }) => {
    await writeFile(stateRoot, 'state path is occupied by a file');
    const store = createVaultSettingsStore({ stateRoot, recommendedVaultRoot: vaultRoot });

    await assert.rejects(store.save(vaultRoot), (error) => error.code === 'VAULT_SETTINGS_WRITE_FAILED');
    assert.equal(await readFile(stateRoot, 'utf8'), 'state path is occupied by a file');
  });
});
