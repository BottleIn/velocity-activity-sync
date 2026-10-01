import { isKnown } from './amounts.js';
import { DEFAULT_CONFIG, DEFAULT_ROUNDS } from './config.js';

export const CATEGORY_ORDER = Object.freeze([
  'AI·SW 서비스 이용료',
  '기자재 임대비',
  '기타',
  '디자인 제작비',
  '마케팅비',
  '재료 구매비',
  '전문가 활용비',
  '클라우드 서비스',
]);

function sumKnown(payments) {
  return payments.reduce((total, payment) => (isKnown(payment.krw) ? total + payment.krw : total), 0);
}

// 승인만 받고 증빙하기에 머문 신청은 빼지 않는다. 팀이 실제로 쓰지 않을 수도 있어서, 증빙완료가 되어야
// 쓴 돈으로 본다. 증빙완료인데 금액을 모르는 결제는 지출에서 빠지므로 unknownCount로 따로 알린다.
export function summarizeMoney(snapshot, { limit = DEFAULT_CONFIG.limit } = {}) {
  const payments = snapshot.applications.flatMap((application) => application.payments);
  const spent = sumKnown(payments);
  return {
    limit,
    spent,
    available: limit - spent,
    paymentCount: payments.length,
    unknownCount: payments.filter((payment) => !isKnown(payment.krw)).length,
  };
}

function addPayment(cell, payment) {
  return isKnown(payment.krw)
    ? { krw: cell.krw + payment.krw, unknown: cell.unknown }
    : { krw: cell.krw, unknown: cell.unknown + 1 };
}

function sumCell(payments) {
  return payments.reduce(addPayment, { krw: 0, unknown: 0 });
}

function orderCategories(categories) {
  const unique = [...new Set(categories)];
  const known = CATEGORY_ORDER.filter((category) => unique.includes(category));
  const others = unique.filter((category) => !CATEGORY_ORDER.includes(category));
  return [...known, ...others];
}

// 차수를 정하지 못한 결제도 지출에는 들어가므로, 표에서 사라지지 않게 unassigned에 따로 모은다.
function buildRow(category, payments, rounds) {
  const inRound = (round) => payments.filter((payment) => payment.round === round);
  const cells = Object.fromEntries(rounds.map((round) => [round, sumCell(inRound(round))]));
  const unassigned = sumCell(payments.filter((payment) => !rounds.includes(payment.round)));
  return { category, cells, unassigned };
}

export function itemRoundMatrix(snapshot, { rounds = DEFAULT_ROUNDS } = {}) {
  const entries = snapshot.applications.flatMap((application) =>
    application.payments.map((payment) => ({ category: application.category, payment })),
  );
  return orderCategories(entries.map((entry) => entry.category)).map((category) =>
    buildRow(
      category,
      entries.filter((entry) => entry.category === category).map((entry) => entry.payment),
      rounds,
    ),
  );
}
