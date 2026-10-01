// portal/sync.js를 진짜 프로그램으로 띄워, 포털에서 온 글자에 든 제어 문자가 터미널에 닿지 않는지 본다.
// 화면을 지우거나 창 제목을 바꾸는 이스케이프 시퀀스가 파일 이름이나 오류 메시지에 들어 있을 수 있다.
// 보고서(stdout)뿐 아니라 진행 메시지와 오류(stderr)도 같은 길로 터미널에 나간다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXIT } from '../portal/lib/errors.js';
import { writeScript } from './helpers/sync-harness.js';

const SYNC_SCRIPT = fileURLToPath(new URL('../portal/sync.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/portal-output.json', import.meta.url));
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

const workRoot = mkdtempSync(path.join(os.tmpdir(), 'vas-terminal-'));
after(() => rmSync(workRoot, { recursive: true, force: true }));

let root;
let counter = 0;
beforeEach(() => {
  counter += 1;
  root = path.join(workRoot, `case-${counter}`);
  mkdirSync(root, { recursive: true });
});

// 가짜 ego-browser가 시험 자료를 결과 파일로 쓰되, mutation이 지정한 곳에 이스케이프 시퀀스를 심는다.
function installBrowser(mutation) {
  const binDir = path.join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const moduleFile = path.join(binDir, 'fake-ego.cjs');
  writeFileSync(
    moduleFile,
    `const fs = require('node:fs');
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8').split('\\n', 1)[0].slice('const INPUT = '.length, -1));
  const output = JSON.parse(fs.readFileSync(${JSON.stringify(FIXTURE)}, 'utf8'));
  const HOSTILE = '\\u001b[2J\\u001b]0;pwned\\u0007';
  ${mutation}
  fs.writeFileSync(input.outputPath, JSON.stringify(output));
});
`,
  );
  writeScript(binDir, 'ego-browser', `exec "${process.execPath}" "${moduleFile}"`);
  return binDir;
}

function runProgram(mutation, args = []) {
  const binDir = installBrowser(mutation);
  const tmp = path.join(root, 'tmp');
  mkdirSync(tmp, { recursive: true });
  return spawnSync(process.execPath, [SYNC_SCRIPT, ...args], {
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, VELOCITY_SYNC_HOME: path.join(root, 'home'), TMPDIR: tmp },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

// 받기에 실패한 파일 하나의 이름에 이스케이프 시퀀스를 심는다. 진행 메시지(stderr)와 보고서(stdout)에 모두 나온다.
const HOSTILE_DOWNLOAD = `output.downloads = [{
    foundId: '1004', key: 'abc1:1', atchFileId: 'abc1', fileSn: '1', name: 'x' + HOSTILE + 'y.pdf',
    container: 'file_list_new', ext: 'pdf', path: input.downloadDir + '/abc1_1.pdf', ok: false, status: 500, contentType: '',
  }];`;

describe('portal/sync.js output when the portal text holds terminal escape sequences', () => {
  it('leaves no control character in the progress messages or in the report', () => {
    const run = runProgram(HOSTILE_DOWNLOAD);

    assert.equal(run.status, EXIT.OK, run.stderr);
    assert.equal(CONTROL.test(run.stdout), false);
    assert.equal(CONTROL.test(run.stderr), false);
    assert.ok(run.stderr.includes('x[2J]0;pwnedy.pdf'), run.stderr);
    assert.ok(run.stdout.includes('x[2J]0;pwnedy.pdf'));
  });

  it('leaves no control character in an error message that quotes what the browser reported', () => {
    const run = runProgram("output.loggedIn = false; output.fatal = 'boom' + HOSTILE;");

    assert.equal(run.status, EXIT.FAILURE);
    assert.equal(CONTROL.test(run.stderr), false);
    assert.ok(run.stderr.includes('boom[2J]0;pwned'), run.stderr);
  });

  it('keeps JSON output free of raw control characters as well', () => {
    const run = runProgram(HOSTILE_DOWNLOAD, ['--json']);

    assert.equal(run.status, EXIT.OK, run.stderr);
    assert.equal(CONTROL.test(run.stdout), false);
    assert.equal(CONTROL.test(run.stderr), false);
    assert.ok(JSON.parse(run.stdout).readStats.failed[0].name.includes('\u001b'));
  });
});
