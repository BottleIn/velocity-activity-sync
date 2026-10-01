/**
 * 사무국 포털을 읽기만 하는 ego-browser 스크립트다. `ego-browser nodejs`의 표준 입력으로 돈다.
 *
 * ego-browser는 셸 환경 변수를 스크립트에 넘겨주지 않는다. 그래서 진입점이
 * `const INPUT = {...};` 한 줄을 이 파일 앞에 붙여 입력을 넘긴다.
 *
 * 화면의 글자와 링크를 가공하지 않고 JSON 파일로 내놓는다. 칸을 필드로 옮기는 규칙은
 * 브라우저 밖의 파서(portal/lib/)가 맡는다. 규칙을 DOM 없이 문자열 시험 자료로 시험하려는 것이다.
 *
 * 증빙 화면(evidence.do)은 보기 화면이 아니라 파일을 고치는 양식이라서, 버튼 하나만 잘못 눌러도
 * 사무국에 낸 증빙이 바뀐다. 그래서 이 스크립트는 페이지 이동과 GET 요청만 한다.
 * test/read-portal-safety.test.js가 이 약속을 글자로 훑어 검사하고, test/read-portal-behavior.test.js가 스크립트를
 * 허용한 동작만 있는 가짜 페이지에 대고 실제로 돌려 무엇을 열고 무엇을 받는지 검사한다.
 */
const fs = await import('node:fs/promises');

const BASE = INPUT.baseUrl.replace(/\/+$/, '');
const ORIGIN = new URL(BASE).origin;
// 파일을 받는 주소의 경로다. 끝이 같은 다른 경로(/other/..., /busan/sw/../evil/...)가 통과하지 않도록 통째로 비교한다.
const DOWNLOAD_PATH = `${new URL(BASE).pathname.replace(/\/+$/, '')}/cmmn/file/fileDown.do`;
const MENU = INPUT.menuNo;
const known = new Set(INPUT.knownFiles);
const out = {
  startedAt: new Date().toISOString(),
  loggedIn: false,
  listPages: [],
  views: {},
  evidences: {},
  downloads: [],
  errors: [],
};

// page.evaluate로 페이지 안에서 돈다. 바깥 변수를 읽을 수 없어 쓰는 것을 모두 안에 둔다.
function extractPage() {
  // 줄바꿈과 탭만 남기고 제어 문자(C0, DEL, C1)를 지운다. 포털의 글자가 나중에 터미널에 찍힐 때 화면을 조종하지 못하게 하려는
  // 것이다. Node 쪽 보고서도 같은 범위를 지운다(portal/lib/format.js의 stripControlCharacters).
  const clean = (value) =>
    (value || '')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim()
      .normalize('NFC');
  const root = document.querySelector('.sub_contents') || document.body;
  const tables = [...root.querySelectorAll('table')].map((table) =>
    [...table.querySelectorAll('tr')].map((row) => ({
      cells: [...row.querySelectorAll('th,td')].map((cell) => clean(cell.innerText)),
      links: [...row.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
    })),
  );
  const anchors = [...root.querySelectorAll("a[href*='fileDown.do']")].map((a) => ({
    text: clean(a.innerText),
    href: a.getAttribute('href'),
    container: a.closest('ul') ? a.closest('ul').className : '',
  }));
  return { url: location.href, text: clean(root.innerText), tables, anchors };
}

async function closeDialog(where) {
  const info = await page.info();
  if (!info || !info.dialog) return false;
  await page.dismissDialog();
  out.errors.push({ where, message: `확인창을 취소했다: ${String(info.dialog.message ?? '').slice(0, 120)}` });
  return true;
}

async function open(url, where) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: INPUT.navTimeoutMs });
  } catch (error) {
    // 도중에 로그인이 풀리면 포털이 확인창을 띄우고, 이 창이 페이지 이동을 붙잡아 시간 초과가 난다.
    if (await closeDialog(where)) throw new Error('session_lost');
    throw error;
  }
  if (await closeDialog(where)) throw new Error('session_lost');
  return page.evaluate(extractPage);
}

function foundIdsOf(extracted) {
  const ids = [];
  for (const row of extracted.tables.flat()) {
    for (const link of row.links) {
      const match = /[?&]foundId=(\d+)/.exec(link || '');
      if (match && !ids.includes(match[1])) ids.push(match[1]);
    }
  }
  return ids;
}

// 해석할 수 없는 주소(예: 'http://')를 던지지 않고 null로 돌려준다. 던지면 링크 하나 때문에 실행 전체가 멈춘다.
function parseLink(href) {
  try {
    return new URL(href, `${BASE}/`);
  } catch {
    return null;
  }
}

async function download(foundId, anchor) {
  const url = parseLink(anchor.href);
  const atchFileId = url?.searchParams.get('atchFileId') ?? '';
  const fileSn = url?.searchParams.get('fileSn') ?? '';
  // 두 값이 받은 파일의 경로에 들어가므로, 모양이 다르거나 다른 사이트나 다른 경로를 가리키면 받지 않는다.
  // 파일 묶음 번호에는 영문·숫자로만 된 것도 있고 하이픈이 든 것도 있다(test/fixtures/portal-output.json의 foundId 1007).
  // 점·슬래시·공백은 받지 않는다.
  const expected =
    url !== null &&
    url.origin === ORIGIN &&
    url.pathname === DOWNLOAD_PATH &&
    /^[A-Za-z0-9-]+$/.test(atchFileId) &&
    /^\d+$/.test(fileSn);
  if (!expected) {
    out.errors.push({ where: `evidence ${foundId}`, message: `모양이 다른 파일 링크를 건너뛰었다: ${String(anchor.href).slice(0, 120)}` });
    return;
  }
  const key = `${atchFileId}:${fileSn}`;
  if (known.has(key) || out.downloads.some((item) => item.key === key)) return;
  const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(anchor.text)?.[1] ?? 'bin').toLowerCase();
  const path = `${INPUT.downloadDir}/${atchFileId}_${fileSn}.${ext}`;
  const record = { foundId, key, atchFileId, fileSn, name: anchor.text, container: anchor.container, ext, path };
  // 파일 하나를 받다 실패해도 나머지 신청은 계속 읽는다. 여기서 던지면 실행 전체가 멈추고,
  // 다음 실행도 같은 파일에서 또 멈춘다. 실패한 파일은 저장하지 않으므로 다음 실행이 다시 받는다.
  try {
    // no-store: 카드 영수증이 브라우저 캐시에 남지 않게 한다.
    const response = await page.fetch(url.href, { saveAs: path, timeout: INPUT.fileTimeoutMs, cache: 'no-store' });
    const headers = response.headers ?? {};
    out.downloads.push({
      ...record,
      ok: Boolean(response.ok),
      status: response.status,
      contentType: String(headers['content-type'] ?? headers['Content-Type'] ?? ''),
    });
  } catch (error) {
    out.downloads.push({ ...record, ok: false, status: 0, contentType: '', error: String(error?.message ?? error).slice(0, 200) });
  }
}

const task = await taskSpace(INPUT.spaceName);
const page = task.page('p1');
try {
  await closeDialog('start');
  // 첫 화면은 로그인 확인 요청을 같은 사이트에서 보내려고 여는 것이라 로딩 완료까지 기다리지 않는다.
  // 첫 화면의 로딩 완료 신호가 30초 넘게 늦어 실행 전체가 멈춘 적이 있다.
  await page.goto(`${BASE}/main/main.do`, { waitUntil: 'commit', timeout: INPUT.navTimeoutMs });
  // 로그인이 풀린 채 목록 주소로 이동하면 확인창이 떠서 이동이 멈춘다.
  // 리다이렉트를 따라가지 않는 요청으로 먼저 확인하면 풀렸을 때 status 0이 온다.
  const probe = await page.fetch(`${BASE}/mypage/teamFound/list.do?menuNo=${MENU}`, {
    redirect: 'manual',
    timeout: INPUT.navTimeoutMs,
  });
  out.loggedIn = probe.status === 200 && String(probe.body ?? '').includes('증빙접수');
  if (out.loggedIn) {
    const foundIds = [];
    for (let index = 1; index <= INPUT.maxListPages; index += 1) {
      const extracted = await open(`${BASE}/mypage/teamFound/list.do?menuNo=${MENU}&pageIndex=${index}`, `list ${index}`);
      out.listPages.push(extracted);
      const ids = foundIdsOf(extracted);
      if (ids.length === 0) break;
      for (const id of ids) if (!foundIds.includes(id)) foundIds.push(id);
    }
    for (const id of foundIds) {
      out.views[id] = await open(`${BASE}/mypage/projectSpt/view.do?foundId=${id}&menuNo=${MENU}`, `view ${id}`);
      const evidence = await open(`${BASE}/mypage/projectSpt/evidence.do?foundId=${id}&menuNo=${MENU}`, `evidence ${id}`);
      out.evidences[id] = evidence;
      // 증빙으로 올린 파일은 file_list 목록 안에 있다. 목록 밖 링크는 파서도 증빙으로 세지 않으므로 받지 않는다.
      for (const anchor of evidence.anchors.filter((item) => item.container.includes('file_list'))) {
        await download(id, anchor);
      }
    }
  }
} catch (error) {
  out.fatal = String(error?.message ?? error).slice(0, 300);
} finally {
  out.finishedAt = new Date().toISOString();
  await fs.writeFile(INPUT.outputPath, JSON.stringify(out));
  await task.finish({ keep: [] });
}
console.log(
  JSON.stringify({
    loggedIn: out.loggedIn,
    listPages: out.listPages.length,
    views: Object.keys(out.views).length,
    downloads: out.downloads.length,
    fatal: out.fatal ?? null,
  }),
);
