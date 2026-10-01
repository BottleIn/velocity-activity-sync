import { parseMoneyCell, parsePortalDate } from './list.js';

const TITLE_KEY = '제목';
const ITEMS_MARKER = '신청내용';
const MENTOR_MARKER = '멘토 평가의견';
const ITEM_NAME_KEY = '품목명';
const REASON_KEY = '구매사유';

const EMPTY_ITEM = Object.freeze({ name: '', payment: '', quantity: null, requestedKrw: null, approvedKrw: null });

function krwOf(value) {
  return parseMoneyCell(value).krw;
}

function parseQuantity(value) {
  return /^\d[\d,]*$/.test(value) ? Number(value.replaceAll(',', '')) : null;
}

// 값 없이 칸 이름만 있는 줄(예: '수량')은 빈 문자열이고, 다른 칸의 줄이면 null이다.
function fieldValue(line, key) {
  if (line === key) return '';
  return line.startsWith(`${key} `) ? line.slice(key.length + 1).trim() : null;
}

function firstValue(lines, key) {
  for (const line of lines) {
    const value = fieldValue(line, key);
    if (value !== null) return value;
  }
  return null;
}

function parseHeader(lines) {
  const totalRequested = firstValue(lines, '총 신청금액');
  const totalApproved = firstValue(lines, '총 승인금액');
  const date = firstValue(lines, '작성일');
  return {
    title: firstValue(lines, TITLE_KEY),
    status: firstValue(lines, '상태'),
    requestedKrw: totalRequested === null ? null : krwOf(totalRequested),
    approvedKrw: totalApproved === null ? null : krwOf(totalApproved),
    author: firstValue(lines, '작성자'),
    date: date === null ? null : parsePortalDate(date),
  };
}

const ITEM_FIELDS = [
  { key: '결제방식', prop: 'payment', read: (value) => value },
  { key: '수량', prop: 'quantity', read: parseQuantity },
  { key: '신청금액', prop: 'requestedKrw', read: krwOf },
  { key: '승인금액', prop: 'approvedKrw', read: krwOf },
];

// 같은 칸 이름이 다시 나오면 뒤의 줄이 이긴다. 진짜 신청금액·승인금액 줄은 자유 서술 칸(결제방식·세부사항) 뒤에 오기 때문이다.
function applyField(item, line) {
  for (const { key, prop, read } of ITEM_FIELDS) {
    const value = fieldValue(line, key);
    if (value !== null) return { ...item, [prop]: read(value) };
  }
  return item;
}

// 구매사유는 여러 줄이고 그 안에 '신청금액 ...'처럼 칸 이름으로 시작하는 줄이 있을 수 있다.
// 그래서 구매사유부터 다음 품목명까지는 읽지 않는다.
function parseItems(lines) {
  const finished = [];
  let current = null;
  for (const line of lines) {
    if (line === MENTOR_MARKER) break;
    const name = fieldValue(line, ITEM_NAME_KEY);
    if (name !== null || fieldValue(line, REASON_KEY) !== null) {
      if (current !== null) finished.push(current);
      current = name === null ? null : { ...EMPTY_ITEM, name };
    } else if (current !== null) {
      current = applyField(current, line);
    }
  }
  return current === null ? finished : [...finished, current];
}

export function parseViewText(pageText) {
  const lines = String(pageText ?? '')
    .normalize('NFC')
    .split('\n')
    .map((line) => line.trim());
  const start = lines.findIndex((line) => line.startsWith(`${TITLE_KEY} `));
  const body = start < 0 ? [] : lines.slice(start);
  const markerIndex = body.indexOf(ITEMS_MARKER);
  const headerLines = markerIndex < 0 ? body : body.slice(0, markerIndex);
  const itemLines = markerIndex < 0 ? [] : body.slice(markerIndex + 1);
  return { ...parseHeader(headerLines), items: parseItems(itemLines) };
}
