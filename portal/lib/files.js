/**
 * 내려받은 증빙 파일에서 글자를 뽑고 금액을 읽는 입출력 계층이다.
 *
 * 증빙 파일에는 카드 영수증이 들어 있다. 그래서 읽는 즉시 지우고(readDownload), 외부 프로그램은
 * 셸을 거치지 않는 execFile로만 부른다. 파일 이름이 셸 명령으로 해석될 여지를 없애려는 것이다.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { FILE_REASON, PARSER_VERSION, docxXmlToText, extractAmounts } from './amounts.js';
import { UserError } from './errors.js';

const execFileAsync = promisify(execFile);

const DOCX_MAIN_PART = 'word/document.xml';
// 암호가 걸린 docx를 만나면 unzip이 터미널에서 암호를 물어 기다린다. 아무 암호나 주면 묻지 않고 실패한다.
const UNZIP_DUMMY_PASSWORD = 'x';
const EXEC_OPTIONS = { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: 60_000 };
const COMPILE_OPTIONS = { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: 5 * 60_000 };
const UNZIP_WARNING_EXIT = 1;
const DOWNLOAD_KEY = /^[A-Za-z0-9-]+:\d+$/;
const DETAIL_MAX_LENGTH = 300;
const DIR_MODE = 0o700;

function describeFailure(error) {
  return String(error.stderr || error.message).trim().slice(0, DETAIL_MAX_LENGTH);
}

// unzip은 경고만 있고 끝까지 처리했을 때 종료 코드 1을 돌려준다. 이때 출력이 있으면 그대로 쓴다.
async function runForText(command, args, { convert = (text) => text, toleratesWarning = false } = {}) {
  try {
    const { stdout } = await execFileAsync(command, args, EXEC_OPTIONS);
    return { text: convert(stdout) };
  } catch (error) {
    const isSalvageable =
      toleratesWarning && error.code === UNZIP_WARNING_EXIT && typeof error.stdout === 'string' && error.stdout !== '';
    if (isSalvageable) return { text: convert(error.stdout) };
    return { reason: FILE_REASON.UNREADABLE, detail: describeFailure(error) };
  }
}

export async function extractText(filePath, ext, { pdftextBin, unzipBin = 'unzip' } = {}) {
  const extension = String(ext ?? '').toLowerCase();
  if (extension === 'docx') {
    const args = ['-p', '-P', UNZIP_DUMMY_PASSWORD, filePath, DOCX_MAIN_PART];
    return runForText(unzipBin, args, { convert: docxXmlToText, toleratesWarning: true });
  }
  if (extension === 'pdf') {
    if (!pdftextBin) return { reason: FILE_REASON.UNREADABLE, detail: 'PDF 글자 추출기 경로가 없습니다.' };
    return runForText(pdftextBin, [filePath]);
  }
  return { reason: FILE_REASON.UNSUPPORTED };
}

async function statOrNull(file) {
  try {
    return await fs.stat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new UserError(`파일이 있는지 확인하지 못했습니다 (${file}): ${error.message}`, { cause: error });
  }
}

// 실행 파일이 없거나 Swift 소스보다 오래됐으면 다시 만든다. 소스를 고친 뒤에도 옛 실행 파일이 쓰이는 것을 막는다.
// 소스를 찾을 수 없으면 비교할 수 없으므로 있는 실행 파일을 그대로 쓴다.
async function needsBuild(binPath, swiftSource) {
  const binary = await statOrNull(binPath);
  if (binary === null) return true;
  const source = await statOrNull(swiftSource);
  return source !== null && source.mtimeMs > binary.mtimeMs;
}

async function compileTo(output, swiftSource, compiler) {
  try {
    await execFileAsync(compiler, ['-O', '-o', output, swiftSource], COMPILE_OPTIONS);
  } catch (error) {
    throw new UserError(`PDF 글자 추출기를 만들지 못했습니다. swiftc(Xcode 명령줄 도구)가 필요합니다: ${describeFailure(error)}`, {
      cause: error,
    });
  }
}

async function moveInto(temp, binPath) {
  try {
    await fs.rename(temp, binPath);
  } catch (error) {
    throw new UserError(`만든 PDF 글자 추출기를 제자리로 옮기지 못했습니다 (${binPath}): ${error.message}`, { cause: error });
  }
}

// 같은 폴더의 임시 파일에 만든 뒤 rename으로 바꿔 놓는다. 컴파일이 도중에 끊겨도 반쯤 쓰인 실행 파일이
// 정식 경로에 남지 않고, 다시 만드는 데 실패하면 이전 실행 파일이 그대로 남는다.
export async function ensurePdftext(binPath, swiftSource, { compiler = 'swiftc' } = {}) {
  if (!(await needsBuild(binPath, swiftSource))) return binPath;
  await fs.mkdir(path.dirname(binPath), { recursive: true, mode: DIR_MODE });
  const temp = `${binPath}.${process.pid}.tmp`;
  try {
    await compileTo(temp, swiftSource, compiler);
    if ((await statOrNull(temp)) === null) {
      throw new UserError(`PDF 글자 추출기를 만들었는데 실행 파일이 없습니다: ${binPath}`);
    }
    await moveInto(temp, binPath);
  } finally {
    await fs.rm(temp, { force: true });
  }
  return binPath;
}

// 브라우저가 적어 준 경로를 그대로 믿고 읽거나 지우지 않는다. 받기 폴더 바로 아래 파일만 다룬다.
function locate(filePath, downloadDir) {
  if (typeof filePath !== 'string' || filePath === '') return null;
  const resolved = path.resolve(filePath);
  return path.dirname(resolved) === path.resolve(downloadDir) ? resolved : null;
}

function failure(download, message) {
  return { status: 'failed', key: String(download?.key ?? ''), name: String(download?.name ?? ''), message };
}

function failedDownloadMessage(download) {
  if (!download.ok) {
    const cause = download.error ? String(download.error) : `HTTP ${download.status ?? '알 수 없음'}`;
    return `받기에 실패했습니다 (${cause})`;
  }
  if (/text\/html/i.test(String(download.contentType ?? ''))) return '파일 대신 HTML 화면이 내려왔습니다.';
  return null;
}

async function parseDownload(download, filePath, { pdftextBin, unzipBin, now }) {
  const extracted = await extractText(filePath, download.ext, { pdftextBin, unzipBin });
  const parsed =
    extracted.reason === undefined
      ? extractAmounts(extracted.text)
      : { amounts: [], total: null, reason: extracted.reason };
  const detail = parsed.detail ?? extracted.detail;
  return {
    status: 'read',
    key: download.key,
    name: String(download.name ?? ''),
    entry: {
      parserVersion: PARSER_VERSION,
      total: parsed.total,
      reason: parsed.reason,
      amounts: parsed.amounts,
      readAt: now().toISOString(),
    },
    // 읽지 못한 결과는 저장하지 않는다. 일시적인 문제일 수 있어서 다음 실행에 다시 받아 읽는다.
    persist: parsed.reason !== FILE_REASON.UNREADABLE,
    ...(detail === undefined ? {} : { detail }),
  };
}

export async function readDownload(download, { downloadDir, pdftextBin, unzipBin, now = () => new Date() }) {
  if (!DOWNLOAD_KEY.test(String(download?.key))) return failure(download, '파일 정보(key)가 올바르지 않아 건너뛰었습니다.');
  const filePath = locate(download.path, downloadDir);
  if (filePath === null) return failure(download, '받은 파일의 위치가 예상과 다릅니다.');
  try {
    const message = failedDownloadMessage(download);
    if (message !== null) return failure(download, message);
    return await parseDownload(download, filePath, { pdftextBin, unzipBin, now });
  } finally {
    await fs.rm(filePath, { force: true });
  }
}
