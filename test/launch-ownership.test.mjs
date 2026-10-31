import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLaunchOwnershipStore, isOwnedVerifiedProcess } from '../src/launch-ownership.mjs';

const firstFingerprint = 'a'.repeat(64);
const secondFingerprint = 'b'.repeat(64);

async function withDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-launch-ownership-'));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('remembers and clears a validated launch fingerprint atomically', async () => {
  await withDirectory(async (stateRoot) => {
    const store = createLaunchOwnershipStore({ stateRoot });
    assert.equal(await store.read(), null);
    await store.remember(firstFingerprint);
    assert.equal(await store.read(), firstFingerprint);
    assert.equal((await stat(store.filePath)).mode & 0o777, 0o600);
    assert.equal((await stat(stateRoot)).mode & 0o777, 0o700);
    const document = JSON.parse(await readFile(store.filePath, 'utf8'));
    assert.equal(document.version, 1);
    assert.equal(document.fingerprint, firstFingerprint);
    assert.equal(typeof document.recordedAt, 'string');

    await Promise.all([store.remember(secondFingerprint), store.remember(firstFingerprint)]);
    assert.equal(await store.read(), firstFingerprint);
    await store.forget();
    assert.equal(await store.read(), null);
  });
});

test('fails closed for malformed, oversized, and symlinked ownership files', async () => {
  await withDirectory(async (stateRoot) => {
    const store = createLaunchOwnershipStore({ stateRoot });
    await writeFile(store.filePath, '{broken');
    assert.equal(await store.read(), null);

    await writeFile(store.filePath, JSON.stringify({
      version: 1, fingerprint: firstFingerprint, recordedAt: 'now', extra: true,
    }));
    assert.equal(await store.read(), null);

    await writeFile(store.filePath, JSON.stringify({
      version: 2, fingerprint: firstFingerprint, recordedAt: 'now',
    }));
    assert.equal(await store.read(), null);

    await writeFile(store.filePath, JSON.stringify({
      version: 1, fingerprint: 'not-a-fingerprint', recordedAt: 'now',
    }));
    assert.equal(await store.read(), null);

    await writeFile(store.filePath, 'x'.repeat(5000));
    assert.equal(await store.read(), null);

    const target = path.join(stateRoot, 'target.json');
    await writeFile(target, JSON.stringify({
      version: 1, fingerprint: firstFingerprint, recordedAt: 'now',
    }));
    const linkedRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-launch-link-'));
    try {
      const linkedStore = createLaunchOwnershipStore({ stateRoot: linkedRoot });
      await symlink(target, linkedStore.filePath);
      assert.equal(await linkedStore.read(), null);
    } finally {
      await rm(linkedRoot, { recursive: true, force: true });
    }
  });
});

test('rejects an invalid fingerprint without writing a record', async () => {
  await withDirectory(async (stateRoot) => {
    const store = createLaunchOwnershipStore({ stateRoot });
    await assert.rejects(store.remember('invalid'), TypeError);
    assert.equal(await store.read(), null);
    await assert.rejects(store.remember(undefined), TypeError);
  });
});

test('restores ownership only for the same verified CDP process after a new runtime starts', async () => {
  await withDirectory(async (stateRoot) => {
    const store = createLaunchOwnershipStore({ stateRoot });
    await store.remember(firstFingerprint);
    assert.equal(await isOwnedVerifiedProcess({
      endpoint: { port: 9341 }, fingerprint: firstFingerprint, store,
    }), true);
    assert.equal(await isOwnedVerifiedProcess({
      endpoint: null, fingerprint: firstFingerprint, store,
    }), false);
    assert.equal(await isOwnedVerifiedProcess({
      endpoint: { port: 9341 }, fingerprint: secondFingerprint, store,
    }), false);
    await store.forget();
    assert.equal(await isOwnedVerifiedProcess({
      endpoint: { port: 9341 }, fingerprint: firstFingerprint, store,
    }), false);
  });
});
