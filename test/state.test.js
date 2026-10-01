import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { UserError } from '../portal/lib/errors.js';
import { LOCK_DIR, LOCK_OWNER_FILE, STATE_FILE, currentFiles, isProcessAlive, loadState, saveState, withLock } from '../portal/lib/state.js';

const workRoot = mkdtempSync(path.join(os.tmpdir(), 'vas-state-'));
after(() => rmSync(workRoot, { recursive: true, force: true }));

let dir;
let counter = 0;
beforeEach(() => {
  counter += 1;
  dir = path.join(workRoot, `case-${counter}`);
});

const ENTRY = { parserVersion: 1, total: 500000, reason: 'ok', amounts: [{ krw: 500000 }], readAt: '2026-09-30T09:00:00.000Z' };

describe('loadState', () => {
  it('starts empty when nothing has been saved', () => {
    const state = loadState(dir);

    assert.deepEqual(state, { files: {}, lastReadAt: null });
  });

  it('returns a new object each time so callers cannot share it', () => {
    const first = loadState(dir);
    const second = loadState(dir);

    first.files.x = 1;

    assert.deepEqual(second.files, {});
  });

  it('reads back what was saved', () => {
    const state = { files: { 'abc:1': ENTRY }, lastReadAt: '2026-09-30T09:01:00.000Z' };
    saveState(dir, state);

    const loaded = loadState(dir);

    assert.deepEqual(loaded, state);
  });

  it('keeps fields it does not know so a newer format is not cut down', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({ files: {}, lastReadAt: null, future: { a: 1 } }));

    const loaded = loadState(dir);

    assert.deepEqual(loaded.future, { a: 1 });
  });

  it('fails with the file path when the JSON is broken', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, STATE_FILE), '{ 깨진');

    assert.throws(
      () => loadState(dir),
      (error) => error instanceof UserError && error.message.includes(STATE_FILE),
    );
  });

  it('fails when the content does not have the expected shape', () => {
    mkdirSync(dir, { recursive: true });
    for (const content of ['[]', 'null', '3', '{}', '{"files": []}', '{"files": "x"}']) {
      writeFileSync(path.join(dir, STATE_FILE), content);

      assert.throws(() => loadState(dir), UserError, content);
    }
  });

  it('fails clearly when the path cannot be read as a file', () => {
    mkdirSync(path.join(dir, STATE_FILE), { recursive: true });

    assert.throws(() => loadState(dir), UserError);
  });
});

describe('saveState', () => {
  it('creates the directory and a file only the owner can use', () => {
    saveState(dir, { files: {}, lastReadAt: null });

    assert.equal(statSync(path.join(dir, STATE_FILE)).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o077, 0);
  });

  it('replaces an earlier file and leaves no temporary file behind', () => {
    saveState(dir, { files: { a: ENTRY }, lastReadAt: null });

    saveState(dir, { files: { b: ENTRY }, lastReadAt: 'later' });

    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, STATE_FILE), 'utf8')).files, { b: ENTRY });
    assert.deepEqual(readdirSync(dir), [STATE_FILE]);
  });

  it('keeps the file owner-only when it replaces a file that was more open', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, STATE_FILE), '{"files":{},"lastReadAt":null}', { mode: 0o644 });

    saveState(dir, { files: {}, lastReadAt: null });

    assert.equal(statSync(path.join(dir, STATE_FILE)).mode & 0o777, 0o600);
  });

  it('does not modify the state it is given', () => {
    const state = Object.freeze({ files: Object.freeze({ a: ENTRY }), lastReadAt: null });

    saveState(dir, state);

    assert.ok(existsSync(path.join(dir, STATE_FILE)));
  });

  it('cleans up its temporary file and reports the failure when the file cannot be replaced', () => {
    mkdirSync(path.join(dir, STATE_FILE), { recursive: true });

    assert.throws(
      () => saveState(dir, { files: {}, lastReadAt: null }),
      (error) => error instanceof UserError && error.message.includes(STATE_FILE),
    );
    assert.deepEqual(readdirSync(dir), [STATE_FILE]);
  });
});

describe('currentFiles', () => {
  it('keeps only the results read with the current parser version', () => {
    const state = {
      files: {
        'a:1': { ...ENTRY, parserVersion: 1 },
        'b:1': { ...ENTRY, parserVersion: 0 },
        'c:1': { ...ENTRY, parserVersion: 2 },
        'd:1': null,
      },
      lastReadAt: null,
    };

    const current = currentFiles(state, 1);

    assert.deepEqual(Object.keys(current), ['a:1']);
  });

  it('returns an empty object for an empty state', () => {
    assert.deepEqual(currentFiles({ files: {}, lastReadAt: null }, 1), {});
  });
});

describe('withLock', () => {
  it('returns what the task returns, whether it is sync or async', async () => {
    assert.equal(await withLock(dir, () => 42), 42);
    assert.equal(await withLock(dir, async () => 'done'), 'done');
  });

  it('holds a lock folder while the task runs and removes it afterwards', async () => {
    let existedDuring;

    await withLock(dir, () => {
      existedDuring = existsSync(path.join(dir, LOCK_DIR));
    });

    assert.equal(existedDuring, true);
    assert.equal(existsSync(path.join(dir, LOCK_DIR)), false);
  });

  it('removes the lock and passes the error on when the task throws', async () => {
    await assert.rejects(
      withLock(dir, async () => {
        throw new Error('작업 실패');
      }),
      /작업 실패/,
    );

    assert.equal(existsSync(path.join(dir, LOCK_DIR)), false);
  });

  it('refuses a second run while the first holds the lock, and leaves the first lock alone', async () => {
    let secondError;

    await withLock(dir, async () => {
      try {
        await withLock(dir, () => 'never');
      } catch (error) {
        secondError = error;
      }
      assert.equal(existsSync(path.join(dir, LOCK_DIR)), true);
    });

    assert.ok(secondError instanceof UserError);
    assert.ok(secondError.message.includes(path.join(dir, LOCK_DIR)));
    assert.match(secondError.message, /실행 중/);
    assert.equal(existsSync(path.join(dir, LOCK_DIR)), false);
  });

  it('can be taken again after the previous holder finished', async () => {
    await withLock(dir, () => 1);

    assert.equal(await withLock(dir, () => 2), 2);
  });

  it('creates the state directory when it does not exist yet', async () => {
    await withLock(dir, () => undefined);

    assert.ok(existsSync(dir));
  });
});

describe('isProcessAlive', () => {
  const failing = (code) => () => {
    throw Object.assign(new Error(code), { code });
  };

  it('is true for a process that answers the check', () => {
    assert.equal(isProcessAlive(4242, () => true), true);
    assert.equal(isProcessAlive(process.pid), true);
  });

  it('is false only when the system says there is no such process', () => {
    assert.equal(isProcessAlive(4242, failing('ESRCH')), false);
  });

  it('is true for a process it is not allowed to signal, since that one exists', () => {
    assert.equal(isProcessAlive(4242, failing('EPERM')), true);
  });

  it('is true for any other failure, so a doubtful lock is never taken over', () => {
    assert.equal(isProcessAlive(4242, failing('EINVAL')), true);
  });

  it('checks with signal 0, which only tests that the process exists', () => {
    const seen = [];

    isProcessAlive(4242, (pid, signal) => seen.push([pid, signal]));

    assert.deepEqual(seen, [[4242, 0]]);
  });

  it('is false for the process id of a child that already ended', () => {
    const { pid } = spawnSync(process.execPath, ['-e', '']);

    assert.equal(isProcessAlive(pid), false);
  });
});

describe('withLock owner', () => {
  const lockPath = () => path.join(dir, LOCK_DIR);
  const ownerFile = () => path.join(lockPath(), LOCK_OWNER_FILE);
  const neverAsked = () => assert.fail('the owner must not be checked');

  function leaveLock(content) {
    mkdirSync(lockPath(), { recursive: true });
    if (content !== undefined) writeFileSync(ownerFile(), content);
  }

  it('writes its own process id into the lock folder while the task runs', async () => {
    let owner;

    await withLock(dir, () => {
      owner = readFileSync(ownerFile(), 'utf8');
    });

    assert.equal(owner, String(process.pid));
  });

  it('takes over a lock whose owner is no longer running, and removes it afterwards', async () => {
    leaveLock('4242');
    writeFileSync(path.join(lockPath(), 'leftover'), '이전 실행의 흔적');
    let during;

    const result = await withLock(
      dir,
      () => {
        during = readdirSync(lockPath()).sort();
        return 'ran';
      },
      { isAlive: (pid) => pid !== 4242 },
    );

    assert.equal(result, 'ran');
    assert.deepEqual(during, [LOCK_OWNER_FILE]);
    assert.equal(existsSync(lockPath()), false);
  });

  it('takes over the lock of a process that really ended', async () => {
    const { pid } = spawnSync(process.execPath, ['-e', '']);
    leaveLock(String(pid));

    const result = await withLock(dir, () => 'ran');

    assert.equal(result, 'ran');
  });

  it('asks about the owner it found, and only about that one', async () => {
    leaveLock('4242\n');
    const asked = [];

    await withLock(dir, () => undefined, { isAlive: (pid) => (asked.push(pid), false) });

    assert.deepEqual(asked, [4242]);
  });

  it('refuses a lock whose owner is still running, names the process and leaves the lock alone', async () => {
    leaveLock(String(process.pid));

    await assert.rejects(
      withLock(dir, () => 'never'),
      (error) => error instanceof UserError && /실행 중/.test(error.message) && error.message.includes(String(process.pid)) && error.message.includes(lockPath()),
    );

    assert.equal(readFileSync(ownerFile(), 'utf8'), String(process.pid));
  });

  it('refuses a lock that has no owner file, since it cannot tell whether anything is running', async () => {
    leaveLock();

    await assert.rejects(withLock(dir, () => 'never', { isAlive: neverAsked }), UserError);

    assert.equal(existsSync(lockPath()), true);
  });

  it('refuses a lock whose owner file does not hold a process id, without asking the system about it', async () => {
    for (const content of ['', 'abc', '0', '-5', '1e3', '12 34', '1.5', '99999999999', '0042x']) {
      leaveLock(content);

      await assert.rejects(withLock(dir, () => 'never', { isAlive: neverAsked }), UserError, JSON.stringify(content));

      assert.equal(existsSync(lockPath()), true);
    }
  });

  it('fails clearly when the owner file cannot be read', async () => {
    leaveLock();
    mkdirSync(ownerFile());

    await assert.rejects(
      withLock(dir, () => 'never', { isAlive: neverAsked }),
      (error) => error instanceof UserError && error.message.includes(ownerFile()),
    );
  });

  it('does not remove a lock that belongs to another run when its own attempt was refused', async () => {
    leaveLock(String(process.pid));

    await assert.rejects(withLock(dir, () => 'never'), UserError);

    assert.equal(existsSync(lockPath()), true);
  });
});
