// portal/read-portal.js를 실제로 실행해 행동을 확인한다. read-portal-safety.test.js가 글자를 훑는 점검이라면,
// 여기서는 허용한 동작만 하는 가짜 페이지에 대고 진짜 스크립트를 돌려서 무엇을 열고 무엇을 받는지 본다.
// 스크립트는 포털에 아무것도 쓰면 안 된다. 증빙 화면은 파일을 고치는 양식이라 잘못 건드리면 사무국에 낸 증빙이 바뀐다.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { validatePortal } from '../portal/lib/snapshot.js';
import { loadPortalOutput } from './helpers/fixtures.js';
import { ALLOWED_PATHS, BASE, ORIGIN, SOURCE, runPortalScript } from './helpers/portal-script-harness.js';

const workRoot = mkdtempSync(path.join(os.tmpdir(), 'vas-portal-script-'));
after(() => rmSync(workRoot, { recursive: true, force: true }));

let counter = 0;
function freshDir() {
  counter += 1;
  return path.join(workRoot, `run-${counter}`);
}

const run = (options) => runPortalScript(freshDir(), options);

// 어떤 경우에도 스크립트가 지켜야 하는 것: 허용한 동작만 했고, 정리를 마쳤고, 결과 파일을 남겼다.
function assertWellBehaved(execution) {
  assert.deepEqual(execution.violations, []);
  assert.equal(execution.importError, undefined);
  assert.deepEqual(execution.finishCalls, [{ keep: [] }]);
  assert.notEqual(execution.result, undefined, 'the output file was not written');
  assert.equal(typeof execution.result.finishedAt, 'string');
}

const downloadFetches = (execution) => execution.fetches.filter(({ url }) => new URL(url).pathname.endsWith('fileDown.do'));
const fetchedKeys = (execution) => downloadFetches(execution).map(({ url }) => keyOf(url));

function keyOf(url) {
  const { searchParams } = new URL(url);
  return `${searchParams.get('atchFileId')}:${searchParams.get('fileSn')}`;
}

const FIXTURE_KEYS = [
  '000000000000000000000000000003f3:1',
  '00000000-0000-0000-0000-000003ef:1',
  '00000000-0000-0000-0000-000003ef:2',
  '000000000000000000000000000003ee:1',
  '000000000000000000000000000003ed:1',
  '000000000000000000000000000003ec:1',
  '000000000000000000000000000003eb:1',
  '000000000000000000000000000003eb:2',
  '000000000000000000000000000003eb:3',
];

// 어느 증빙 화면에도 링크가 없고, 1004 신청의 증빙 화면에만 이 링크들이 있는 포털 자료를 만든다.
function outputWithLinks(anchors) {
  const output = loadPortalOutput();
  for (const page of Object.values(output.evidences)) page.anchors = [];
  output.evidences['1004'].anchors = anchors;
  return output;
}

function fileLink(query, { text = '내역서.pdf', container = 'file_list_new', pathname = '/busan/sw/cmmn/file/fileDown.do' } = {}) {
  return { text, href: `${pathname}?menuNo=200054&${query}`, container };
}

describe('read-portal.js on the synthetic portal', () => {
  it('reads every list page, view and evidence page, and downloads each file in the file list', async () => {
    const execution = await run();

    assertWellBehaved(execution);
    assert.equal(execution.result.loggedIn, true);
    assert.equal(execution.result.fatal, undefined);
    assert.deepEqual(execution.result.errors, []);
    assert.equal(execution.result.listPages.length, 3);
    assert.equal(Object.keys(execution.result.views).length, 12);
    assert.equal(Object.keys(execution.result.evidences).length, 12);
    assert.deepEqual(
      execution.result.downloads.map((download) => download.key),
      FIXTURE_KEYS,
    );
  });

  it('writes a result the parsing side accepts without complaint', async () => {
    const execution = await run();

    assert.deepEqual(validatePortal(execution.result), []);
  });

  it('records each download with where it went and what came back', async () => {
    const execution = await run();
    const [, , , , , material] = execution.result.downloads;

    assert.deepEqual(material, {
      foundId: '1004',
      key: '000000000000000000000000000003ec:1',
      atchFileId: '000000000000000000000000000003ec',
      fileSn: '1',
      name: '재료_구매비_증빙_내역서_가짜팀.pdf',
      container: 'file_list_new',
      ext: 'pdf',
      path: path.join(execution.input.downloadDir, '000000000000000000000000000003ec_1.pdf'),
      ok: true,
      status: 200,
      contentType: 'application/pdf',
    });
  });

  it('prints one summary line for the caller', async () => {
    const execution = await run();

    assert.deepEqual(execution.summary, { loggedIn: true, listPages: 3, views: 12, downloads: 9, fatal: null });
  });

  it('asks for the task space by the name it was given', async () => {
    const execution = await run({ input: { spaceName: '다른 공간' } });

    assert.deepEqual(execution.spaceNames, ['다른 공간']);
  });

  it('does not download the form link that sits outside the file list', async () => {
    const execution = await run();

    assert.ok(!fetchedKeys(execution).includes('000000000000000000000000000003ec:2'));
    assert.ok(loadPortalOutput().evidences['1004'].anchors.some((anchor) => anchor.text === '증빙_양식.hwp'));
  });
});

describe('read-portal.js only reads, and only from the portal', () => {
  it('opens and fetches nothing but the five known pages on the base origin', async () => {
    const execution = await run();

    assertWellBehaved(execution);
    const urls = [...execution.gotos, ...execution.fetches.map(({ url }) => url)];
    assert.ok(urls.length > 20);
    for (const url of urls) {
      const { origin, pathname } = new URL(url);
      assert.equal(origin, ORIGIN, url);
      assert.ok(ALLOWED_PATHS.has(pathname), url);
    }
  });

  it('opens the pages in the order main, lists, then a view and an evidence page for each application', async () => {
    const execution = await run();

    assert.deepEqual(execution.gotos.slice(0, 5), [
      `${BASE}/main/main.do`,
      `${BASE}/mypage/teamFound/list.do?menuNo=200054&pageIndex=1`,
      `${BASE}/mypage/teamFound/list.do?menuNo=200054&pageIndex=2`,
      `${BASE}/mypage/teamFound/list.do?menuNo=200054&pageIndex=3`,
      `${BASE}/mypage/projectSpt/view.do?foundId=1012&menuNo=200054`,
    ]);
    assert.equal(execution.gotos[5], `${BASE}/mypage/projectSpt/evidence.do?foundId=1012&menuNo=200054`);
    assert.equal(execution.gotos.length, 1 + 3 + 12 * 2);
  });

  it('passes only the options that read: never a method or a body', async () => {
    const execution = await run();

    const optionKeys = new Set(execution.fetches.flatMap(({ options }) => Object.keys(options)));
    assert.deepEqual([...optionKeys].sort(), ['cache', 'redirect', 'saveAs', 'timeout']);
    for (const { options } of execution.fetches) {
      assert.ok(!('method' in options) && !('body' in options));
    }
  });

  it('asks the login probe not to follow redirects, and every download not to be cached', async () => {
    const execution = await run();

    const [probe, ...downloads] = execution.fetches;
    assert.deepEqual(probe.options, { redirect: 'manual', timeout: 1000 });
    assert.equal(probe.url, `${BASE}/mypage/teamFound/list.do?menuNo=200054`);
    assert.equal(downloads.length, FIXTURE_KEYS.length);
    for (const { options } of downloads) {
      assert.deepEqual(Object.keys(options).sort(), ['cache', 'saveAs', 'timeout']);
      assert.equal(options.cache, 'no-store');
      assert.equal(options.timeout, 2000);
    }
  });

  it('saves each download directly inside the download folder under a name made of its id and number', async () => {
    const execution = await run();

    for (const { options, url } of downloadFetches(execution)) {
      const [atchFileId, fileSn] = keyOf(url).split(':');
      assert.equal(path.dirname(options.saveAs), execution.input.downloadDir);
      assert.match(path.basename(options.saveAs), new RegExp(`^${atchFileId}_${fileSn}\\.[a-z0-9]+$`));
    }
  });

  it('opens the home page without waiting for it to load and every other page after it loads, with a time limit', async () => {
    const execution = await run();

    assert.equal(execution.gotoOptions.length, execution.gotos.length);
    assert.deepEqual(execution.gotoOptions[0], { waitUntil: 'commit', timeout: 1000 });
    for (const options of execution.gotoOptions.slice(1)) {
      assert.deepEqual(options, { waitUntil: 'domcontentloaded', timeout: 1000 });
    }
  });

  it('trims trailing slashes from the base address', async () => {
    const execution = await run({ input: { baseUrl: `${BASE}///` } });

    assertWellBehaved(execution);
    assert.equal(execution.gotos[0], `${BASE}/main/main.do`);
    assert.equal(execution.result.downloads.length, FIXTURE_KEYS.length);
  });
});

describe('read-portal.js list pagination', () => {
  it('stops at the first list page that shows no application', async () => {
    const execution = await run();

    const listGotos = execution.gotos.filter((url) => url.includes('list.do'));
    assert.equal(listGotos.length, 3);
    assert.ok(!execution.gotos.some((url) => url.includes('pageIndex=4')));
  });

  it('never goes past the page limit it was given', async () => {
    for (const limit of [1, 2]) {
      const execution = await run({ input: { maxListPages: limit } });

      assertWellBehaved(execution);
      assert.equal(execution.result.listPages.length, limit);
      assert.ok(!execution.gotos.some((url) => url.includes(`pageIndex=${limit + 1}`)), `limit ${limit}`);
    }
  });

  it('reads the applications of the pages it did visit and no others', async () => {
    const execution = await run({ input: { maxListPages: 1 } });

    assert.equal(Object.keys(execution.result.views).length, 10);
    assert.ok(!('1002' in execution.result.views));
  });

  it('finds an application only once even when two pages show it', async () => {
    const output = loadPortalOutput();
    output.listPages[1] = output.listPages[0];

    const execution = await run({ output });

    assert.equal(Object.keys(execution.result.views).length, 10);
    assert.equal(execution.gotos.filter((url) => url.includes('view.do?foundId=1012')).length, 1);
  });
});

describe('read-portal.js and files it already knows', () => {
  it('does not fetch a file whose key it was told is known', async () => {
    const known = ['000000000000000000000000000003eb:1', '00000000-0000-0000-0000-000003ef:2'];

    const execution = await run({ input: { knownFiles: known } });

    assertWellBehaved(execution);
    const keys = fetchedKeys(execution);
    for (const key of known) assert.ok(!keys.includes(key), key);
    assert.equal(keys.length, FIXTURE_KEYS.length - 2);
    assert.ok(execution.result.downloads.every((download) => !known.includes(download.key)));
  });

  it('fetches nothing at all when every file is known', async () => {
    const execution = await run({ input: { knownFiles: FIXTURE_KEYS } });

    assert.deepEqual(downloadFetches(execution), []);
    assert.deepEqual(execution.result.downloads, []);
  });

  it('fetches a key that two applications both link only once', async () => {
    const output = loadPortalOutput();
    output.evidences['1005'].anchors.push(...output.evidences['1006'].anchors);

    const execution = await run({ output });

    assert.equal(fetchedKeys(execution).filter((key) => key === '000000000000000000000000000003ee:1').length, 1);
  });
});

describe('read-portal.js links it must not follow', () => {
  const OFF_LIMITS_LINKS = [
    ['another origin', 'https://evil.example.test/busan/sw/cmmn/file/fileDown.do?atchFileId=abc1&fileSn=1'],
    ['another port', 'https://portal.example.test:8443/busan/sw/cmmn/file/fileDown.do?atchFileId=abc1&fileSn=1'],
    ['plain http', 'http://portal.example.test/busan/sw/cmmn/file/fileDown.do?atchFileId=abc1&fileSn=1'],
    ['a protocol-relative address', '//evil.example.test/busan/sw/cmmn/file/fileDown.do?atchFileId=abc1&fileSn=1'],
    ['user info that hides the real host', 'https://portal.example.test@evil.example.test/busan/sw/cmmn/file/fileDown.do?atchFileId=abc1&fileSn=1'],
    ['another site path', '/other/cmmn/file/fileDown.do?atchFileId=abc1&fileSn=1'],
    ['a path that only ends the same way', '/x/busan/sw/cmmn/file/fileDown.do?atchFileId=abc1&fileSn=1'],
    ['a path that climbs out of the base', '/busan/sw/../evil/cmmn/file/fileDown.do?atchFileId=abc1&fileSn=1'],
    ['an encoded path that climbs out of the base', '/busan/sw/%2e%2e/evil/cmmn/file/fileDown.do?atchFileId=abc1&fileSn=1'],
    ['a longer file name', '/busan/sw/cmmn/file/xfileDown.do?atchFileId=abc1&fileSn=1'],
    ['the base path itself', '/busan/sw?atchFileId=abc1&fileSn=1'],
    ['a script link', 'javascript:void(0)'],
    ['an empty address', ''],
    ['an address that cannot be parsed', 'http://'],
    ['an address with an invalid port', 'https://portal.example.test:99999/busan/sw/cmmn/file/fileDown.do?atchFileId=abc1&fileSn=1'],
  ];
  for (const [title, href] of OFF_LIMITS_LINKS) {
    it(`does not fetch ${title}`, async () => {
      const execution = await run({ output: outputWithLinks([{ text: '내역서.pdf', href, container: 'file_list_new' }]) });

      assertWellBehaved(execution);
      assert.deepEqual(downloadFetches(execution), []);
      assert.deepEqual(execution.result.downloads, []);
      assert.equal(execution.result.errors.length, 1);
      assert.match(execution.result.errors[0].message, /모양이 다른 파일 링크를 건너뛰었다/);
    });
  }

  it('does not fetch a link with no address attribute at all', async () => {
    const execution = await run({ output: outputWithLinks([{ text: '내역서.pdf', href: null, container: 'file_list_new' }]) });

    assertWellBehaved(execution);
    assert.deepEqual(downloadFetches(execution), []);
  });

  const BAD_PARAMETERS = [
    ['an id that climbs with slashes', 'atchFileId=..%2F..%2Fx&fileSn=1'],
    ['an id with a backslash', 'atchFileId=a%5Cb&fileSn=1'],
    ['an id with a dot', 'atchFileId=a.b&fileSn=1'],
    ['an id that is only dots', 'atchFileId=..&fileSn=1'],
    ['an id with a space', 'atchFileId=a%20b&fileSn=1'],
    ['an id with a colon', 'atchFileId=a%3Ab&fileSn=1'],
    ['an empty id', 'atchFileId=&fileSn=1'],
    ['a missing id', 'fileSn=1'],
    ['a file number that is not a number', 'atchFileId=abc1&fileSn=x'],
    ['an empty file number', 'atchFileId=abc1&fileSn='],
    ['a negative file number', 'atchFileId=abc1&fileSn=-1'],
    ['a missing file number', 'atchFileId=abc1'],
  ];
  for (const [title, query] of BAD_PARAMETERS) {
    it(`does not fetch a link with ${title}`, async () => {
      const execution = await run({ output: outputWithLinks([fileLink(query)]) });

      assertWellBehaved(execution);
      assert.deepEqual(downloadFetches(execution), []);
      assert.equal(execution.result.errors.length, 1);
    });
  }

  it('does not fetch a link whose container is not the file list, and does not complain about it', async () => {
    const links = [
      fileLink('atchFileId=abc1&fileSn=1', { container: '' }),
      fileLink('atchFileId=abc2&fileSn=1', { container: 'other_list' }),
      fileLink('atchFileId=abc3&fileSn=1', { container: 'form_area' }),
    ];

    const execution = await run({ output: outputWithLinks(links) });

    assertWellBehaved(execution);
    assert.deepEqual(downloadFetches(execution), []);
    assert.deepEqual(execution.result.errors, []);
  });

  it('records every skipped link, and still fetches the good one beside them', async () => {
    const links = [
      fileLink('atchFileId=a.b&fileSn=1'),
      fileLink('atchFileId=goodid1&fileSn=1', { text: '진짜.pdf' }),
      { text: '남의 것.pdf', href: 'https://evil.example.test/busan/sw/cmmn/file/fileDown.do?atchFileId=abc1&fileSn=1', container: 'file_list_new' },
    ];

    const execution = await run({ output: outputWithLinks(links) });

    assertWellBehaved(execution);
    assert.deepEqual(fetchedKeys(execution), ['goodid1:1']);
    assert.equal(execution.result.errors.length, 2);
  });
});

describe('read-portal.js links it should follow', () => {
  it('fetches a file whose attachment id has hyphens', async () => {
    const id = '00000000-0000-0000-0000-000000ab';

    const execution = await run({ output: outputWithLinks([fileLink(`atchFileId=${id}&fileSn=2`, { text: '하이픈.docx' })]) });

    assertWellBehaved(execution);
    assert.deepEqual(fetchedKeys(execution), [`${id}:2`]);
    assert.equal(execution.result.downloads[0].path, path.join(execution.input.downloadDir, `${id}_2.docx`));
  });

  it('fetches a plain letters and digits id, with any case', async () => {
    const execution = await run({ output: outputWithLinks([fileLink('atchFileId=AbC123xyz&fileSn=10')]) });

    assert.deepEqual(fetchedKeys(execution), ['AbC123xyz:10']);
  });

  it('opens a link written with dot segments only after resolving them to the exact download path', async () => {
    const link = fileLink('atchFileId=abc1&fileSn=1', { pathname: '/busan/sw/x/../cmmn/file/fileDown.do' });

    const execution = await run({ output: outputWithLinks([link]) });

    assertWellBehaved(execution);
    assert.equal(downloadFetches(execution).length, 1);
    assert.ok(!downloadFetches(execution)[0].url.includes('..'));
  });

  it('gives a file with no known extension the bin extension', async () => {
    const execution = await run({ output: outputWithLinks([fileLink('atchFileId=abc1&fileSn=1', { text: '확장자없음' })]) });

    assert.equal(execution.result.downloads[0].ext, 'bin');
    assert.ok(execution.result.downloads[0].path.endsWith('abc1_1.bin'));
  });
});

describe('read-portal.js when a download goes wrong', () => {
  it('records a download that threw as failed and goes on reading the rest', async () => {
    const execution = await run({
      download: (url) => {
        if (url.includes('3ec')) throw new Error('timeout 2000ms exceeded');
        return { ok: true, status: 200, headers: { 'content-type': 'application/pdf' } };
      },
    });

    assertWellBehaved(execution);
    assert.equal(execution.result.fatal, undefined);
    assert.equal(execution.result.downloads.length, FIXTURE_KEYS.length);
    const failed = execution.result.downloads.filter((download) => !download.ok);
    assert.equal(failed.length, 1);
    assert.deepEqual(
      { key: failed[0].key, status: failed[0].status, contentType: failed[0].contentType, error: failed[0].error },
      { key: '000000000000000000000000000003ec:1', status: 0, contentType: '', error: 'timeout 2000ms exceeded' },
    );
    assert.ok(execution.result.downloads.filter((download) => download.ok).length === FIXTURE_KEYS.length - 1);
    assert.equal(execution.summary.fatal, null);
  });

  it('keeps reading the applications after the one whose download failed', async () => {
    const execution = await run({
      download: (url) => {
        if (url.includes('3ec')) throw new Error('boom');
        return { ok: true, status: 200 };
      },
    });

    const keys = execution.result.downloads.map((download) => download.key);
    assert.ok(keys.indexOf('000000000000000000000000000003eb:1') > keys.indexOf('000000000000000000000000000003ec:1'));
    assert.equal(Object.keys(execution.result.views).length, 12);
  });

  it('cuts a long error message and accepts something that is not an Error', async () => {
    const execution = await run({
      download: (url) => {
        if (url.includes('3ec')) throw new Error('가'.repeat(500));
        if (url.includes('3ed')) throw '문자열로 던진 실패';
        return { ok: true, status: 200 };
      },
    });

    const byKey = Object.fromEntries(execution.result.downloads.map((download) => [download.key, download]));
    assert.equal(byKey['000000000000000000000000000003ec:1'].error.length, 200);
    assert.equal(byKey['000000000000000000000000000003ed:1'].error, '문자열로 던진 실패');
  });

  it('records the status of a response that says it failed', async () => {
    const execution = await run({ download: () => ({ ok: false, status: 503, headers: { 'content-type': 'text/html' } }) });

    assertWellBehaved(execution);
    assert.ok(execution.result.downloads.every((download) => download.ok === false && download.status === 503));
    assert.ok(execution.result.downloads.every((download) => download.error === undefined));
  });

  it('reads the content type from either spelling of the header and tolerates a missing header list', async () => {
    const responses = {
      '3ec': { ok: true, status: 200, headers: { 'Content-Type': 'application/pdf' } },
      '3ed': { ok: true, status: 200, headers: {} },
      '3ee': { ok: true, status: 200 },
    };
    const execution = await run({
      download: (url) => responses[Object.keys(responses).find((part) => url.includes(part))] ?? { ok: true, status: 200, headers: { 'content-type': 'x/y' } },
    });

    const byKey = Object.fromEntries(execution.result.downloads.map((download) => [download.key, download.contentType]));
    assert.equal(byKey['000000000000000000000000000003ec:1'], 'application/pdf');
    assert.equal(byKey['000000000000000000000000000003ed:1'], '');
    assert.equal(byKey['000000000000000000000000000003ee:1'], '');
  });
});

describe('read-portal.js when the browser is not logged in', () => {
  const loggedOutProbes = [
    ['a status of zero, which a blocked redirect gives', { status: 0, body: '' }],
    ['a redirect status', { status: 302, body: '증빙접수' }],
    ['a page that is not the list', { status: 200, body: '<html>로그인해 주세요</html>' }],
    ['a page without a body', { status: 200 }],
  ];
  for (const [title, probe] of loggedOutProbes) {
    it(`reports it and visits no list page when the probe returns ${title}`, async () => {
      const execution = await run({ probe });

      assertWellBehaved(execution);
      assert.equal(execution.result.loggedIn, false);
      assert.deepEqual(execution.gotos, [`${BASE}/main/main.do`]);
      assert.deepEqual(execution.result.listPages, []);
      assert.deepEqual(execution.result.views, {});
      assert.deepEqual(execution.result.evidences, {});
      assert.deepEqual(execution.result.downloads, []);
      assert.equal(execution.fetches.length, 1);
      assert.equal(execution.summary.loggedIn, false);
    });
  }

  it('reports the failure, and not a login request, when the probe request itself fails', async () => {
    const execution = await run({
      probe: () => {
        throw new Error('fetch failed');
      },
    });

    assertWellBehaved(execution);
    assert.equal(execution.result.loggedIn, false);
    assert.equal(execution.result.fatal, 'fetch failed');
    assert.equal(execution.summary.fatal, 'fetch failed');
    assert.deepEqual(execution.result.listPages, []);
  });
});

describe('read-portal.js when a dialog appears', () => {
  const dialogAfterGotos = (count) => ({ gotos, dismissals }) =>
    gotos.length === count && dismissals === 0 ? { message: '로그인이 필요합니다.' } : null;

  it('dismisses a dialog that shows after a page opens, then stops as session_lost', async () => {
    const execution = await run({ info: dialogAfterGotos(3) });

    assertWellBehaved(execution);
    assert.equal(execution.dismissals, 1);
    assert.equal(execution.result.fatal, 'session_lost');
    assert.equal(execution.result.loggedIn, true);
    assert.equal(execution.result.listPages.length, 1);
    assert.equal(execution.gotos.length, 3);
    assert.deepEqual(execution.result.views, {});
    assert.equal(execution.result.errors.length, 1);
    assert.equal(execution.result.errors[0].where, 'list 2');
    assert.match(execution.result.errors[0].message, /^확인창을 취소했다: 로그인이 필요합니다\./);
    assert.deepEqual(downloadFetches(execution), []);
  });

  it('stops the same way when a dialog shows on a detail page, keeping what it had read', async () => {
    const execution = await run({ info: dialogAfterGotos(6) });

    assertWellBehaved(execution);
    assert.equal(execution.result.fatal, 'session_lost');
    assert.equal(execution.result.listPages.length, 3);
    assert.ok(Object.keys(execution.result.views).length >= 1);
  });

  it('dismisses a dialog that was already open at the start and carries on', async () => {
    const execution = await run({ info: ({ gotos, dismissals }) => (gotos.length === 0 && dismissals === 0 ? { message: '이전 창' } : null) });

    assertWellBehaved(execution);
    assert.equal(execution.dismissals, 1);
    assert.equal(execution.result.fatal, undefined);
    assert.equal(execution.result.errors[0].where, 'start');
    assert.equal(execution.result.downloads.length, FIXTURE_KEYS.length);
  });

  it('cuts a long dialog message and copes with one that has no message', async () => {
    const long = await run({ info: ({ gotos, dismissals }) => (gotos.length === 3 && dismissals === 0 ? { message: '나'.repeat(500) } : null) });
    const none = await run({ info: ({ gotos, dismissals }) => (gotos.length === 3 && dismissals === 0 ? {} : null) });

    assert.equal(long.result.errors[0].message.length, '확인창을 취소했다: '.length + 120);
    assert.equal(none.result.errors[0].message, '확인창을 취소했다: ');
  });

  it('treats a dialog that blocked the page load as a lost session', async () => {
    const execution = await run({
      gotoError: (url) => (url.includes('pageIndex=2') ? new Error('Timeout 1000ms exceeded') : undefined),
      info: dialogAfterGotos(3),
    });

    assertWellBehaved(execution);
    assert.equal(execution.result.fatal, 'session_lost');
    assert.equal(execution.dismissals, 1);
  });

  it('reports the load error itself when no dialog was in the way', async () => {
    const execution = await run({
      gotoError: (url) => (url.includes('pageIndex=2') ? new Error('Timeout 1000ms exceeded') : undefined),
    });

    assertWellBehaved(execution);
    assert.equal(execution.result.fatal, 'Timeout 1000ms exceeded');
    assert.equal(execution.dismissals, 0);
    assert.equal(execution.result.listPages.length, 1);
  });

  it('cuts a long fatal message', async () => {
    const execution = await run({ gotoError: (url) => (url.includes('pageIndex=1') ? new Error('다'.repeat(500)) : undefined) });

    assert.equal(execution.result.fatal.length, 300);
  });
});

// 페이지 안에서 돌아야 하는 extractPage를 가짜 화면(document, location)에 대고 실제로 돌린다.
describe('read-portal.js page reader (extractPage)', () => {
  const LINK = '/busan/sw/cmmn/file/fileDown.do?atchFileId=abc1&fileSn=1';

  function fakeDom({ rootText = '', cells = [], anchorText = '' } = {}) {
    const cell = (text) => ({ innerText: text });
    const row = {
      querySelectorAll: (selector) => (selector === 'th,td' ? cells.map(cell) : [{ getAttribute: () => '/busan/sw/mypage/projectSpt/view.do?foundId=7001&menuNo=200054' }]),
    };
    const anchor = { innerText: anchorText, getAttribute: () => LINK, closest: () => ({ className: 'file_list_new' }) };
    const root = {
      innerText: rootText,
      querySelectorAll: (selector) => (selector === 'table' ? [{ querySelectorAll: () => [row] }] : [anchor]),
    };
    return { document: { querySelector: () => root, body: root }, location: { href: `${BASE}/page.do` } };
  }

  async function extractedFrom(dom) {
    const execution = await run({ dom: () => dom, input: { maxListPages: 1 } });
    assertWellBehaved(execution);
    return execution;
  }

  it('removes every control character but keeps line breaks, in the page text, the cells and the link names', async () => {
    const dirty = 'a\u001b[2Jb\u0007c\r\nd\u009be';
    const execution = await extractedFrom(fakeDom({ rootText: dirty, cells: [dirty], anchorText: dirty }));

    const [page] = execution.result.listPages;
    assert.equal(page.text, 'a[2Jbc\nde');
    assert.equal(page.tables[0][0].cells[0], 'a[2Jbc\nde');
    assert.equal(page.anchors[0].text, 'a[2Jbc\nde');
    assert.equal(execution.result.downloads[0].name, 'a[2Jbc\nde');
  });

  it('removes each C0 and C1 control character except the tab and the line feed', async () => {
    const controls = [];
    for (let code = 0; code <= 0x9f; code += 1) {
      const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
      if (isControl && code !== 0x09 && code !== 0x0a) controls.push(String.fromCharCode(code));
    }
    const text = `x${controls.join('')}y`;

    const execution = await extractedFrom(fakeDom({ rootText: text }));

    assert.equal(controls.length, 32 - 2 + 33);
    assert.equal(execution.result.listPages[0].text, 'xy');
  });

  it('still turns runs of spaces, tabs and no-break spaces into one space and keeps single line breaks', async () => {
    const execution = await extractedFrom(fakeDom({ rootText: '  가\t\t나   다 \n\n  라  ' }));

    assert.equal(execution.result.listPages[0].text, '가 나 다\n라');
  });

  it('still composes decomposed Hangul into one form', async () => {
    const execution = await extractedFrom(fakeDom({ rootText: '한글'.normalize('NFD') }));

    assert.equal(execution.result.listPages[0].text, '한글');
  });

  it('gives back the list page address and the container name of a link untouched', async () => {
    const execution = await extractedFrom(fakeDom({ rootText: 'x', anchorText: '내역서.pdf' }));

    const [page] = execution.result.listPages;
    assert.equal(page.url, `${BASE}/page.do`);
    assert.deepEqual(page.anchors, [{ text: '내역서.pdf', href: LINK, container: 'file_list_new' }]);
  });
});

// 이 시험 도구가 금지된 동작을 정말로 잡아내는지 확인한다. 잡아내지 못하면 위 시험은 아무것도 보장하지 못한다.
describe('the harness catches what the script must never do', () => {
  const forbidden = [
    ['a click', "await page.click('#save');", /page\.click is not allowed/],
    ['a key press', "await page.keyboard.press('Enter');", /page\.keyboard is not allowed/],
    ['a mouse move', 'await mouse.move(1, 2);', /mouse\.move is not allowed/],
    ['a global keyboard', "await keyboard.press('Enter');", /keyboard\.press is not allowed/],
    ['a form submit', "await page.submit('#form');", /page\.submit is not allowed/],
    ['a raw devtools call', "await page.cdp('Page.navigate', {});", /page\.cdp is not allowed/],
    ['an unknown task member', 'await task.close();', /task\.close is not allowed/],
    ['taking over a task space', "takeOverTaskSpace('x');", /takeOverTaskSpace must not be used/],
    ['a POST request', "await page.fetch(`${BASE}/main/main.do`, { method: 'POST', body: 'x' });", /fetch option is not allowed: method/],
    ['a request body', "await page.fetch(`${BASE}/main/main.do`, { body: 'x' });", /fetch option is not allowed: body/],
    ['an unknown fetch option', "await page.fetch(`${BASE}/main/main.do`, { headers: {} });", /fetch option is not allowed: headers/],
    ['a request to another site', "await page.goto('https://evil.example.test/');", /leaves the base origin/],
    ['a fetch to another site', "await page.fetch('https://evil.example.test/x.do');", /leaves the base origin/],
    ['a portal page that saves changes', "await page.goto(`${BASE}/mypage/projectSpt/updateEvd.do`);", /path is not allowed/],
    ['a relative address', "await page.goto('/busan/sw/main/main.do');", /url is not absolute/],
    ['an unknown goto option', "await page.goto(`${BASE}/main/main.do`, { referer: 'x' });", /goto option is not allowed: referer/],
    ['evaluating a string', "await page.evaluate('document.forms[0].submit()');", /evaluate was given something that is not a function/],
  ];
  for (const [title, statement, pattern] of forbidden) {
    it(`flags ${title}`, async () => {
      const execution = await run({ source: `${SOURCE}\n${statement}\n` });

      assert.ok(
        execution.violations.some((violation) => pattern.test(violation)),
        JSON.stringify(execution.violations),
      );
    });
  }

  it('does not flag the untouched script, so a flag always means something', async () => {
    const execution = await run();

    assert.deepEqual(execution.violations, []);
  });

  it('leaves the process as it found it: no stand-in globals and a working console', async () => {
    await run();

    for (const name of ['taskSpace', 'takeOverTaskSpace', 'keyboard', 'mouse', 'document', 'location']) {
      assert.equal(name in globalThis, false, name);
    }
    assert.equal(typeof console.log, 'function');
  });
});
