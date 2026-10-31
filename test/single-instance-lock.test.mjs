import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireAssistantLock, readProcessStartTime } from '../src/single-instance-lock.mjs';

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

async function writeLock(stateRoot, record) {
  await writeFile(path.join(stateRoot, 'assistant.lock'), JSON.stringify(record));
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

test('refuses a second assistant while the lock owner is alive', async () => {
  await withStateRoot(async (stateRoot) => {
    const realStartTime = await readProcessStartTime(process.pid);
    assert.ok(realStartTime, '当前进程启动时间应可读取');
    const owner = { ...lockOptions(stateRoot), processStartTime: realStartTime };
    const first = await acquireAssistantLock(owner);
    await assert.rejects(
      acquireAssistantLock({ ...owner, token: 'test-token-2' }),
      (error) => error.code === 'ASSISTANT_LOCK_HELD',
    );
    await first.release();
  });
});

test('reclaims a stale lock whose owner process no longer exists', async () => {
  await withStateRoot(async (stateRoot) => {
    await writeLock(stateRoot, {
      version: 1, pid: 999999, processStartTime: 'Sat Oct 31 12:00:00 2026', token: 'dead-owner-token',
    });
    const lock = await acquireAssistantLock(lockOptions(stateRoot, 'test-token-2'));
    const record = JSON.parse(await readFile(path.join(stateRoot, 'assistant.lock'), 'utf8'));
    assert.equal(record.pid, process.pid);
    assert.equal(record.token, 'test-token-2');
    await lock.release();
  });
});

test('reclaims a lock whose PID was reused by a different process', async () => {
  await withStateRoot(async (stateRoot) => {
    await writeLock(stateRoot, {
      version: 1, pid: process.pid, processStartTime: 'Thu Jan  1 00:00:00 1970', token: 'reused-pid-token',
    });
    const lock = await acquireAssistantLock(lockOptions(stateRoot, 'test-token-2'));
    assert.equal(JSON.parse(await readFile(path.join(stateRoot, 'assistant.lock'), 'utf8')).token, 'test-token-2');
    await lock.release();
  });
});

test('refuses a fresh unparseable lock and reclaims an expired one', async () => {
  await withStateRoot(async (stateRoot) => {
    const lockPath = path.join(stateRoot, 'assistant.lock');
    await writeFile(lockPath, '{not-json');

    await assert.rejects(
      acquireAssistantLock(lockOptions(stateRoot)),
      (error) => error.code === 'ASSISTANT_LOCK_HELD',
    );

    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const lock = await acquireAssistantLock(lockOptions(stateRoot, 'test-token-2'));
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, 'test-token-2');
    await lock.release();
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
