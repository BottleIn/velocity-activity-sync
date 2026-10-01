import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { TEMP_PREFIX, removeLeftoverWorkDirs } from '../portal/lib/workdir.js';

const workRoot = mkdtempSync(path.join(os.tmpdir(), 'vas-workdir-'));
after(() => rmSync(workRoot, { recursive: true, force: true }));

let tmp;
let counter = 0;
beforeEach(() => {
  counter += 1;
  tmp = path.join(workRoot, `case-${counter}`);
  mkdirSync(tmp, { recursive: true });
});

function leftover(name, files = { 'receipt.pdf': '카드 영수증' }) {
  const folder = path.join(tmp, name);
  mkdirSync(folder, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(path.join(folder, file), content);
  return folder;
}

describe('TEMP_PREFIX', () => {
  it('is the prefix the run gives its working folders', () => {
    assert.equal(TEMP_PREFIX, 'velocity-sync-');
  });
});

describe('removeLeftoverWorkDirs', () => {
  it('removes the working folders an earlier run left behind, with what is in them', async () => {
    const first = leftover(`${TEMP_PREFIX}abc123`);
    const second = leftover(`${TEMP_PREFIX}def456`, { 'a.docx': 'x', 'portal-output.json': '{}' });

    const removed = await removeLeftoverWorkDirs(tmp);

    assert.deepEqual(removed.sort(), [`${TEMP_PREFIX}abc123`, `${TEMP_PREFIX}def456`]);
    assert.equal(existsSync(first), false);
    assert.equal(existsSync(second), false);
  });

  it('leaves everything that is not a working folder of this tool', async () => {
    leftover('other-folder');
    leftover('velocity-sync');
    leftover(`x${TEMP_PREFIX}abc`);
    writeFileSync(path.join(tmp, `${TEMP_PREFIX}a-plain-file`), '폴더가 아니다');

    const removed = await removeLeftoverWorkDirs(tmp);

    assert.deepEqual(removed, []);
    assert.deepEqual(readdirSync(tmp).sort(), ['other-folder', 'velocity-sync', `${TEMP_PREFIX}a-plain-file`, `x${TEMP_PREFIX}abc`].sort());
  });

  it('does not follow a link with the prefix, and does not delete what it points to', async () => {
    const target = leftover('somewhere-else', { 'keep.txt': '남의 파일' });
    symlinkSync(target, path.join(tmp, `${TEMP_PREFIX}link`));

    const removed = await removeLeftoverWorkDirs(tmp);

    assert.deepEqual(removed, []);
    assert.ok(lstatSync(path.join(tmp, `${TEMP_PREFIX}link`)).isSymbolicLink());
    assert.ok(existsSync(path.join(target, 'keep.txt')));
  });

  it('leaves folders that belong to another user', async () => {
    const folder = leftover(`${TEMP_PREFIX}theirs`);
    const owner = lstatSync(folder).uid;

    const removed = await removeLeftoverWorkDirs(tmp, { uid: owner + 1 });

    assert.deepEqual(removed, []);
    assert.ok(existsSync(folder));
  });

  it('removes the folders of the given owner', async () => {
    const folder = leftover(`${TEMP_PREFIX}mine`);

    const removed = await removeLeftoverWorkDirs(tmp, { uid: lstatSync(folder).uid });

    assert.deepEqual(removed, [`${TEMP_PREFIX}mine`]);
  });

  it('says how many it removed', async () => {
    leftover(`${TEMP_PREFIX}one`);
    leftover(`${TEMP_PREFIX}two`);
    const lines = [];

    await removeLeftoverWorkDirs(tmp, { log: (line) => lines.push(line) });

    assert.equal(lines.length, 1);
    assert.match(lines[0], /2개/);
  });

  it('stays quiet when there is nothing to remove', async () => {
    const lines = [];

    const removed = await removeLeftoverWorkDirs(tmp, { log: (line) => lines.push(line) });

    assert.deepEqual(removed, []);
    assert.deepEqual(lines, []);
  });

  it('treats a missing temporary folder as nothing to remove', async () => {
    const removed = await removeLeftoverWorkDirs(path.join(tmp, 'does-not-exist'));

    assert.deepEqual(removed, []);
  });

  it('reports a folder it cannot remove and goes on with the others', { skip: process.getuid?.() === 0 ? 'root can remove anything' : false }, async () => {
    const stuck = leftover(`${TEMP_PREFIX}stuck`);
    leftover(`${TEMP_PREFIX}fine`);
    chmodSync(stuck, 0o500);
    const lines = [];

    try {
      const removed = await removeLeftoverWorkDirs(tmp, { log: (line) => lines.push(line) });

      assert.deepEqual(removed, [`${TEMP_PREFIX}fine`]);
      assert.ok(lines.some((line) => line.includes(stuck)));
    } finally {
      chmodSync(stuck, 0o700);
    }
  });
});
