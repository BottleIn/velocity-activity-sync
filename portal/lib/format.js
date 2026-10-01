export const UNKNOWN_AMOUNT = '알 수 없음';

const NO_VALUES = '없음';
const EMPTY_VALUE = '(빈 값)';
const THOUSANDS_BOUNDARY = /\B(?=(\d{3})+(?!\d))/g;
// 포털에서 온 글자가 화면에 그대로 나가면 그 안의 제어 문자가 터미널을 조종할 수 있다(색·커서·제목 바꾸기).
// 줄바꿈(\n)과 탭(\t)만 남긴다. read-portal.js의 clean()이 같은 범위를 지운다.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

// toLocaleString은 실행 환경의 ICU 데이터에 따라 결과가 달라질 수 있어서 쓰지 않는다.
export function formatNumber(value) {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  return sign + String(Math.abs(rounded)).replace(THOUSANDS_BOUNDARY, ',');
}

export function formatWon(value) {
  return Number.isFinite(value) ? `${formatNumber(value)}원` : UNKNOWN_AMOUNT;
}

// 읽은 값을 메시지와 보고서에 그대로 보여 줄 글자로 만든다. 빈 값은 "없는 것"과 헷갈리지 않게 따로 적는다.
export function formatRawValues(rawValues) {
  if (rawValues.length === 0) return NO_VALUES;
  return rawValues.map((raw) => (raw === '' ? EMPTY_VALUE : raw)).join(', ');
}

export function stripControlCharacters(text) {
  return String(text ?? '').replace(CONTROL_CHARACTERS, '');
}
