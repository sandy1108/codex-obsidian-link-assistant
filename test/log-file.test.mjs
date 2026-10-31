import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLogWriter } from '../src/log-file.mjs';

async function withDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-log-file-'));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('rotates the log to a single backup before exceeding the size limit', async () => {
  await withDirectory(async (directory) => {
    const logPath = path.join(directory, 'state', 'assistant.log');
    const writer = createLogWriter({ filePath: logPath, maxBytes: 25 });
    await writer.append('first-line-0123456789\n');
    await writer.append('second-line-0123456789\n');
    await writer.append('third-line-0123456789\n');

    const current = await readFile(logPath, 'utf8');
    const backup = await readFile(`${logPath}.1`, 'utf8');
    assert.equal(current, 'third-line-0123456789\n');
    assert.equal(backup, 'second-line-0123456789\n');
    assert.equal((await stat(logPath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(logPath))).mode & 0o777, 0o700);
  });
});

test('truncates oversized lines and never throws when the log path is blocked', async () => {
  await withDirectory(async (directory) => {
    const blockedRoot = path.join(directory, 'blocked');
    await writeFile(blockedRoot, 'not a directory');
    const writer = createLogWriter({ filePath: path.join(blockedRoot, 'assistant.log'), maxBytes: 80 });
    await writer.append('will-not-be-written\n');
    assert.equal(await readFile(blockedRoot, 'utf8'), 'not a directory');

    const logPath = path.join(directory, 'assistant.log');
    const lineWriter = createLogWriter({ filePath: logPath, maxBytes: 1024 });
    await lineWriter.append(`${'x'.repeat(20_000)}\n`);
    const written = await readFile(logPath, 'utf8');
    assert.ok(written.length < 20_000);
    assert.ok(written.endsWith('\n'));
  });
});
