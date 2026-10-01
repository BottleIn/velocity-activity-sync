import { isKnown } from './amounts.js';
import { fileLabel } from './evidence.js';
import { formatNumber, formatRawValues, formatWon, stripControlCharacters } from './format.js';
import { KIND } from './snapshot.js';

export { formatWon };

const TITLE = '활동비 포털 읽기 결과 (포털 기준 미리보기)';
const COLUMN_GAP = '  ';
const EMPTY_CELL = '-';
const NO_CATEGORY_LABEL = '(구분 없음)';
const UNASSIGNED_HEADER = '차수 없음';
const NONE_MARKER = '없음';
const EMPTY_READ_STATS = Object.freeze({ readCount: 0, cachedCount: 0, failed: [] });

// 터미널은 한글 같은 글자를 두 칸으로 그려서, 글자 수로 맞추면 표의 줄이 어긋난다.
const WIDE_RANGES = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
];

function isWide(codePoint) {
  return WIDE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
}

export function displayWidth(text) {
  return [...text].reduce((width, char) => width + (isWide(char.codePointAt(0)) ? 2 : 1), 0);
}

function padEndWidth(text, width) {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function padStartWidth(text, width) {
  return ' '.repeat(Math.max(0, width - displayWidth(text))) + text;
}

function categoryLabel(category) {
  return category === '' ? NO_CATEGORY_LABEL : category;
}

function countsSection({ head, applications }, money, readStats) {
  const countOf = (kind) => applications.filter((application) => application.kind === kind).length;
  const fileCount = applications.reduce((total, application) => total + application.files.length, 0);
  const kinds = `금액 없음 ${countOf(KIND.NONE)}건, 한 번에 결제 ${countOf(KIND.ONCE)}건, 월별 결제 ${countOf(KIND.MONTHLY)}건`;
  const reads = `이번에 새로 받아 읽음 ${readStats.readCount}개, 저장된 결과 사용 ${readStats.cachedCount}개, 받기 실패 ${readStats.failed.length}개`;
  return [
    '[읽은 내용]',
    `신청 ${applications.length}건: ${kinds}`,
    `결제 ${money.paymentCount}건 (금액을 알 수 없는 결제 ${money.unknownCount}건)`,
    `증빙 파일 ${fileCount}개: ${reads}`,
    `포털 화면 표시: 전체 ${head.total ?? '알 수 없음'}건, 총 승인금액 ${formatWon(head.approvedKrw)}`,
  ].join('\n');
}

function formatCell({ krw, unknown }) {
  if (unknown === 0) return krw === 0 ? EMPTY_CELL : formatNumber(krw);
  return `${formatNumber(krw)} (+모름 ${unknown})`;
}

function renderTable(header, rows) {
  const all = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...all.map((row) => displayWidth(row[column]))));
  const pad = (text, column) => (column === 0 ? padEndWidth(text, widths[column]) : padStartWidth(text, widths[column]));
  return all.map((row) => row.map(pad).join(COLUMN_GAP));
}

function matrixSection(matrix) {
  const heading = '[항목별 지출 (구분 x 차수)]';
  if (matrix.length === 0) return `${heading}\n결제가 없습니다.`;
  const rounds = Object.keys(matrix[0].cells)
    .map(Number)
    .sort((a, b) => a - b);
  const showUnassigned = matrix.some((row) => formatCell(row.unassigned) !== EMPTY_CELL);
  const header = ['구분', ...rounds.map((round) => `${round}차`), ...(showUnassigned ? [UNASSIGNED_HEADER] : [])];
  const rows = matrix.map((row) => [
    categoryLabel(row.category),
    ...rounds.map((round) => formatCell(row.cells[round])),
    ...(showUnassigned ? [formatCell(row.unassigned)] : []),
  ]);
  return [heading, ...renderTable(header, rows)].join('\n');
}

const MONEY_LINES = [
  ['한도', 'limit', ''],
  ['지출', 'spent', '증빙완료이고 금액을 아는 결제만'],
  ['사용 가능', 'available', '한도 - 지출'],
];

function moneySection(money) {
  const labelWidth = Math.max(...MONEY_LINES.map(([label]) => displayWidth(label)));
  const valueWidth = Math.max(...MONEY_LINES.map(([, key]) => displayWidth(formatWon(money[key]))));
  const lines = MONEY_LINES.map(([label, key, note]) => {
    const line = `${padEndWidth(label, labelWidth)}  ${padStartWidth(formatWon(money[key]), valueWidth)}`;
    return note === '' ? line : `${line}  (${note})`;
  });
  const understated =
    money.unknownCount > 0
      ? [`금액을 알 수 없는 결제 ${money.unknownCount}건은 지출에 넣지 못해 실제 지출은 이보다 클 수 있습니다.`]
      : [];
  return ['[금액 요약]', ...lines, ...understated].join('\n');
}

function paymentLabel(application, payment) {
  if (payment.key !== null) return payment.key;
  return payment.month === null ? application.foundId : `${application.foundId} (${payment.month}월)`;
}

function unknownPaymentLines(application, payment) {
  const names = payment.fileKeys
    .map((key) => application.files.find((file) => file.key === key))
    .filter((file) => file !== undefined)
    .map(fileLabel);
  return [
    `- ${paymentLabel(application, payment)} (${categoryLabel(application.category)})`,
    `    파일: ${names.length > 0 ? names.join(', ') : '(없음)'}`,
    ...(payment.rawValues.length > 0 ? [`    읽은 값: ${formatRawValues(payment.rawValues)}`] : []),
  ];
}

function unknownSection({ applications }) {
  const lines = applications.flatMap((application) => {
    const unknown = application.payments.filter((payment) => !isKnown(payment.krw));
    return unknown.flatMap((payment) => unknownPaymentLines(application, payment));
  });
  if (lines.length === 0) return `[금액을 알 수 없는 결제]\n${NONE_MARKER}`;
  const count = lines.filter((line) => line.startsWith('- ')).length;
  return [`[금액을 알 수 없는 결제 ${count}건]`, ...lines].join('\n');
}

function warningsSection(warnings, failedDownloads) {
  const lines = [
    ...warnings.map((warning) => `- ${warning.message}`),
    ...failedDownloads.map((failed) => `- 증빙 파일을 받지 못했습니다: ${failed.name} (${failed.message})`),
  ];
  if (lines.length === 0) return `[주의할 점]\n${NONE_MARKER}`;
  return [`[주의할 점 ${lines.length}건]`, ...lines].join('\n');
}

// 포털에서 온 글자(구분·파일 이름·경고·읽은 값)가 터미널을 조종하지 못하게 마지막에 한 번에 제어 문자를 지운다.
// 개별 글자마다 지우면 새로 넣는 항목을 빠뜨리기 쉽다. 표 맞춤은 정상 글자를 기준으로 하므로 제어 문자가 든 줄은 어긋날 수 있다.
export function formatReport({ snapshot, money, matrix, readStats = EMPTY_READ_STATS }) {
  const sections = [
    TITLE,
    countsSection(snapshot, money, readStats),
    matrixSection(matrix),
    moneySection(money),
    unknownSection(snapshot),
    warningsSection(snapshot.warnings, readStats.failed),
  ];
  return stripControlCharacters(`${sections.join('\n\n')}\n`);
}
