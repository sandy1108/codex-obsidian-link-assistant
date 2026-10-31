import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireAssistantLock } from '../src/single-instance-lock.mjs';

async function withStateRoot(run) {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-link-lock-test-'));
  try {
    await run(stateRoot);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
}

function lockOptions(stateRoot, token = 'test-token-1') {
  return { stateRoot, pid: process.pid, processStartTime: 'Sat Oct 31 12:00:00 2026', token };
}

test('creates an exclusive private lock with the supplied process identity', async () => {
  await withStateRoot(async (stateRoot) => {
    const lock = await acquireAssistantLock(lockOptions(stateRoot));
    const record = JSON.parse(await readFile(path.join(stateRoot, 'assistant.lock'), 'utf8'));
    assert.deepEqual(record, {
      version: 1,
      pid: process.pid,
      processStartTime: 'Sat Oct 31 12:00:00 2026',
      token: 'test-token-1',
    });
    await lock.release();
  });
});

test('refuses a second assistant instead of taking over its lock', async () => {
  await withStateRoot(async (stateRoot) => {
    const first = await acquireAssistantLock(lockOptions(stateRoot));
    await assert.rejects(
      acquireAssistantLock(lockOptions(stateRoot, 'test-token-2')),
      (error) => error.code === 'ASSISTANT_LOCK_HELD',
    );
    await first.release();
  });
});

test('release removes only a lock that still carries this owner token', async () => {
  await withStateRoot(async (stateRoot) => {
    const lock = await acquireAssistantLock(lockOptions(stateRoot));
    const lockPath = path.join(stateRoot, 'assistant.lock');
    await writeFile(lockPath, JSON.stringify({ version: 1, pid: 9, processStartTime: 'other', token: 'other-owner' }));
    await lock.release();
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, 'other-owner');
    await rm(lockPath);
  });
});

test('rejects invalid lock identity data before creating the lock file', async () => {
  await withStateRoot(async (stateRoot) => {
    await assert.rejects(acquireAssistantLock({ ...lockOptions(stateRoot), pid: 0 }));
    await assert.rejects(acquireAssistantLock({ ...lockOptions(stateRoot), token: '' }));
    await assert.rejects(readFile(path.join(stateRoot, 'assistant.lock'), 'utf8'));
  });
});
