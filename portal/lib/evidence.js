const FILE_DOWN_PATH = '/cmmn/file/fileDown.do';
const FILE_LIST_CONTAINER = 'file_list';
const PLACEHOLDER_ORIGIN = 'https://portal.invalid';
// 파일 묶음 번호에는 영문·숫자로만 된 것도 있고 하이픈이 든 것도 있다(test/fixtures/portal-output.json의 foundId 1007). 점·슬래시·공백은 받지 않는다.
const ATCH_FILE_ID = /^[A-Za-z0-9-]+$/;
const FILE_SN = /^\d+$/;
const MONTH_PREFIX = /^(\d{1,2})월/;
const EXTENSION = /\.([A-Za-z0-9]{1,5})$/;
const MIN_MONTH = 1;
const MAX_MONTH = 12;

// 포털은 한글 파일 이름을 자모가 풀어진 NFD로 줄 때가 있어, 정규화하지 않으면 '월'이 다른 글자로 비교된다.
export function monthFromName(name) {
  const match = MONTH_PREFIX.exec(String(name ?? '').normalize('NFC'));
  if (!match) return null;
  const month = Number(match[1]);
  return month >= MIN_MONTH && month <= MAX_MONTH ? month : null;
}

// 링크에 글자가 없는 파일도 있어서, 이름이 비면 키로 대신 가리킨다.
export function fileLabel(file) {
  return file.name === '' ? file.key : file.name;
}

function isAnchor(value) {
  return value !== null && typeof value === 'object';
}

// container 값이 없는 자료(시험 자료)는 목록 안의 링크로 본다.
function isInFileList(anchor) {
  return typeof anchor.container !== 'string' || anchor.container.includes(FILE_LIST_CONTAINER);
}

function parseUrl(href) {
  if (typeof href !== 'string') return null;
  try {
    return new URL(href, PLACEHOLDER_ORIGIN);
  } catch {
    return null;
  }
}

function extensionOf(name) {
  return (EXTENSION.exec(name)?.[1] ?? 'bin').toLowerCase();
}

// 두 값이 받은 파일의 경로에 들어가므로 read-portal.js와 같은 모양만 받는다.
function toFile(anchor) {
  const url = parseUrl(anchor.href);
  if (url === null || !url.pathname.endsWith(FILE_DOWN_PATH)) return null;
  const atchFileId = url.searchParams.get('atchFileId') ?? '';
  const fileSn = url.searchParams.get('fileSn') ?? '';
  if (!ATCH_FILE_ID.test(atchFileId) || !FILE_SN.test(fileSn)) return null;
  const name = String(anchor.text ?? '').normalize('NFC').trim();
  return {
    key: `${atchFileId}:${fileSn}`,
    atchFileId,
    fileSn,
    name,
    ext: extensionOf(name),
    month: monthFromName(name),
  };
}

function uniqueByKey(files) {
  const firstByKey = new Map();
  for (const file of files) {
    if (!firstByKey.has(file.key)) firstByKey.set(file.key, file);
  }
  return [...firstByKey.values()];
}

export function parseEvidenceLinks(anchors) {
  if (!Array.isArray(anchors)) return [];
  const files = anchors
    .filter(isAnchor)
    .filter(isInFileList)
    .map(toFile)
    .filter((file) => file !== null);
  return uniqueByKey(files);
}
