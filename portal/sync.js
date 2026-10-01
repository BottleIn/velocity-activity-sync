/**
 * 사무국 포털을 읽어 활동비 현황을 보여 주는 진입점이다. `node portal/sync.js [--json]`.
 *
 * 포털에는 아무것도 쓰지 않는다(portal/read-portal.js 머리말). Jira와 시트는 여기서 건드리지 않는다.
 * 종료 코드는 0 성공, 1 실패, 2 포털 로그인 필요, 130 사용자가 중단(lib/errors.js의 EXIT)이다.
 * 결과는 stdout에, 진행 메시지와 오류는 stderr에 쓴다. --json의 stdout이 JSON만 담게 하려는 것이다.
 */
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { PARSER_VERSION } from './lib/amounts.js';
import { buildBrowserScript, runBrowser as runEgoBrowser } from './lib/browser.js';
import { appDir, loadConfig, roundsOf } from './lib/config.js';
import { EXIT, UserError } from './lib/errors.js';
import { ensurePdftext, readDownload } from './lib/files.js';
import { stripControlCharacters } from './lib/format.js';
import { runJira } from './lib/jira-sync.js';
import { itemRoundMatrix, summarizeMoney } from './lib/money.js';
import { formatReport } from './lib/report.js';
import { buildSnapshot, validatePortal } from './lib/snapshot.js';
import { currentFiles, loadState, saveState, withLock } from './lib/state.js';
import { TEMP_PREFIX, removeLeftoverWorkDirs } from './lib/workdir.js';

export const NOT_LOGGED_IN_MESSAGE = '포털에 로그인되어 있지 않습니다. Ego 브라우저에서 포털에 로그인한 뒤 다시 실행하세요.';
const SESSION_LOST_MESSAGE = '읽는 도중 포털 로그인이 풀렸습니다. Ego 브라우저에서 다시 로그인한 뒤 실행하세요.';
const INTERRUPTED_MESSAGE = '중단되었습니다.';
const USAGE = '사용법: node portal/sync.js [--json] [--apply] [--first-run]';
const OUTPUT_FILE = 'portal-output.json';
const WORK_DIR_MODE = 0o700;
const BROWSER_TIMEOUT_MINUTES = 30;
const BROWSER_TIMEOUT_MS = BROWSER_TIMEOUT_MINUTES * 60 * 1000;
const STDERR_TAIL_LENGTH = 500;
const READ_PORTAL_URL = new URL('./read-portal.js', import.meta.url);
const PDFTEXT_SOURCE = fileURLToPath(new URL('./pdftext.swift', import.meta.url));

export function parseCliArgs(argv) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        json: { type: 'boolean', default: false },
        apply: { type: 'boolean', default: false },
        'first-run': { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    return { json: values.json, apply: values.apply, firstRun: values['first-run'] };
  } catch (error) {
    throw new UserError(`알 수 없는 인자입니다: ${argv.join(' ')}\n${USAGE}`, { cause: error });
  }
}

// 펼침(...deps)으로 덮어쓰면 undefined를 넘긴 항목이 기본값을 지워 버리므로, 항목마다 ??로 채운다.
function withDefaults(dir, deps) {
  return {
    ...deps,
    runBrowser: deps.runBrowser ?? runEgoBrowser,
    log: deps.log ?? (() => {}),
    now: deps.now ?? (() => new Date()),
    tmpDir: deps.tmpDir ?? os.tmpdir(),
    pdftextBin: deps.pdftextBin ?? path.join(dir, 'pdftext'),
    swiftSource: deps.swiftSource ?? PDFTEXT_SOURCE,
  };
}

function throwIfInterrupted(signal) {
  if (signal?.aborted) throw new UserError(INTERRUPTED_MESSAGE, { exitCode: EXIT.INTERRUPTED });
}

function stderrTail(stderr) {
  const text = String(stderr ?? '').trim();
  return text === '' ? '' : `\n${text.slice(-STDERR_TAIL_LENGTH)}`;
}

function assertBrowserFinished(run, signal) {
  if (run.aborted || signal?.aborted) throw new UserError(INTERRUPTED_MESSAGE, { exitCode: EXIT.INTERRUPTED });
  if (run.timedOut) {
    throw new UserError(`브라우저가 제한 시간(${BROWSER_TIMEOUT_MINUTES}분) 안에 끝나지 않아 멈췄습니다.${stderrTail(run.stderr)}`);
  }
  if (run.code !== 0) {
    throw new UserError(`브라우저 실행에 실패했습니다 (종료 코드 ${run.code ?? '없음'}).${stderrTail(run.stderr)}`);
  }
}

async function readOutput(outputPath) {
  let output;
  try {
    output = JSON.parse(await fs.readFile(outputPath, 'utf8'));
  } catch (error) {
    throw new UserError(`브라우저가 남긴 결과 파일을 읽지 못했습니다: ${error.message}`, { cause: error });
  }
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    throw new UserError('브라우저가 남긴 결과 파일의 형식이 올바르지 않습니다.');
  }
  return output;
}

// fatal을 먼저 본다. 로그인 확인 요청이 네트워크 오류로 실패해도 loggedIn은 false로 남기 때문에,
// 순서가 바뀌면 네트워크 오류가 "로그인하세요"로 잘못 안내된다.
function assertUsable(output) {
  if (output.fatal) {
    const message = output.fatal === 'session_lost' ? SESSION_LOST_MESSAGE : `포털을 읽는 중 오류가 났습니다: ${output.fatal}`;
    throw new UserError(message);
  }
  if (output.loggedIn !== true) throw new UserError(NOT_LOGGED_IN_MESSAGE, { exitCode: EXIT.NOT_LOGGED_IN });
}

async function collectOutput({ config, state, workDir, signal, tools }) {
  const outputPath = path.join(workDir, OUTPUT_FILE);
  const input = {
    baseUrl: config.baseUrl,
    menuNo: config.menuNo,
    spaceName: config.spaceName,
    outputPath,
    downloadDir: workDir,
    knownFiles: Object.keys(currentFiles(state, PARSER_VERSION)),
    maxListPages: config.maxListPages,
    navTimeoutMs: config.navTimeoutMs,
    fileTimeoutMs: config.fileTimeoutMs,
  };
  const source = tools.scriptSource ?? (await fs.readFile(READ_PORTAL_URL, 'utf8'));
  tools.log('브라우저로 포털을 읽는 중입니다. 신청과 증빙 파일이 많으면 몇 분 걸립니다.');
  const run = await tools.runBrowser(buildBrowserScript(source, input), { timeoutMs: BROWSER_TIMEOUT_MS, signal });
  assertBrowserFinished(run, signal);
  const output = await readOutput(outputPath);
  assertUsable(output);
  return output;
}

function needsPdftext(download) {
  return download?.ok === true && String(download.ext).toLowerCase() === 'pdf';
}

function summarizeReads(results, log) {
  const read = results.filter((result) => result.status === 'read');
  const failed = results.filter((result) => result.status === 'failed');
  for (const result of read) {
    if (result.detail) log(`파일을 읽지 못했습니다 (${result.name}): ${result.detail}`);
  }
  for (const result of failed) log(`파일을 받지 못했습니다 (${result.name}): ${result.message}`);
  return {
    fresh: Object.fromEntries(read.map((result) => [result.key, result.entry])),
    persisted: Object.fromEntries(read.filter((result) => result.persist).map((result) => [result.key, result.entry])),
    failed: failed.map(({ key, name, message }) => ({ key, name, message })),
    readCount: read.length,
  };
}

async function readEvidence({ output, workDir, signal, tools }) {
  const downloads = Array.isArray(output.downloads) ? output.downloads : [];
  if (downloads.some(needsPdftext)) {
    await ensurePdftext(tools.pdftextBin, tools.swiftSource, { compiler: tools.compiler });
  }
  if (downloads.length > 0) tools.log(`증빙 파일 ${downloads.length}개를 읽는 중입니다.`);
  const results = [];
  for (const download of downloads) {
    throwIfInterrupted(signal);
    results.push(
      await readDownload(download, {
        downloadDir: workDir,
        pdftextBin: tools.pdftextBin,
        unzipBin: tools.unzipBin,
        now: tools.now,
      }),
    );
  }
  return summarizeReads(results, tools.log);
}

function failIfInvalid(problems) {
  if (problems.length === 0) return;
  throw new UserError(['포털에서 읽은 내용이 서로 맞지 않아 중단했습니다.', ...problems.map((problem) => `- ${problem}`)].join('\n'));
}

function countCached(snapshot, cachedBefore, fresh) {
  const keys = new Set(snapshot.applications.flatMap((application) => application.files.map((file) => file.key)));
  return [...keys].filter((key) => Object.hasOwn(cachedBefore, key) && !Object.hasOwn(fresh, key)).length;
}

async function syncInWorkDir({ dir, config, signal, tools, workDir }) {
  const state = loadState(dir);
  const cachedBefore = currentFiles(state, PARSER_VERSION);
  const output = await collectOutput({ config, state, workDir, signal, tools });
  const reading = await readEvidence({ output, workDir, signal, tools });
  // 다른 판의 파서가 남긴 결과는 저장할 때 버린다. 다시 쓰이지도 않는데 예전 모양 그대로 파일에 남는 것을 막는다.
  const files = { ...cachedBefore, ...reading.persisted };
  // 검증이 실패해도 이미 읽은 증빙 결과는 남겨서 다음 실행에서 다시 받지 않게 한다. lastReadAt은 성공했을 때만 바꾼다.
  saveState(dir, { ...state, files });
  failIfInvalid(validatePortal(output));
  const fileResults = { ...files, ...reading.fresh };
  const snapshot = buildSnapshot({ output, fileResults, monthToRound: config.monthToRound });
  const money = summarizeMoney(snapshot, { limit: config.limit });
  const matrix = itemRoundMatrix(snapshot, { rounds: roundsOf(config.monthToRound) });
  saveState(dir, { ...state, files, lastReadAt: tools.now().toISOString() });
  const readStats = {
    readCount: reading.readCount,
    cachedCount: countCached(snapshot, cachedBefore, reading.fresh),
    failed: reading.failed,
  };
  return { snapshot, money, matrix, readStats, report: formatReport({ snapshot, money, matrix, readStats }) };
}

export async function runSync({ dir, config, signal, deps = {} }) {
  const tools = withDefaults(dir, deps);
  return withLock(dir, async () => {
    // 잠금을 잡은 뒤에 치운다. 잠금이 있어야 지금 쓰이는 폴더를 지우는 일이 없다.
    await removeLeftoverWorkDirs(tools.tmpDir, { log: tools.log });
    const workDir = await fs.mkdtemp(path.join(tools.tmpDir, TEMP_PREFIX));
    try {
      await fs.chmod(workDir, WORK_DIR_MODE);
      return await syncInWorkDir({ dir, config, signal, tools, workDir });
    } finally {
      // 증빙 파일에는 카드 영수증이 들어 있다. 성공하든 실패하든 임시 폴더째 지운다.
      // (files.js가 읽은 즉시 지우지만, 읽기 전에 끊긴 파일과 브라우저가 남긴 결과 파일까지 여기서 정리한다.)
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });
}

function toOutcome(error) {
  if (error instanceof UserError) return { code: error.exitCode, out: '', err: `${error.message}\n` };
  return { code: EXIT.FAILURE, out: '', err: `예상하지 못한 오류가 났습니다.\n${error?.stack ?? error}\n` };
}

export async function runCli({ argv = [], env = process.env, signal, deps = {} } = {}) {
  try {
    const { json, apply, firstRun } = parseCliArgs(argv);
    const dir = appDir(env);
    const config = loadConfig(dir);
    if (apply && !config.jira) throw new UserError('설정 파일에 jira 항목이 없어 Jira에 쓸 수 없습니다.');
    const { snapshot, money, matrix, readStats, report } = await runSync({ dir, config, signal, deps });
    if (json) return { code: EXIT.OK, out: `${JSON.stringify({ snapshot, money, matrix, readStats }, null, 2)}\n`, err: '' };
    const jira = config.jira ? await runJira({ config, snapshot, apply, firstRun, deps: deps.jira }) : { text: '' };
    return { code: EXIT.OK, out: `${report}${jira.text}`, err: '' };
  } catch (error) {
    return toOutcome(error);
  }
}

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// Ctrl-C(SIGINT), kill(SIGTERM), 터미널 창 닫기(SIGHUP)가 오면 브라우저를 멈추고 finally를 거쳐 임시 폴더와
// 잠금을 정리한 뒤 끝낸다. 기본 동작(즉시 종료)으로 두면 영수증이 든 임시 폴더와 잠금 폴더가 남는다.
// 같은 신호가 두 번째로 오면 기본 동작으로 바로 끝난다.
// 터미널로 나가는 글자는 모두 stripControlCharacters를 지난다. 파일 이름, 오류 메시지, 브라우저가 남긴 글에는 포털에서 온
// 글자가 들어 있고, 그 안의 제어 문자가 터미널을 조종할 수 있다. 보고서는 formatReport가 이미 지우지만 진행 메시지와 오류는 아니다.
export async function main(argv = process.argv.slice(2), env = process.env) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  for (const name of STOP_SIGNALS) process.once(name, stop);
  try {
    const outcome = await runCli({
      argv,
      env,
      signal: controller.signal,
      deps: { log: (line) => process.stderr.write(`${stripControlCharacters(line)}\n`) },
    });
    if (outcome.out !== '') process.stdout.write(stripControlCharacters(outcome.out));
    if (outcome.err !== '') process.stderr.write(stripControlCharacters(outcome.err));
    process.exitCode = outcome.code;
  } finally {
    for (const name of STOP_SIGNALS) process.off(name, stop);
  }
}

// import.meta.url은 실제 경로이고 process.argv[1]은 심볼릭 링크 경로일 수 있어서 realpath로 맞춰 비교한다.
export function isEntryPoint(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

// main이 잡지 못하고 새어 나온 실패를 마지막으로 알린다. 여기서도 제어 문자를 지운다.
export function reportUnexpected(error) {
  process.stderr.write(stripControlCharacters(`${error?.stack ?? error}\n`));
  process.exitCode = EXIT.FAILURE;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main().catch(reportUnexpected);
}
