const MARKER_COLUMN = '증빙접수';
// 열은 이름으로 찾는다. 포털이 열 순서를 바꿔도 읽히게 하려는 것이다.
const REQUIRED_COLUMNS = ['구분', '제목', '신청금액', '승인금액', '상태', MARKER_COLUMN, '작성자', '등록일'];

const TOTAL_COUNT = /Total\s*:\s*(\d[\d,]*)/;
const TOTAL_APPROVED = /총\s*승인금액\s*₩\s*(\d[\d,]*)/;
const KRW_CELL = /₩\s*(\d[\d,]*)/;
const USD_CELL = /\$\s*(\d[\d,]*(?:\.\d+)?)/;
const FOUND_ID = /[?&]foundId=(\d+)/;
const PORTAL_DATE = /^(\d{4})[.\-/](\d{2})[.\-/](\d{2})$/;
const MAX_MONTH = 12;
const MAX_DAY = 31;

function text(value) {
  return String(value ?? '').normalize('NFC').trim();
}

function toNumber(digits) {
  return digits === undefined ? null : Number(digits.replaceAll(',', ''));
}

export function parseMoneyCell(cell) {
  const source = String(cell ?? '');
  return {
    krw: toNumber(KRW_CELL.exec(source)?.[1]),
    usd: toNumber(USD_CELL.exec(source)?.[1]),
  };
}

export function parsePortalDate(value) {
  const match = PORTAL_DATE.exec(text(value));
  if (!match) return null;
  const [, year, month, day] = match;
  const isValid = Number(month) >= 1 && Number(month) <= MAX_MONTH && Number(day) >= 1 && Number(day) <= MAX_DAY;
  return isValid ? `${year}-${month}-${day}` : null;
}

export function parseListHead(pageText) {
  const source = String(pageText ?? '');
  return {
    total: toNumber(TOTAL_COUNT.exec(source)?.[1]),
    approvedKrw: toNumber(TOTAL_APPROVED.exec(source)?.[1]),
  };
}

function findActivityTable(page) {
  const tables = Array.isArray(page?.tables) ? page.tables : [];
  return (
    tables.find((table) => {
      const header = table?.[0]?.cells;
      return Array.isArray(header) && header.some((cell) => text(cell) === MARKER_COLUMN);
    }) ?? null
  );
}

function foundIdOf(links) {
  for (const link of Array.isArray(links) ? links : []) {
    const match = FOUND_ID.exec(String(link ?? ''));
    if (match) return match[1];
  }
  return null;
}

function parseRow(row, columns) {
  const foundId = foundIdOf(row?.links);
  if (foundId === null) return null;
  const cell = (name) => text(row.cells?.[columns[name]]);
  return {
    foundId,
    category: cell('구분'),
    title: cell('제목'),
    requested: parseMoneyCell(cell('신청금액')),
    approved: parseMoneyCell(cell('승인금액')),
    status: cell('상태'),
    evidenceStatus: cell(MARKER_COLUMN),
    author: cell('작성자'),
    date: parsePortalDate(cell('등록일')),
  };
}

function parseActivityTable(page) {
  const table = findActivityTable(page);
  if (table === null) return { headerFound: false, missingColumns: [], rows: [] };
  const header = table[0].cells.map(text);
  const columns = Object.fromEntries(REQUIRED_COLUMNS.map((name) => [name, header.indexOf(name)]));
  const missingColumns = REQUIRED_COLUMNS.filter((name) => columns[name] < 0);
  if (missingColumns.length > 0) return { headerFound: true, missingColumns, rows: [] };
  const rows = table
    .slice(1)
    .map((row) => parseRow(row, columns))
    .filter((row) => row !== null);
  return { headerFound: true, missingColumns, rows };
}

function uniqueByFoundId(rows) {
  const firstById = new Map();
  for (const row of rows) {
    if (!firstById.has(row.foundId)) firstById.set(row.foundId, row);
  }
  return [...firstById.values()];
}

export function parseListPages(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const parsed = list.map(parseActivityTable);
  return {
    head: parseListHead(list[0]?.text),
    rows: uniqueByFoundId(parsed.flatMap((page) => page.rows)),
    headerFound: parsed[0]?.headerFound ?? false,
    missingColumns: parsed[0]?.missingColumns ?? [],
  };
}
