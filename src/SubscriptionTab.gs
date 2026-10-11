/**
 * 구독 포함 잔액 탭. 매달 나가는 구독을 남은 달까지 미리 빼서, 구독 말고 새로 신청할 수 있는 돈을 보여 준다.
 *
 * 낸 달은 jira_sync의 실제 결제액을 쓰고, 아직 증빙완료가 아닌 달은 가장 최근에 낸 달의 금액을 그대로 쓴다.
 * 구독은 달러로 결제해 환율에 따라 매달 조금씩 달라지므로 남은 달의 금액은 어림값이다.
 * 신청 가능 금액은 현황 탭과 같은 포털 동기화 기록에서 읽어, 두 탭의 출발점이 같은 숫자가 되게 한다.
 * 이 탭은 매번 통째로 다시 쓰므로, 노란 가정 금액 칸 말고는 손으로 적은 내용이 남지 않는다.
 * 가정 금액은 공개 저장소에 팀 예산을 적지 않으려고 코드에 두지 않고 시트 칸에서 읽는다.
 */

const SUBSCRIPTION_SHEET_NAME = '구독 포함 잔액';
// 활동비 차수는 결제한 달로 센다. 7월이 1차이고 11월이 5차다(StatusTab.gs의 STATUS_ROUNDS와 같은 기간).
const SUBSCRIPTION_MONTHS = ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11'];
// match는 Jira 티켓 제목에 들어 있는 말이다. 여러 달 신청 티켓은 시트제외 라벨 때문에 jira_sync에 없어서
// 달별 결제 티켓만 걸린다.
const SUBSCRIPTIONS = [
  { name: 'Claude Max 20x', match: 'Claude' },
  { name: 'Vercel Pro', match: 'Vercel' },
];
// portal/lib/money.js의 CATEGORY_ORDER에 있는 이름과 같아야 포털 기록에서 마케팅비 줄을 찾는다.
const MARKETING_CATEGORY = '마케팅비';
const MARKETING_PLAN_LABEL = '마케팅비 총합 (가정)';
const ESTIMATE_COLOR = '#80868b';
const INPUT_COLOR = '#fef7e0';
const MONEY_FORMAT = '#,##0"원"';

function paidByMonth_(rows, idx, match) {
  return SUBSCRIPTION_MONTHS.map(function (month) {
    return rows
      .filter(function (r) {
        return r[idx['배정월']] === month && String(r[idx['품목·서비스']]).indexOf(match) !== -1;
      })
      .reduce(function (sum, r) { return sum + (Number(r[idx['실제 결제액']]) || 0); }, 0);
  });
}

// 마지막으로 낸 달 뒤의 달만 어림한다. 그 앞에서 비어 있는 달은 구독을 시작하기 전이라 0으로 둔다.
function withEstimates_(paid) {
  let last = -1;
  paid.forEach(function (krw, i) { if (krw > 0) last = i; });
  return paid.map(function (krw, i) {
    if (last === -1 || i <= last) return { krw: krw, estimated: false };
    return { krw: paid[last], estimated: true };
  });
}

function sumCells_(cells, estimated) {
  return cells
    .filter(function (cell) { return cell.estimated === estimated; })
    .reduce(function (sum, cell) { return sum + cell.krw; }, 0);
}

function monthLabel_(month) {
  return Number(month.slice(5)) + '월';
}

// 현황 탭의 항목 × 차수 표와 같은 방식으로 더해야 두 탭의 마케팅비 지출이 같은 숫자가 된다.
function categorySpent_(matrix, category) {
  const row = matrix.find(function (r) { return r.category === category; });
  if (!row) return 0;
  const assigned = STATUS_ROUNDS.reduce(function (sum, round) {
    return sum + (row.cells[round] ? row.cells[round].krw : 0);
  }, 0);
  return assigned + (row.unassigned ? row.unassigned.krw : 0);
}

// 탭을 지우기 전에 사람이 적어 둔 가정 금액을 읽는다. 칸 위치가 아니라 이름표로 찾아서 표가 길어져도 따라간다.
function readMarketingPlan_(sheet) {
  const cells = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 2).getValues();
  const found = cells.find(function (r) { return r[0] === MARKETING_PLAN_LABEL; });
  return found && typeof found[1] === 'number' ? found[1] : '';
}

function subscriptionLayout_(tableHeight) {
  const table = 5;
  const summary = table + tableHeight + 1;
  const usable = summary + 2;
  const plan = usable + 3;
  return { table: table, tableHeight: tableHeight, summary: summary, usable: usable, plan: plan, left: plan + 3, note: plan + 5 };
}

/** 구독 포함 잔액 탭을 다시 그린다. 시간 트리거와 [지금 동기화]가 부른다. (트리거에선 UI 금지) */
function updateSubscriptionTab() {
  const record = readPortalRecord_();
  const rows = syncRows_();
  const idx = columnIndex_();
  const lines = SUBSCRIPTIONS.map(function (sub) {
    const cells = withEstimates_(paidByMonth_(rows, idx, sub.match));
    return { name: sub.name, cells: cells, paid: sumCells_(cells, false), upcoming: sumCells_(cells, true) };
  });
  const totalCells = SUBSCRIPTION_MONTHS.map(function (_, i) {
    return lines.reduce(function (sum, line) { return sum + line.cells[i].krw; }, 0);
  });
  const totalPaid = lines.reduce(function (sum, line) { return sum + line.paid; }, 0);
  const totalUpcoming = lines.reduce(function (sum, line) { return sum + line.upcoming; }, 0);
  const available = record.money.available;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SUBSCRIPTION_SHEET_NAME) || ss.insertSheet(SUBSCRIPTION_SHEET_NAME, 1);
  const marketingPlan = readMarketingPlan_(sheet);
  sheet.clear();

  const width = SUBSCRIPTION_MONTHS.length + 3;
  const pad = function (row) { return row.concat(new Array(width - row.length).fill('')); };
  const table = [
    ['구독'].concat(SUBSCRIPTION_MONTHS.map(monthLabel_), ['낸 돈', '낼 돈 (예상)']),
  ].concat(lines.map(function (line) {
    return [line.name].concat(line.cells.map(function (cell) { return cell.krw; }), [line.paid, line.upcoming]);
  }), [
    ['합계'].concat(totalCells, [totalPaid, totalUpcoming]),
  ]);
  const at = subscriptionLayout_(table.length);
  const values = [
    pad(['Velocity 구독 포함 잔액']),
    pad(['포털 기준 시각', formatKst_(record.at)]),
    pad(['시트 갱신 시각', formatKst_(new Date().toISOString())]),
    pad(['']),
  ].concat(table, [
    pad(['']),
    pad(['신청 가능 (현황 탭과 같음)', available]),
    pad(['앞으로 낼 구독 (예상)', totalUpcoming]),
    pad(['구독을 빼고 쓸 수 있는 돈', available - totalUpcoming]),
    pad(['']),
    pad(['마케팅비를 다 쓴다고 가정하면']),
    pad([MARKETING_PLAN_LABEL, marketingPlan]),
    pad(['이미 쓴 마케팅비 (증빙완료)', categorySpent_(record.matrix, MARKETING_CATEGORY)]),
    pad(['앞으로 쓸 마케팅비', '=MAX(B' + at.plan + '-B' + (at.plan + 1) + ',0)']),
    pad(['구독과 마케팅비를 빼고 쓸 수 있는 돈', '=B' + at.usable + '-B' + (at.plan + 2)]),
    pad(['']),
    pad(['회색 기울임 칸은 아직 증빙완료가 아닌 달입니다. 가장 최근에 낸 달의 금액으로 어림했고, 증빙완료가 되면 실제 금액으로 바뀝니다.']),
    pad(['노란 칸은 직접 적는 가정 금액입니다. 바꾸면 아래 두 줄이 바로 다시 계산되고, 동기화해도 그대로 남습니다.']),
  ]);
  sheet.getRange(1, 1, values.length, width).setValues(values);
  formatSubscriptionTab_(sheet, at, width, lines);
}

function formatSubscriptionTab_(sheet, at, width, lines) {
  const totalRow = at.table + at.tableHeight - 1;
  sheet.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  sheet.getRange(at.table, 1, 1, width).setFontWeight('bold').setBackground('#f1f3f4');
  sheet.getRange(totalRow, 1, 1, width).setFontWeight('bold');
  sheet.getRange(at.table + 1, 2, at.tableHeight - 1, width - 1).setNumberFormat('#,##0;-#,##0;"-"');
  lines.forEach(function (line, row) {
    line.cells.forEach(function (cell, col) {
      if (!cell.estimated) return;
      sheet.getRange(at.table + 1 + row, 2 + col).setFontColor(ESTIMATE_COLOR).setFontStyle('italic');
      sheet.getRange(totalRow, 2 + col).setFontColor(ESTIMATE_COLOR).setFontStyle('italic');
    });
  });
  sheet.getRange(at.table + 1, width, at.tableHeight - 1, 1).setFontColor(ESTIMATE_COLOR).setFontStyle('italic');
  sheet.getRange(at.summary, 2, 3, 1).setNumberFormat(MONEY_FORMAT);
  sheet.getRange(at.plan, 2, 4, 1).setNumberFormat(MONEY_FORMAT);
  sheet.getRange(at.plan - 1, 1).setFontWeight('bold');
  sheet.getRange(at.plan, 2).setBackground(INPUT_COLOR);
  [at.usable, at.left].forEach(function (row) {
    sheet.getRange(row, 1, 1, 2).setFontWeight('bold').setBackground('#e8f0fe');
  });
  sheet.getRange(at.note, 1, 2, 1).setFontColor(ESTIMATE_COLOR);
  sheet.setColumnWidth(1, 270);
  sheet.setColumnWidths(2, width - 1, 110);
}
