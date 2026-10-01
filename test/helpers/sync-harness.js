import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadEvidenceFiles, loadPortalOutput } from './fixtures.js';

const INPUT_PREFIX = 'const INPUT = ';
const FIXED_NOW = new Date('2026-09-30T09:05:00.000Z');

export function readInput(scriptText) {
  const firstLine = scriptText.split('\n', 1)[0];
  return JSON.parse(firstLine.slice(INPUT_PREFIX.length, -1));
}

export function writeScript(dir, name, body) {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function extensionOf(name) {
  return (/\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1] ?? 'bin').toLowerCase();
}

function contentOf(file) {
  return file.kind === 'docx' ? file.xml : file.text;
}

// read-portal.js가 남기는 download 기록을 증빙 화면의 링크에서 만든다. 이미 아는 파일(known)은 받지 않는다.
function buildDownloads({ output, evidenceFiles, known, downloadDir, overrides }) {
  const seen = new Set();
  const downloads = [];
  for (const [foundId, page] of Object.entries(output.evidences ?? {})) {
    for (const anchor of page.anchors ?? []) {
      // read-portal.js는 file_list 목록 안의 링크만 받는다.
      if (typeof anchor.container === 'string' && !anchor.container.includes('file_list')) continue;
      const url = new URL(anchor.href, 'https://portal.example.test');
      const atchFileId = url.searchParams.get('atchFileId');
      const fileSn = url.searchParams.get('fileSn');
      const key = `${atchFileId}:${fileSn}`;
      if (known.has(key) || seen.has(key) || !Object.hasOwn(evidenceFiles, key)) continue;
      seen.add(key);
      const ext = extensionOf(anchor.text);
      downloads.push({
        foundId,
        key,
        atchFileId,
        fileSn,
        name: anchor.text,
        container: anchor.container ?? '',
        ext,
        path: path.join(downloadDir, `${atchFileId}_${fileSn}.${ext}`),
        ok: true,
        status: 200,
        contentType: 'application/octet-stream',
        ...overrides[key],
      });
    }
  }
  return downloads;
}

/**
 * 진짜 ego-browser 대신 쓰는 가짜 브라우저다. INPUT을 읽어 그 안의 경로에 결과 JSON과 받은 파일을 쓴다.
 * 파일 내용은 글자 그대로 쓰고, 가짜 unzip·pdftext(createTools)가 그 글자를 그대로 내보낸다.
 */
export function createFakeBrowser({
  output = loadPortalOutput(),
  evidenceFiles = loadEvidenceFiles(),
  result = { code: 0, stdout: '{}', stderr: '', timedOut: false, aborted: false },
  outputOverrides = {},
  downloadOverrides = {},
  contentOverrides = {},
  writeOutput = true,
  onRun,
} = {}) {
  const calls = [];
  async function run(scriptText, options) {
    const input = readInput(scriptText);
    const workDirMode = statSync(input.downloadDir).mode & 0o777;
    calls.push({ input, options, scriptText, workDirMode });
    if (onRun) await onRun(input, options);
    const downloads = buildDownloads({
      output,
      evidenceFiles,
      known: new Set(input.knownFiles),
      downloadDir: input.downloadDir,
      overrides: downloadOverrides,
    });
    for (const download of downloads) {
      const content = contentOverrides[download.key] ?? contentOf(evidenceFiles[download.key]);
      writeFileSync(download.path, content);
    }
    if (writeOutput) {
      writeFileSync(input.outputPath, JSON.stringify({ ...output, downloads, ...outputOverrides }));
    }
    return result;
  }
  run.calls = calls;
  return run;
}

export function createTools(binDir) {
  mkdirSync(binDir, { recursive: true });
  return {
    // unzip은 `-p -P x <파일> <부분>`으로 불리므로 파일은 네 번째 인자다.
    unzipBin: writeScript(binDir, 'unzip', 'grep -q BROKEN "$4" && exit 2\ncat "$4"'),
    pdftextBin: writeScript(binDir, 'pdftext', 'grep -q BROKEN "$1" && exit 2\ncat "$1"'),
  };
}

export function createHarness(root, browserOptions = {}) {
  const dir = path.join(root, 'app');
  const tmpDir = path.join(root, 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const tools = createTools(path.join(root, 'bin'));
  const runBrowser = createFakeBrowser(browserOptions);
  const logs = [];
  const deps = {
    runBrowser,
    log: (message) => logs.push(message),
    now: () => FIXED_NOW,
    scriptSource: '// 가짜 read-portal\n',
    tmpDir,
    ...tools,
  };
  return { dir, tmpDir, deps, logs, runBrowser, tools };
}
