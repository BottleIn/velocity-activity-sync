import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { FILE_REASON, PARSER_VERSION } from '../portal/lib/amounts.js';
import { DEFAULT_CONFIG } from '../portal/lib/config.js';
import { EXIT, UserError } from '../portal/lib/errors.js';
import { LOCK_DIR, LOCK_OWNER_FILE, STATE_FILE, loadState, saveState } from '../portal/lib/state.js';
import { NOT_LOGGED_IN_MESSAGE, runSync } from '../portal/sync.js';
import { loadEvidenceFiles, loadPortalOutput } from './helpers/fixtures.js';
import { createHarness, writeScript } from './helpers/sync-harness.js';

const KEY_MATERIAL_PDF = '000000000000000000000000000003ec:1';
const KEY_ETC_DOCX = '000000000000000000000000000003ee:1';
const NOW_ISO = '2026-09-30T09:05:00.000Z';

const workRoot = mkdtempSync(path.join(os.tmpdir(), 'vas-sync-'));
after(() => rmSync(workRoot, { recursive: true, force: true }));

let root;
let counter = 0;
beforeEach(() => {
  counter += 1;
  root = path.join(workRoot, `case-${counter}`);
  mkdirSync(root, { recursive: true });
});

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail('a rejection was expected');
}

function sync(harness, overrides = {}) {
  return runSync({ dir: harness.dir, config: DEFAULT_CONFIG, deps: harness.deps, ...overrides });
}

describe('runSync on the synthetic portal', () => {
  it('reads everything, returns the expected money and leaves nothing behind', async () => {
    const harness = createHarness(root);

    const result = await sync(harness);

    assert.equal(result.money.spent, 2354500);
    assert.equal(result.money.available, 9645500);
    assert.equal(result.snapshot.applications.length, 12);
    assert.deepEqual(result.readStats, { readCount: 9, cachedCount: 0, failed: [] });
    assert.ok(result.report.includes('2,354,500원'));
    assert.ok(result.report.includes('1003-1차'));
    assert.deepEqual(readdirSync(harness.tmpDir), []);
    assert.equal(existsSync(path.join(harness.dir, LOCK_DIR)), false);
  });

  it('hands the browser the settings, the known files and private working paths', async () => {
    const harness = createHarness(root);

    await sync(harness);

    const [{ input, options, workDirMode }] = harness.runBrowser.calls;
    assert.equal(input.baseUrl, DEFAULT_CONFIG.baseUrl);
    assert.equal(input.menuNo, DEFAULT_CONFIG.menuNo);
    assert.equal(input.spaceName, DEFAULT_CONFIG.spaceName);
    assert.equal(input.maxListPages, DEFAULT_CONFIG.maxListPages);
    assert.equal(input.navTimeoutMs, DEFAULT_CONFIG.navTimeoutMs);
    assert.equal(input.fileTimeoutMs, DEFAULT_CONFIG.fileTimeoutMs);
    assert.deepEqual(input.knownFiles, []);
    assert.equal(path.dirname(input.downloadDir), harness.tmpDir);
    assert.equal(path.dirname(input.outputPath), input.downloadDir);
    assert.equal(workDirMode, 0o700);
    assert.equal(typeof options.timeoutMs, 'number');
    assert.ok(harness.runBrowser.calls[0].scriptText.startsWith('const INPUT = '));
  });

  it('keeps the results in an owner-only state file and records when it read', async () => {
    const harness = createHarness(root);

    await sync(harness);

    const state = loadState(harness.dir);
    assert.equal(Object.keys(state.files).length, 9);
    assert.ok(Object.values(state.files).every((entry) => entry.parserVersion === PARSER_VERSION));
    assert.equal(state.lastReadAt, NOW_ISO);
    assert.equal(statSync(path.join(harness.dir, STATE_FILE)).mode & 0o777, 0o600);
  });

  it('falls back to a silent log and the real clock when the caller passes undefined for them', async () => {
    const harness = createHarness(root);
    const before = Date.now();

    await sync(harness, { deps: { ...harness.deps, log: undefined, now: undefined } });

    const readAt = Date.parse(loadState(harness.dir).lastReadAt);
    assert.ok(readAt >= before && readAt <= Date.now());
  });

  it('logs progress so a long run is not silent', async () => {
    const harness = createHarness(root);

    await sync(harness);

    assert.ok(harness.logs.length >= 2);
  });

  it('skips known files on the next run and still reaches the same numbers', async () => {
    const harness = createHarness(root);
    const first = await sync(harness);

    const second = await sync(harness);

    const [, secondCall] = harness.runBrowser.calls;
    assert.equal(secondCall.input.knownFiles.length, 9);
    assert.deepEqual(second.money, first.money);
    assert.deepEqual(second.readStats, { readCount: 0, cachedCount: 9, failed: [] });
    assert.deepEqual(second.matrix, first.matrix);
  });

  it('reads again the files that an older parser version produced', async () => {
    const harness = createHarness(root);
    const stale = { parserVersion: PARSER_VERSION - 1, total: 1, reason: 'ok', amounts: [{ krw: 1 }], readAt: 'old' };
    saveState(harness.dir, { files: { [KEY_MATERIAL_PDF]: stale, 'other:9': { ...stale, parserVersion: PARSER_VERSION } }, lastReadAt: null });

    const result = await sync(harness);

    const [{ input }] = harness.runBrowser.calls;
    assert.deepEqual(input.knownFiles, ['other:9']);
    assert.equal(loadState(harness.dir).files[KEY_MATERIAL_PDF].total, 500000);
    assert.equal(result.money.spent, 2354500);
  });

  it('drops stored results of an older parser version instead of keeping them for good', async () => {
    const harness = createHarness(root);
    const stale = { parserVersion: PARSER_VERSION - 1, total: 1, reason: 'ok', amounts: [{ raw: '1원 홍길동 카드 1234-5678', krw: 1 }], readAt: 'old' };
    const current = { parserVersion: PARSER_VERSION, total: 5, reason: 'ok', amounts: [{ krw: 5 }], readAt: 'later' };
    saveState(harness.dir, { files: { 'gone:1': stale, 'other:9': current }, lastReadAt: null });

    await sync(harness);

    const { files } = loadState(harness.dir);
    assert.equal(Object.hasOwn(files, 'gone:1'), false);
    assert.deepEqual(files['other:9'], current);
    assert.equal(readFileSync(path.join(harness.dir, STATE_FILE), 'utf8').includes('1234-5678'), false);
  });

  it('drops them even when the run then stops because the page does not add up', async () => {
    const output = loadPortalOutput();
    output.listPages[0].text = output.listPages[0].text.replace('Total : 12', 'Total : 13');
    const harness = createHarness(root, { output });
    const stale = { parserVersion: PARSER_VERSION - 1, total: 1, reason: 'ok', amounts: [{ krw: 1 }], readAt: 'old' };
    saveState(harness.dir, { files: { 'gone:1': stale }, lastReadAt: null });

    await rejectionOf(sync(harness));

    assert.equal(Object.hasOwn(loadState(harness.dir).files, 'gone:1'), false);
  });

  it('does not use an outdated stored result when the file could not be read again', async () => {
    const stale = { parserVersion: PARSER_VERSION - 1, total: 1, reason: 'ok', amounts: [{ krw: 1 }], readAt: 'old' };
    const harness = createHarness(root, { downloadOverrides: { [KEY_MATERIAL_PDF]: { ok: false, status: 503 } } });
    saveState(harness.dir, { files: { [KEY_MATERIAL_PDF]: stale }, lastReadAt: null });

    const result = await sync(harness);

    const payment = result.snapshot.applications.find((application) => application.foundId === '1004').payments[0];
    assert.equal(payment.krw, null);
  });

  it('builds the pdf text tool once, when a pdf has to be read', async () => {
    const harness = createHarness(root);
    const missing = path.join(root, 'compiled', 'pdftext');
    const compiler = writeScript(
      root,
      'swiftc',
      `printf '%s\\n' "$*" >> "${root}/compiler-calls"\nprintf '#!/bin/sh\\ncat "$1"\\n' > "$3"\nchmod +x "$3"`,
    );
    const deps = { ...harness.deps, pdftextBin: missing, compiler, swiftSource: '/src/pdftext.swift' };

    const result = await sync(harness, { deps });

    const compilerCalls = readFileSync(path.join(root, 'compiler-calls'), 'utf8').trim().split('\n');
    assert.equal(compilerCalls.length, 1);
    const [flagO, flagOut, output, source] = compilerCalls[0].split(' ');
    assert.deepEqual([flagO, flagOut, source], ['-O', '-o', '/src/pdftext.swift']);
    assert.equal(path.dirname(output), path.dirname(missing));
    assert.ok(existsSync(missing));
    assert.equal(result.money.spent, 2354500);
  });

  it('does not build the pdf text tool when no pdf is downloaded', async () => {
    const onlyDocx = Object.fromEntries(Object.entries(loadEvidenceFiles()).filter(([, file]) => file.kind === 'docx'));
    const harness = createHarness(root, { evidenceFiles: onlyDocx });
    const compiler = writeScript(root, 'swiftc', `printf 'called' > "${root}/compiler-called"`);
    const deps = { ...harness.deps, pdftextBin: path.join(root, 'missing', 'pdftext'), compiler };

    await sync(harness, { deps });

    assert.equal(existsSync(path.join(root, 'compiler-called')), false);
  });

  it('does not build the pdf text tool for a download record that names no file type, and keeps that file as unsupported', async () => {
    const onlyDocx = Object.fromEntries(Object.entries(loadEvidenceFiles()).filter(([, file]) => file.kind === 'docx'));
    const harness = createHarness(root, { evidenceFiles: onlyDocx, downloadOverrides: { [KEY_ETC_DOCX]: { ext: undefined } } });
    const compiler = writeScript(root, 'swiftc', `printf 'called' > "${root}/compiler-called"`);
    const deps = { ...harness.deps, pdftextBin: path.join(root, 'missing', 'pdftext'), compiler };

    await sync(harness, { deps });

    assert.equal(existsSync(path.join(root, 'compiler-called')), false);
    assert.equal(loadState(harness.dir).files[KEY_ETC_DOCX].reason, FILE_REASON.UNSUPPORTED);
  });

  it('does not build the pdf text tool for an empty download record, and reports it as a file that was not received', async () => {
    const harness = createHarness(root, { outputOverrides: { downloads: [null] } });
    const compiler = writeScript(root, 'swiftc', `printf 'called' > "${root}/compiler-called"`);
    const deps = { ...harness.deps, pdftextBin: path.join(root, 'missing', 'pdftext'), compiler };

    const result = await sync(harness, { deps });

    assert.equal(existsSync(path.join(root, 'compiler-called')), false);
    assert.deepEqual(result.readStats.failed, [{ key: '', name: '', message: '파일 정보(key)가 올바르지 않아 건너뛰었습니다.' }]);
  });
});

describe('runSync and the folders an earlier run left behind', () => {
  function leaveWorkDir(harness, name = 'velocity-sync-earlier') {
    const folder = path.join(harness.tmpDir, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'receipt.pdf'), '카드 영수증');
    return folder;
  }

  it('removes them once it holds the lock, and says so', async () => {
    const harness = createHarness(root);
    const folder = leaveWorkDir(harness);

    await sync(harness);

    assert.equal(existsSync(folder), false);
    assert.deepEqual(readdirSync(harness.tmpDir), []);
    assert.ok(harness.logs.some((line) => line.includes('이전 실행이 남긴 임시 폴더 1개')));
  });

  it('removes them even when the run itself then fails', async () => {
    const harness = createHarness(root, { outputOverrides: { loggedIn: false, listPages: [] } });
    const folder = leaveWorkDir(harness);

    await rejectionOf(sync(harness));

    assert.equal(existsSync(folder), false);
  });

  it('does not touch them while another run holds the lock', async () => {
    const harness = createHarness(root);
    const folder = leaveWorkDir(harness);
    mkdirSync(path.join(harness.dir, LOCK_DIR), { recursive: true });
    writeFileSync(path.join(harness.dir, LOCK_DIR, LOCK_OWNER_FILE), String(process.pid));

    const error = await rejectionOf(sync(harness));

    assert.match(error.message, /실행 중/);
    assert.equal(existsSync(path.join(folder, 'receipt.pdf')), true);
    assert.equal(harness.runBrowser.calls.length, 0);
  });

  it('takes over the lock of a run that died, and cleans what that run left', async () => {
    const harness = createHarness(root);
    const folder = leaveWorkDir(harness);
    const { pid } = spawnSync(process.execPath, ['-e', '']);
    mkdirSync(path.join(harness.dir, LOCK_DIR), { recursive: true });
    writeFileSync(path.join(harness.dir, LOCK_DIR, LOCK_OWNER_FILE), String(pid));

    const result = await sync(harness);

    assert.equal(result.money.spent, 2354500);
    assert.equal(existsSync(folder), false);
    assert.equal(existsSync(path.join(harness.dir, LOCK_DIR)), false);
  });
});

describe('runSync when the portal cannot be read', () => {
  it('asks for a login when the browser is not logged in, with a distinct exit code', async () => {
    const harness = createHarness(root, { outputOverrides: { loggedIn: false, listPages: [], views: {}, evidences: {} } });

    const error = await rejectionOf(sync(harness));

    assert.ok(error instanceof UserError);
    assert.equal(error.exitCode, EXIT.NOT_LOGGED_IN);
    assert.equal(error.message, NOT_LOGGED_IN_MESSAGE);
    assert.equal(NOT_LOGGED_IN_MESSAGE, '포털에 로그인되어 있지 않습니다. Ego 브라우저에서 포털에 로그인한 뒤 다시 실행하세요.');
    assert.equal(existsSync(path.join(harness.dir, STATE_FILE)), false);
  });

  it('reports the reason the browser gave, and not a login request, when it stopped with an error', async () => {
    const harness = createHarness(root, { outputOverrides: { fatal: 'fetch failed', loggedIn: false } });

    const error = await rejectionOf(sync(harness));

    assert.equal(error.exitCode, EXIT.FAILURE);
    assert.match(error.message, /fetch failed/);
  });

  it('explains a login that dropped in the middle of the run', async () => {
    const harness = createHarness(root, { outputOverrides: { fatal: 'session_lost' } });

    const error = await rejectionOf(sync(harness));

    assert.equal(error.exitCode, EXIT.FAILURE);
    assert.match(error.message, /로그인이 풀렸/);
  });

  it('reports a failing browser with its exit code and error output', async () => {
    const result = { code: 1, stdout: '', stderr: '브라우저 오류 내용', timedOut: false, aborted: false };
    const harness = createHarness(root, { result, writeOutput: false });

    const error = await rejectionOf(sync(harness));

    assert.equal(error.exitCode, EXIT.FAILURE);
    assert.match(error.message, /종료 코드 1/);
    assert.match(error.message, /브라우저 오류 내용/);
  });

  it('reports a browser that ran past the time limit', async () => {
    const result = { code: null, stdout: '', stderr: '', timedOut: true, aborted: false };
    const harness = createHarness(root, { result, writeOutput: false });

    const error = await rejectionOf(sync(harness));

    assert.match(error.message, /제한 시간/);
  });

  it('reports a browser that finished without leaving a result file', async () => {
    const harness = createHarness(root, { writeOutput: false });

    const error = await rejectionOf(sync(harness));

    assert.match(error.message, /결과 파일/);
  });

  it('reports a result file that is not usable', async () => {
    for (const rawOutput of ['{ 깨진', '[]', 'null', '3']) {
      const harness = createHarness(path.join(root, `raw-${rawOutput.length}-${rawOutput.charCodeAt(0)}`), {
        writeOutput: false,
        onRun: (input) => writeFileSync(input.outputPath, rawOutput),
      });

      const error = await rejectionOf(sync(harness));

      assert.ok(error instanceof UserError, rawOutput);
      assert.match(error.message, /결과 파일/, rawOutput);
    }
  });

  it('stops with the interrupted exit code when the browser was aborted, and cleans up', async () => {
    const result = { code: null, stdout: '', stderr: '', timedOut: false, aborted: true };
    const harness = createHarness(root, { result, writeOutput: false });

    const error = await rejectionOf(sync(harness));

    assert.equal(error.exitCode, EXIT.INTERRUPTED);
    assert.deepEqual(readdirSync(harness.tmpDir), []);
    assert.equal(existsSync(path.join(harness.dir, LOCK_DIR)), false);
  });

  it('stops with the interrupted exit code when the caller aborts while the browser runs', async () => {
    const controller = new AbortController();
    const harness = createHarness(root, { onRun: () => controller.abort() });

    const error = await rejectionOf(sync(harness, { signal: controller.signal }));

    assert.equal(error.exitCode, EXIT.INTERRUPTED);
    assert.deepEqual(readdirSync(harness.tmpDir), []);
  });

  it('stops between two files when the caller aborts while they are being read, and cleans up', async () => {
    const controller = new AbortController();
    const harness = createHarness(root);
    const deps = {
      ...harness.deps,
      now: () => {
        controller.abort();
        return new Date(NOW_ISO);
      },
    };

    const error = await rejectionOf(sync(harness, { deps, signal: controller.signal }));

    assert.equal(error.exitCode, EXIT.INTERRUPTED);
    assert.deepEqual(readdirSync(harness.tmpDir), []);
    assert.equal(existsSync(path.join(harness.dir, LOCK_DIR)), false);
    assert.equal(loadState(harness.dir).lastReadAt, null);
  });

  it('reports a failing browser that printed nothing on its error output', async () => {
    const result = { code: 1, timedOut: false, aborted: false };
    const harness = createHarness(root, { result, writeOutput: false });

    const error = await rejectionOf(sync(harness));

    assert.equal(error.message, '브라우저 실행에 실패했습니다 (종료 코드 1).');
  });

  it('reports a browser that died from a signal without an exit code', async () => {
    const result = { code: null, stdout: '', stderr: '', timedOut: false, aborted: false };
    const harness = createHarness(root, { result, writeOutput: false });

    const error = await rejectionOf(sync(harness));

    assert.match(error.message, /종료 코드 없음/);
  });

  it('removes the working folder and the lock even when starting the browser throws', async () => {
    const harness = createHarness(root);
    const deps = {
      ...harness.deps,
      runBrowser: async () => {
        throw new UserError('ego-browser를 찾지 못했습니다.');
      },
    };

    const error = await rejectionOf(sync(harness, { deps }));

    assert.match(error.message, /ego-browser/);
    assert.deepEqual(readdirSync(harness.tmpDir), []);
    assert.equal(existsSync(path.join(harness.dir, LOCK_DIR)), false);
  });

  it('refuses to run while another run holds the lock, without starting the browser', async () => {
    const harness = createHarness(root);
    mkdirSync(path.join(harness.dir, LOCK_DIR), { recursive: true });

    const error = await rejectionOf(sync(harness));

    assert.match(error.message, /실행 중/);
    assert.equal(harness.runBrowser.calls.length, 0);
    assert.equal(existsSync(path.join(harness.dir, LOCK_DIR)), true);
  });

  it('refuses a damaged state file without starting the browser and releases the lock', async () => {
    const harness = createHarness(root);
    mkdirSync(harness.dir, { recursive: true });
    writeFileSync(path.join(harness.dir, STATE_FILE), '{ 깨진');

    const error = await rejectionOf(sync(harness));

    assert.ok(error instanceof UserError);
    assert.equal(harness.runBrowser.calls.length, 0);
    assert.equal(existsSync(path.join(harness.dir, LOCK_DIR)), false);
  });
});

describe('runSync when the page does not add up', () => {
  it('stops with the problems, keeps the files it already read, and does not mark the run as done', async () => {
    const output = loadPortalOutput();
    output.listPages[0].text = output.listPages[0].text.replace('Total : 12', 'Total : 13');
    const harness = createHarness(root, { output });

    const error = await rejectionOf(sync(harness));

    assert.equal(error.exitCode, EXIT.FAILURE);
    assert.match(error.message, /13건/);
    const state = loadState(harness.dir);
    assert.equal(Object.keys(state.files).length, 9);
    assert.equal(state.lastReadAt, null);
    assert.deepEqual(readdirSync(harness.tmpDir), []);
  });

  it('lists every problem it found, one per line', async () => {
    const output = loadPortalOutput();
    output.listPages[0].text = 'Total : 13\n총 승인금액 ₩ 1 / $ 0';
    const harness = createHarness(root, { output });

    const error = await rejectionOf(sync(harness));

    const lines = error.message.split('\n').filter((line) => line.startsWith('- '));
    assert.equal(lines.length, 2);
  });
});

describe('runSync when a file cannot be used', () => {
  it('records a download that failed, leaves it uncached and shows it in the report', async () => {
    const harness = createHarness(root, { downloadOverrides: { [KEY_MATERIAL_PDF]: { ok: false, status: 500 } } });

    const result = await sync(harness);

    assert.equal(result.readStats.failed.length, 1);
    assert.equal(result.readStats.failed[0].key, KEY_MATERIAL_PDF);
    assert.match(result.readStats.failed[0].message, /500/);
    assert.equal(result.readStats.readCount, 8);
    assert.equal(result.money.spent, 2354500 - 500000);
    assert.equal(result.money.unknownCount, 3);
    assert.ok(result.snapshot.warnings.some((warning) => warning.code === 'file_not_read' && warning.key === '1004'));
    assert.equal(Object.hasOwn(loadState(harness.dir).files, KEY_MATERIAL_PDF), false);
    assert.ok(result.report.includes('증빙 파일을 받지 못했습니다'));
  });

  it('survives download records that are missing or malformed', async () => {
    const harness = createHarness(root, { outputOverrides: { downloads: [null, 5, { key: 'x' }] } });

    const result = await sync(harness);

    assert.equal(result.readStats.failed.length, 3);
    assert.equal(result.readStats.readCount, 0);
  });

  it('runs on when the download list is missing altogether', async () => {
    const harness = createHarness(root, { outputOverrides: { downloads: 'x' } });

    const result = await sync(harness);

    assert.deepEqual(result.readStats, { readCount: 0, cachedCount: 0, failed: [] });
  });

  it('treats an HTML response like a failed download', async () => {
    const harness = createHarness(root, { downloadOverrides: { [KEY_MATERIAL_PDF]: { contentType: 'text/html;charset=UTF-8' } } });

    const result = await sync(harness);

    assert.equal(result.readStats.failed.length, 1);
    assert.match(result.readStats.failed[0].message, /HTML/);
    assert.equal(Object.hasOwn(loadState(harness.dir).files, KEY_MATERIAL_PDF), false);
  });

  it('uses a file it could not read this time, warns, and tries again on the next run', async () => {
    const harness = createHarness(root, { contentOverrides: { [KEY_ETC_DOCX]: 'BROKEN' } });

    const result = await sync(harness);

    const codes = result.snapshot.warnings.filter((warning) => warning.key === '1006').map((warning) => warning.code);
    assert.ok(codes.includes('file_unreadable'));
    assert.equal(result.money.spent, 2354500 - 6000);
    assert.equal(Object.hasOwn(loadState(harness.dir).files, KEY_ETC_DOCX), false);
    assert.ok(harness.logs.some((line) => line.includes('기타_사용료_증빙_내역서_가짜팀.docx')));

    await sync(harness);

    assert.ok(!harness.runBrowser.calls[1].input.knownFiles.includes(KEY_ETC_DOCX));
  });

  it('deletes downloaded files even when the run fails afterwards', async () => {
    const output = loadPortalOutput();
    output.listPages[0].text = output.listPages[0].text.replace('Total : 12', 'Total : 13');
    const harness = createHarness(root, { output });

    await rejectionOf(sync(harness));

    assert.deepEqual(readdirSync(harness.tmpDir), []);
  });
});
