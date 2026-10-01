// portal/read-portal.js를 글자 그대로(buildBrowserScript가 만든 것과 같은 글) ES 모듈로 실행하는 시험 도구다.
// 진짜 ego-browser 대신 허용한 동작만 있는 가짜 페이지를 준다. 허용하지 않은 동작에 손을 대면 위반으로 적는다.
// 페이지가 보여 주는 내용은 시험 자료(test/fixtures/portal-output.json)에서 마지막으로 연 주소에 맞춰 꺼내 준다.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { buildBrowserScript } from '../../portal/lib/browser.js';
import { loadPortalOutput } from './fixtures.js';

export const BASE = 'https://portal.example.test/busan/sw';
export const ORIGIN = new URL(BASE).origin;
export const SOURCE = readFileSync(new URL('../../portal/read-portal.js', import.meta.url), 'utf8');

const BASE_PATH = new URL(BASE).pathname;
const PAGE_PATHS = {
  main: `${BASE_PATH}/main/main.do`,
  list: `${BASE_PATH}/mypage/teamFound/list.do`,
  view: `${BASE_PATH}/mypage/projectSpt/view.do`,
  evidence: `${BASE_PATH}/mypage/projectSpt/evidence.do`,
  download: `${BASE_PATH}/cmmn/file/fileDown.do`,
};
export const ALLOWED_PATHS = new Set(Object.values(PAGE_PATHS));

const GOTO_OPTIONS = new Set(['waitUntil', 'timeout']);
const FETCH_OPTIONS = new Set(['saveAs', 'timeout', 'redirect', 'cache']);

export const LOGGED_IN_PROBE = Object.freeze({ status: 200, body: '<th>증빙접수</th>' });
export const OK_DOWNLOAD = Object.freeze({ ok: true, status: 200, headers: { 'content-type': 'application/pdf' } });

let runCounter = 0;

// Promise가 넘겨받은 값의 then을 읽고, 콘솔과 검사 도구가 심볼 속성을 읽는다. 이런 접근은 동작으로 세지 않는다.
function isIncidental(name) {
  return typeof name === 'symbol' || name === 'then';
}

// 허용한 이름만 돌려주고, 나머지는 위반으로 적은 뒤 부르면 던지는 함수를 준다.
function allowListed(label, members, violations) {
  return new Proxy(members, {
    get(target, name) {
      if (isIncidental(name)) return undefined;
      if (Object.hasOwn(target, name)) return target[name];
      violations.push(`${label}.${String(name)} is not allowed`);
      return () => {
        throw new Error(`${label}.${String(name)} is not allowed`);
      };
    },
  });
}

function checkUrl(kind, url, violations) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    violations.push(`${kind} url is not absolute: ${url}`);
    return;
  }
  if (parsed.origin !== ORIGIN) violations.push(`${kind} leaves the base origin: ${url}`);
  else if (!ALLOWED_PATHS.has(parsed.pathname)) violations.push(`${kind} path is not allowed: ${parsed.pathname}`);
}

function checkOptions(kind, options, allowed, violations) {
  for (const key of Object.keys(options ?? {})) {
    if (!allowed.has(key)) violations.push(`${kind} option is not allowed: ${key}`);
  }
}

function emptyPage(url) {
  return { url, text: '', tables: [], anchors: [] };
}

// 마지막으로 연 주소가 가리키는 화면을 시험 자료에서 꺼낸다.
function extractionFor(rawUrl, output) {
  const url = new URL(rawUrl);
  const foundId = url.searchParams.get('foundId');
  if (url.pathname === PAGE_PATHS.list) return output.listPages?.[Number(url.searchParams.get('pageIndex')) - 1] ?? emptyPage(rawUrl);
  if (url.pathname === PAGE_PATHS.view) return output.views?.[foundId] ?? emptyPage(rawUrl);
  if (url.pathname === PAGE_PATHS.evidence) return output.evidences?.[foundId] ?? emptyPage(rawUrl);
  return emptyPage(rawUrl);
}

// 페이지 안에서 도는 함수(extractPage)를 가짜 화면(document, location)에 대고 실제로 돌린다.
function runInFakeDom(fn, dom) {
  globalThis.document = dom.document;
  globalThis.location = dom.location;
  try {
    return fn();
  } finally {
    delete globalThis.document;
    delete globalThis.location;
  }
}

function makeFakePage(state, options) {
  const { violations, calls, output } = state;
  return allowListed(
    'page',
    {
      async goto(url, gotoOptions) {
        calls.push({ method: 'goto', url });
        checkUrl('goto', url, violations);
        checkOptions('goto', gotoOptions, GOTO_OPTIONS, violations);
        state.current = url;
        state.gotos.push(url);
        state.gotoOptions.push(gotoOptions);
        const failure = options.gotoError?.(url, state.gotos);
        if (failure) throw failure;
      },
      async info() {
        calls.push({ method: 'info' });
        const dialog = options.info?.({ gotos: state.gotos, dismissals: state.dismissals }) ?? null;
        return { dialog };
      },
      async dismissDialog() {
        calls.push({ method: 'dismissDialog' });
        state.dismissals += 1;
        return true;
      },
      async evaluate(fn) {
        calls.push({ method: 'evaluate' });
        if (typeof fn !== 'function') {
          violations.push('evaluate was given something that is not a function');
          return undefined;
        }
        if (options.dom) return runInFakeDom(fn, options.dom(state.current));
        return extractionFor(state.current, output);
      },
      async fetch(url, fetchOptions) {
        calls.push({ method: 'fetch', url, options: fetchOptions });
        checkUrl('fetch', url, violations);
        checkOptions('fetch', fetchOptions, FETCH_OPTIONS, violations);
        state.fetches.push({ url, options: fetchOptions });
        const isDownload = new URL(url).pathname === PAGE_PATHS.download;
        if (!isDownload) return typeof options.probe === 'function' ? options.probe(url, fetchOptions) : options.probe;
        const response = options.download ? await options.download(url, fetchOptions) : OK_DOWNLOAD;
        if (fetchOptions?.saveAs) writeFileSync(fetchOptions.saveAs, '내려받은 내용');
        return response;
      },
    },
    violations,
  );
}

function installGlobals(state, fakePage) {
  const task = allowListed(
    'task',
    {
      page: () => fakePage,
      async finish(finishOptions) {
        state.finishCalls.push(finishOptions);
      },
    },
    state.violations,
  );
  const previous = {};
  const set = (name, value) => {
    previous[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  set('taskSpace', async (name) => {
    state.spaceNames.push(name);
    return task;
  });
  set('takeOverTaskSpace', () => {
    state.violations.push('takeOverTaskSpace must not be used');
    throw new Error('takeOverTaskSpace must not be used');
  });
  set('keyboard', allowListed('keyboard', {}, state.violations));
  set('mouse', allowListed('mouse', {}, state.violations));
  return () => {
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

async function importScript(scriptText, consoleLines) {
  runCounter += 1;
  const module = `// 시험 실행 ${runCounter}\n${scriptText}`;
  const url = `data:text/javascript;base64,${Buffer.from(module).toString('base64')}`;
  const originalLog = console.log;
  console.log = (...args) => consoleLines.push(args.join(' '));
  try {
    await import(url);
    return undefined;
  } catch (error) {
    return error;
  } finally {
    console.log = originalLog;
  }
}

function readResult(outputPath) {
  try {
    return JSON.parse(readFileSync(outputPath, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * 스크립트를 한 번 실행한다. workDir은 결과 파일과 받은 파일이 놓일 폴더다.
 * options: output(화면 자료), input(INPUT 덮어쓰기), probe, download, info, gotoError, dom, source(스크립트 글)
 */
export async function runPortalScript(workDir, options = {}) {
  mkdirSync(workDir, { recursive: true });
  const input = {
    baseUrl: BASE,
    menuNo: '200054',
    spaceName: '시험 공간',
    outputPath: path.join(workDir, 'portal-output.json'),
    downloadDir: workDir,
    knownFiles: [],
    maxListPages: 20,
    navTimeoutMs: 1000,
    fileTimeoutMs: 2000,
    ...options.input,
  };
  const state = {
    output: options.output ?? loadPortalOutput(),
    current: '',
    gotos: [],
    gotoOptions: [],
    fetches: [],
    calls: [],
    violations: [],
    dismissals: 0,
    finishCalls: [],
    spaceNames: [],
  };
  const settings = { probe: LOGGED_IN_PROBE, ...options };
  const restore = installGlobals(state, makeFakePage(state, settings));
  const consoleLines = [];
  let importError;
  try {
    importError = await importScript(buildBrowserScript(options.source ?? SOURCE, input), consoleLines);
  } finally {
    restore();
  }
  return {
    input,
    result: readResult(input.outputPath),
    summary: consoleLines.length > 0 ? JSON.parse(consoleLines.at(-1)) : undefined,
    importError,
    ...state,
  };
}
