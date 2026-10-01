// portal/sync.js의 명령줄 쪽을 본다. 인자 해석, runCli가 돌려주는 결과, 마지막 오류 알림, 진입점 판정,
// 그리고 가짜 ego-browser를 PATH에 두고 진짜 프로그램으로 띄운 실행이다. 읽기 흐름 자체는 test/sync.test.js가 본다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EXIT, UserError } from '../portal/lib/errors.js';
import { STATE_FILE } from '../portal/lib/state.js';
import { NOT_LOGGED_IN_MESSAGE, isEntryPoint, parseCliArgs, reportUnexpected, runCli } from '../portal/sync.js';
import { createHarness, writeScript } from './helpers/sync-harness.js';

const SYNC_SCRIPT = fileURLToPath(new URL('../portal/sync.js', import.meta.url));
const BUILDER_URL = new URL('./helpers/portal-builder.js', import.meta.url).href;

const workRoot = mkdtempSync(path.join(os.tmpdir(), 'vas-sync-cli-'));
after(() => rmSync(workRoot, { recursive: true, force: true }));

let root;
let counter = 0;
beforeEach(() => {
  counter += 1;
  root = path.join(workRoot, `case-${counter}`);
  mkdirSync(root, { recursive: true });
});

describe('parseCliArgs', () => {
  it('reads the json, apply and first-run flags', () => {
    assert.deepEqual(parseCliArgs([]), { json: false, apply: false, firstRun: false });
    assert.deepEqual(parseCliArgs(['--json']), { json: true, apply: false, firstRun: false });
    assert.deepEqual(parseCliArgs(['--apply', '--first-run']), { json: false, apply: true, firstRun: true });
  });

  it('rejects anything else with the usage line', () => {
    for (const argv of [['--nope'], ['extra'], ['--json', '--x'], ['-j']]) {
      assert.throws(
        () => parseCliArgs(argv),
        (error) => error instanceof UserError && error.message.includes('사용법: node portal/sync.js [--json]'),
        argv.join(' '),
      );
    }
  });
});

describe('runCli', () => {
  it('prints the text report by default', async () => {
    const harness = createHarness(root);

    const outcome = await runCli({ argv: [], env: { VELOCITY_SYNC_HOME: harness.dir }, deps: harness.deps });

    assert.equal(outcome.code, EXIT.OK);
    assert.equal(outcome.err, '');
    assert.ok(outcome.out.startsWith('활동비 포털 읽기 결과'));
    assert.ok(outcome.out.includes('9,645,500원'));
  });

  it('prints only JSON with the snapshot, the money and the matrix when asked', async () => {
    const harness = createHarness(root);

    const outcome = await runCli({ argv: ['--json'], env: { VELOCITY_SYNC_HOME: harness.dir }, deps: harness.deps });

    const parsed = JSON.parse(outcome.out);
    assert.equal(outcome.code, EXIT.OK);
    assert.deepEqual(Object.keys(parsed), ['snapshot', 'money', 'matrix', 'readStats']);
    assert.equal(parsed.money.available, 9645500);
    assert.equal(parsed.snapshot.applications.length, 12);
  });

  it('reads the config file in the app folder', async () => {
    const harness = createHarness(root);
    mkdirSync(harness.dir, { recursive: true });
    writeFileSync(path.join(harness.dir, 'config.json'), JSON.stringify({ limit: 10000000 }));

    const outcome = await runCli({ argv: ['--json'], env: { VELOCITY_SYNC_HOME: harness.dir }, deps: harness.deps });

    assert.equal(JSON.parse(outcome.out).money.limit, 10000000);
  });

  it('fails with the message and the exit code of a known error', async () => {
    const harness = createHarness(root, { outputOverrides: { loggedIn: false, listPages: [] } });

    const outcome = await runCli({ argv: [], env: { VELOCITY_SYNC_HOME: harness.dir }, deps: harness.deps });

    assert.equal(outcome.code, EXIT.NOT_LOGGED_IN);
    assert.equal(outcome.out, '');
    assert.equal(outcome.err, `${NOT_LOGGED_IN_MESSAGE}\n`);
  });

  it('fails on an unknown option before it touches anything', async () => {
    const harness = createHarness(root);

    const outcome = await runCli({ argv: ['--nope'], env: { VELOCITY_SYNC_HOME: harness.dir }, deps: harness.deps });

    assert.equal(outcome.code, EXIT.FAILURE);
    assert.match(outcome.err, /사용법/);
    assert.equal(harness.runBrowser.calls.length, 0);
    assert.equal(existsSync(harness.dir), false);
  });

  it('fails on a bad config file', async () => {
    const harness = createHarness(root);
    mkdirSync(harness.dir, { recursive: true });
    writeFileSync(path.join(harness.dir, 'config.json'), JSON.stringify({ limt: 1 }));

    const outcome = await runCli({ argv: [], env: { VELOCITY_SYNC_HOME: harness.dir }, deps: harness.deps });

    assert.equal(outcome.code, EXIT.FAILURE);
    assert.match(outcome.err, /limt/);
  });

  it('reports something that is not an Error object as an unexpected failure', async () => {
    const harness = createHarness(root);
    const deps = {
      ...harness.deps,
      runBrowser: async () => {
        throw '문자열로 던진 실패';
      },
    };

    const outcome = await runCli({ argv: [], env: { VELOCITY_SYNC_HOME: harness.dir }, deps });

    assert.equal(outcome.code, EXIT.FAILURE);
    assert.match(outcome.err, /문자열로 던진 실패/);
  });

  it('shows the stack of an unexpected error so the cause can be traced', async () => {
    const harness = createHarness(root);
    const deps = {
      ...harness.deps,
      runBrowser: async () => {
        throw new TypeError('예상 밖의 결함');
      },
    };

    const outcome = await runCli({ argv: [], env: { VELOCITY_SYNC_HOME: harness.dir }, deps });

    assert.equal(outcome.code, EXIT.FAILURE);
    assert.match(outcome.err, /예상하지 못한 오류/);
    assert.match(outcome.err, /예상 밖의 결함/);
    assert.match(outcome.err, /TypeError/);
    assert.match(outcome.err, /at /);
  });
});

// main이 잡지 못하고 새어 나온 실패를 마지막으로 알리는 곳이다.
describe('reportUnexpected', () => {
  // 표준 오류로 나가는 글을 가로채고, 이 시험이 프로세스의 종료 코드와 stderr를 바꿔 놓은 채 끝나지 않게 되돌린다.
  function report(error) {
    const written = [];
    const originalWrite = process.stderr.write;
    const originalExitCode = process.exitCode;
    process.stderr.write = (text) => {
      written.push(String(text));
      return true;
    };
    try {
      reportUnexpected(error);
      return { text: written.join(''), exitCode: process.exitCode };
    } finally {
      process.stderr.write = originalWrite;
      process.exitCode = originalExitCode;
    }
  }

  it('writes the stack of the failure and sets the failure exit code', () => {
    const { text, exitCode } = report(new TypeError('예상 밖의 결함'));

    assert.match(text, /TypeError: 예상 밖의 결함/);
    assert.match(text, /at /);
    assert.equal(exitCode, EXIT.FAILURE);
  });

  it('writes something that is not an Error as it is', () => {
    assert.equal(report('문자열로 던진 실패').text, '문자열로 던진 실패\n');
    assert.equal(report(undefined).text, 'undefined\n');
  });

  it('removes control characters, since the message may quote text from the portal', () => {
    const { text } = report(new Error('boom\u001b[2J\u0007'));

    assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text), false);
    assert.match(text, /boom\[2J/);
  });
});

// import.meta.url은 언제나 심볼릭 링크가 풀린 실제 경로다. macOS의 임시 폴더(/var/...)는 /private/var/...를 가리키는
// 링크라서, 이 시험의 경로도 그 함정을 그대로 밟는다.
describe('isEntryPoint', () => {
  const metaUrlOf = (file) => pathToFileURL(realpathSync(file)).href;

  it('recognizes the file that node was started with', () => {
    const file = path.join(root, 'entry.js');
    writeFileSync(file, '');

    assert.equal(isEntryPoint(metaUrlOf(file), file), true);
  });

  it('recognizes it through a symbolic link, which node reports by its link path', () => {
    const real = path.join(root, 'real.js');
    const link = path.join(root, 'link.js');
    writeFileSync(real, '');
    symlinkSync(real, link);

    assert.equal(isEntryPoint(metaUrlOf(real), link), true);
  });

  it('is false for another file, a missing path or no path at all', () => {
    const file = path.join(root, 'entry.js');
    const other = path.join(root, 'other.js');
    writeFileSync(file, '');
    writeFileSync(other, '');

    assert.equal(isEntryPoint(metaUrlOf(file), other), false);
    assert.equal(isEntryPoint(metaUrlOf(file), path.join(root, 'missing.js')), false);
    assert.equal(isEntryPoint(metaUrlOf(file), undefined), false);
    assert.equal(isEntryPoint(metaUrlOf(file), ''), false);
  });
});

describe('portal/sync.js started as a program with a stand-in for ego-browser', () => {
  function installFakeEgoBrowser(mode) {
    const binDir = path.join(root, 'fake-bin');
    mkdirSync(binDir, { recursive: true });
    const moduleFile = path.join(binDir, 'fake-ego.cjs');
    writeFileSync(
      moduleFile,
      `const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', async () => {
  const script = Buffer.concat(chunks).toString('utf8');
  const input = JSON.parse(script.split('\\n', 1)[0].slice('const INPUT = '.length, -1));
  const { makePortal } = await import(${JSON.stringify(BUILDER_URL)});
  const output = ${mode === 'logged-out' ? "{ ...makePortal([]), loggedIn: false, listPages: [] }" : "makePortal([{ foundId: '2001', approved: 0 }])"};
  require('node:fs').writeFileSync(input.outputPath, JSON.stringify(output));
  console.log(JSON.stringify({ loggedIn: output.loggedIn }));
});
`,
    );
    writeScript(binDir, 'ego-browser', `exec "${process.execPath}" "${moduleFile}"`);
    return binDir;
  }

  function runProgram(args, mode) {
    const binDir = installFakeEgoBrowser(mode);
    const tmp = path.join(root, 'program-tmp');
    mkdirSync(tmp, { recursive: true });
    const appHome = path.join(root, 'program-home');
    const run = spawnSync(process.execPath, [SYNC_SCRIPT, ...args], {
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, VELOCITY_SYNC_HOME: appHome, TMPDIR: tmp },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { run, tmp, appHome };
  }

  it('exits with the login exit code and the login message when the browser is logged out', () => {
    const { run, tmp } = runProgram([], 'logged-out');

    assert.equal(run.status, EXIT.NOT_LOGGED_IN);
    assert.equal(run.stdout, '');
    assert.ok(run.stderr.includes(NOT_LOGGED_IN_MESSAGE));
    assert.deepEqual(readdirSync(tmp), []);
  });

  it('prints the report on standard output and exits cleanly when the portal reads fine', () => {
    const { run, tmp, appHome } = runProgram([], 'empty');

    assert.equal(run.status, EXIT.OK, run.stderr);
    assert.ok(run.stdout.startsWith('활동비 포털 읽기 결과'));
    assert.ok(existsSync(path.join(appHome, STATE_FILE)));
    assert.deepEqual(readdirSync(tmp), []);
  });

  it('prints pure JSON on standard output with --json and keeps progress messages on standard error', () => {
    const { run } = runProgram(['--json'], 'empty');

    assert.equal(run.status, EXIT.OK, run.stderr);
    assert.deepEqual(Object.keys(JSON.parse(run.stdout)), ['snapshot', 'money', 'matrix', 'readStats']);
    assert.notEqual(run.stderr, '');
  });

  it('exits with a failure and the usage line for an unknown option', () => {
    const { run } = runProgram(['--nope'], 'empty');

    assert.equal(run.status, EXIT.FAILURE);
    assert.match(run.stderr, /사용법/);
  });

  it('does not run when it is only imported', () => {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(SYNC_SCRIPT).href)}); console.log('imported');`], {
      encoding: 'utf8',
      timeout: 30_000,
    });

    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'imported');
    assert.equal(run.stderr, '');
  });
});
