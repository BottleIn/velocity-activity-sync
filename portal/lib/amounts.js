/**
 * 증빙 내역서의 글자에서 결제 금액을 읽는다.
 *
 * 읽는 규칙이나 저장하는 모양을 바꾸면 PARSER_VERSION을 올려야 한다. state.json에 저장된 결과는 이 값이
 * 같을 때만 다시 쓰이므로, 올리지 않으면 예전 규칙으로 읽은 금액이 그대로 남는다.
 * 2로 올린 이유: 원 금액을 읽는 규칙이 엄격해졌고, 저장하는 원문이 값 전체에서 금액 조각으로 줄었다.
 *
 * 달러 표기는 원화로 바꾸지 않는다. 환율을 알 수 없어서, 원화 금액이 함께 적혀 있지 않으면
 * null로 두고 사람이 확인하게 한다. 틀린 숫자를 돌려주느니 null을 돌려주는 것이 이 파일의 원칙이다.
 *
 * 증빙 내역서에는 결제자 이름과 카드 번호가 들어 있어서, 읽은 결과에는 금액만 남긴다. 원화로 읽은 값은
 * { krw }만 저장하고, 읽지 못한 값에만 사람이 확인할 단서로 금액처럼 보이는 첫 조각(raw)을 붙인다.
 */
export const PARSER_VERSION = 2;

export const FILE_REASON = Object.freeze({
  OK: 'ok',
  NOT_KRW: 'not_krw',
  NO_LABEL: 'no_label',
  UNREADABLE: 'unreadable',
  UNSUPPORTED: 'unsupported',
});

export const RAW_MAX_LENGTH = 20;
// 내역서에는 결제자마다 금액 칸이 하나씩 있다(test/fixtures/evidence-files.json). 이보다 많은 칸은 정상이 아니다.
// 한도를 두어 꾸민 파일이 처리 시간을 늘리지 못하게 한다.
export const MAX_LABELS = 50;

// 활동비 한도(config.js의 limit 기본값 12,000,000원)보다 훨씬 큰 값이다. 카드 번호 같은 긴 숫자를 금액으로 읽지 않게 한다.
const MAX_KRW = 999_999_999_999;
const MAX_MONEY_DIGITS = 12;

const TOO_MANY_LABELS_DETAIL = `'금액(VAT포함)' 칸이 ${MAX_LABELS}개를 넘어 증빙 내역서로 읽지 않았습니다.`;

const LABEL = /금액\s*[(（]\s*VAT\s*포함\s*[)）]/g;
const LABEL_PRESENCE = new RegExp(LABEL.source);
const VALUE_LEAD = /^[\s|:：]+/;

const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+|\d+)`;
// 마이너스로 쓰이는 글자: 하이픈, 유니코드 하이픈과 대시류, 수학 마이너스, 전각 하이픈.
const MINUS = String.raw`\u002d\u2010-\u2015\u2212\uff0d`;
// 숫자 바로 앞의 숫자·소수점·쉼표·마이너스는 더 큰 숫자의 일부이거나 음수다(210.5원의 5, -12,000원).
// 뒤로 훑는 비용이 커지지 않게 숫자 자리에서만 검사한다.
const KRW_WITH_UNIT = new RegExp(String.raw`(?=\d)(?<![\d.,${MINUS}])${NUMBER}\s*원`, 'g');
// 공백을 사이에 둔 앞 숫자와 붙은 금액(1 000원)은 천 단위를 공백으로 쓴 것인지 앞 숫자와 이어진 것인지 알 수 없다.
// 다른 금액이 함께 적혀 있어도(1,000원 5 000원) 하나만 골라 읽지 않고 통째로 읽지 못한 값으로 둔다.
const SPACED_UNIT_FIGURE = new RegExp(String.raw`\d\s+${NUMBER}\s*원`);
// 기호 뒤 숫자에 소수점이나 쉼표로 이어진 숫자(₩1,000.50)와 공백으로 이어진 세 자리 묶음(₩1 000)이 붙으면 금액이 아니다.
const KRW_WITH_SYMBOL = new RegExp(
  String.raw`(?<![${MINUS}])(?:₩|KRW)\s*${NUMBER}(?![.,]?\d)(?!\s\d{3}(?!\d))`,
  'gi',
);
const PLAIN_INTEGER = new RegExp(`^${NUMBER}$`);

// 금액처럼 보이는 첫 조각이다. 통화 표기(원, 달러, $, ₩, USD, KRW)가 붙은 숫자이거나, 천 단위 쉼표나 소수점이 있는
// 금액 모양의 숫자만 조각으로 친다. 표기도 모양도 없는 숫자는 카드 번호의 일부인지 금액인지 가를 수 없어서 남기지 않는다.
// 숫자·구분 문자에 바로 이어진 조각도 치지 않는다(010.1234.5678, 1,000,00, -12,000원). 앞에서는 공백을 건너서도 본다
// (1234 5678 3456원의 3456원). 그래서 카드 번호·날짜·전화번호는 묶음 사이가 무엇이든 조각 하나도 남기지 않는다.
// $·USD·KRW는 숫자 앞에도 뒤에도 올 수 있다. 뒤에 붙은 것으로 읽었을 때 바로 다음에 숫자가 오면 그 표기는 다음 숫자의 것이다(5 $ 1,000).
// 맨 앞의 lookahead는 앞 검사(lookbehind)가 숫자·통화 표기의 첫 글자 자리에서만 돌게 한다. 공백이 긴 글에서 자리마다 뒤로 훑지 않으려는 것이다.
const AMOUNT = String.raw`\d+(?:,\d{3})*(?:\.\d+)?`;
const SHAPED_AMOUNT = String.raw`\d+(?:,\d{3})+(?:\.\d+)?|\d+\.\d+`;
const SUFFIX_MARKER = String.raw`(?:원|달러|(?:\$|USD|KRW)(?!\s{0,3}\d))`;
const MONEY_TOKEN = new RegExp(
  String.raw`(?=[$₩\dUK])(?<![\d.,${MINUS}]\s*)(?:(?:[$₩]|USD|KRW)\s{0,3}${AMOUNT}|${AMOUNT}\s{0,3}${SUFFIX_MARKER}|${SHAPED_AMOUNT})(?![.,${MINUS}]?\d)`,
  'i',
);

export function isKnown(krw) {
  return typeof krw === 'number' && Number.isFinite(krw);
}

function toNumber(text) {
  return Number(text.replaceAll(',', ''));
}

// 두 형식에서 원 금액을 모으되, 서로 다른 금액이 둘 나오면 거기서 멈춘다.
function distinctWonFigures(text) {
  const figures = new Set();
  for (const pattern of [KRW_WITH_UNIT, KRW_WITH_SYMBOL]) {
    for (const match of text.matchAll(pattern)) {
      figures.add(toNumber(match[1]));
      if (figures.size > 1) return figures;
    }
  }
  return figures;
}

// 원 표기가 없는 값은 숫자만 적힌 경우(500,000)에만 원으로 읽는다.
export function parseKrwValue(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (SPACED_UNIT_FIGURE.test(text)) return null;
  const figures = distinctWonFigures(text);
  if (figures.size > 1) return null;
  const [figure] = figures;
  const krw = figures.size === 1 ? figure : PLAIN_INTEGER.test(text) ? toNumber(text) : null;
  return krw !== null && krw <= MAX_KRW ? krw : null;
}

function trimValue(text) {
  return text.replace(VALUE_LEAD, '').trim();
}

// 다음 줄이 또 다른 금액 라벨 줄이면 값으로 쓰지 않는다. 그 줄에는 다른 결제자의 이름이 들어 있다.
// 줄 배열을 잘라 복사하지 않고 인덱스로 훑는다. 라벨마다 복사하면 줄 수의 제곱만큼 걸린다.
function nextLineValue(lines, from) {
  for (let index = from; index < lines.length; index += 1) {
    if (lines[index].trim() === '') continue;
    return LABEL_PRESENCE.test(lines[index]) ? '' : trimValue(lines[index]);
  }
  return '';
}

// 한 줄에서 최대 room개의 값을 읽는다. 마지막 값의 끝을 알려면 다음 라벨 위치가 필요해서 하나를 더 찾는다.
function valuesOnLine(lines, index, room) {
  const line = lines[index];
  const matches = [];
  for (const match of line.matchAll(LABEL)) {
    matches.push(match);
    if (matches.length > room) break;
  }
  return matches.slice(0, room).map((match, position) => {
    const start = match.index + match[0].length;
    const end = matches[position + 1]?.index ?? line.length;
    const sameLine = trimValue(line.slice(start, end));
    return sameLine === '' ? nextLineValue(lines, index + 1) : sameLine;
  });
}

// limit개를 채우면 멈춘다. 라벨이 아주 많은 파일을 끝까지 훑지 않으려는 것이다.
function collectValues(lines, limit) {
  const values = [];
  for (let index = 0; index < lines.length && values.length < limit; index += 1) {
    for (const value of valuesOnLine(lines, index, limit - values.length)) values.push(value);
  }
  return values;
}

function moneyToken(value) {
  const token = MONEY_TOKEN.exec(value)?.[0] ?? '';
  if (token.replace(/\D/g, '').length > MAX_MONEY_DIGITS) return '';
  return token.slice(0, RAW_MAX_LENGTH);
}

function toAmount(value) {
  const krw = parseKrwValue(value);
  return krw === null ? { raw: moneyToken(value), krw } : { krw };
}

function summarize(amounts) {
  if (amounts.length === 0) return { amounts, total: null, reason: FILE_REASON.NO_LABEL };
  if (amounts.some((amount) => amount.krw === null)) {
    return { amounts, total: null, reason: FILE_REASON.NOT_KRW };
  }
  const total = amounts.reduce((sum, amount) => sum + amount.krw, 0);
  return { amounts, total, reason: FILE_REASON.OK };
}

export function extractAmounts(text) {
  const source = typeof text === 'string' ? text : '';
  const lines = source.normalize('NFC').split(/\r?\n/);
  const values = collectValues(lines, MAX_LABELS + 1);
  const amounts = values.slice(0, MAX_LABELS).map(toAmount);
  if (values.length > MAX_LABELS) {
    return { amounts, total: null, reason: FILE_REASON.UNREADABLE, detail: TOO_MANY_LABELS_DETAIL };
  }
  return summarize(amounts);
}

const XML_ENTITY = /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g;
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const MAX_CODE_POINT = 0x10ffff;
const SURROGATES = [0xd800, 0xdfff];
// 변경 추적으로 지운 글자(delText)와 필드 코드(instrText)는 화면에 보이지 않는 글자다.
// 스스로 닫는 태그(<w:delText/>)는 잡지 않고, 내용은 '<'를 만나면 끝난다.
const HIDDEN_TEXT = /<w:(delText|instrText)(?:\s[^<>]*)?(?<!\/)>[^<]*<\/w:\1>/g;

function isValidCodePoint(codePoint) {
  const isSurrogate = codePoint >= SURROGATES[0] && codePoint <= SURROGATES[1];
  return codePoint > 0 && codePoint <= MAX_CODE_POINT && !isSurrogate;
}

function decodeEntity(whole, body) {
  if (Object.hasOwn(NAMED_ENTITIES, body)) return NAMED_ENTITIES[body];
  const codePoint = body.startsWith('#x')
    ? Number.parseInt(body.slice(2), 16)
    : Number.parseInt(body.slice(1), 10);
  return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : whole;
}

// 태그를 먼저 지우고 엔티티를 나중에, 한 번에 푼다. 글자 조각(<w:t>)이 엔티티 중간에서 갈라져도
// (test/fixtures/evidence-files.json의 `&a` + `mp;`) 이어 붙인 뒤에야 온전한 엔티티가 된다.
// 두 번 풀면 &amp;lt; 가 <로 잘못 바뀐다.
// <w:tab/>만 탭으로 바꾼다. 속성이 붙은 <w:tab .../>은 탭 정지 위치 정의이지 탭 문자가 아니다.
// 태그 패턴은 [^<>]*로 쓴다. XML 태그 안에는 '<'가 올 수 없으므로 뜻은 같고, 닫히지 않은 '<'가 수없이 이어진
// 파일에서 태그마다 끝까지 훑느라 제곱만큼 걸리는 일이 없다.
export function docxXmlToText(xml) {
  const source = typeof xml === 'string' ? xml : '';
  const stripped = source
    .replace(HIDDEN_TEXT, '')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<w:tab\s*\/>/g, '\t')
    .replace(/<w:br(?=[\s/>])[^<>]*>/g, '\n')
    .replace(/<[^<>]*>/g, '');
  return stripped.replace(XML_ENTITY, decodeEntity).normalize('NFC');
}
