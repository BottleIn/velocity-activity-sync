/**
 * 현황 탭. 이 Mac의 포털 동기화(portal/sync.js)가 운영 에픽의 엔티티 속성에 남긴 돈 요약을 읽어 그린다.
 *
 * 숫자를 시트에서 다시 계산하지 않는다. 지출은 포털에서 증빙완료인 결제를 증빙 파일의 금액으로 더한 값이라
 * 증빙 파일을 읽는 포털 동기화 쪽에서만 셀 수 있고, 그 계산은 그쪽에 시험과 함께 있다.
 * 이 탭은 매번 통째로 다시 쓰므로 손으로 적은 내용은 남지 않는다.
 */

const STATUS_SHEET_NAME = '현황';
const STATUS_EPIC_KEY = 'VEL-169';
const STATUS_PROPERTY_KEY = 'velocity.portalSync';
const STATUS_STALE_DAYS = 7;
const STATUS_ROUNDS = ['1', '2', '3', '4', '5'];

function readPortalRecord_() {
  const response = jiraFetch_('/issue/' + STATUS_EPIC_KEY + '/properties/' + STATUS_PROPERTY_KEY);
  return response.value;
}

function formatKst_(iso) {
  return Utilities.formatDate(new Date(iso), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
}

function matrixRows_(matrix) {
  const header = ['구분'].concat(STATUS_ROUNDS.map(function (round) { return round + '차'; }), ['합계', '금액 모름']);
  const rows = matrix.map(function (row) {
    let total = 0;
    let unknown = row.unassigned ? row.unassigned.unknown : 0;
    const cells = STATUS_ROUNDS.map(function (round) {
      const cell = row.cells[round] || { krw: 0, unknown: 0 };
      total += cell.krw;
      unknown += cell.unknown;
      return cell.krw;
    });
    if (row.unassigned) total += row.unassigned.krw;
    return [row.category].concat(cells, [total, unknown > 0 ? unknown + '건' : '']);
  });
  return [header].concat(rows);
}

/** 현황 탭을 다시 그린다. 시간 트리거와 [지금 동기화]가 부른다. (트리거에선 UI 금지) */
function updateStatusTab() {
  const record = readPortalRecord_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(STATUS_SHEET_NAME) || ss.insertSheet(STATUS_SHEET_NAME, 0);
  sheet.clear();
  const money = record.money;
  const ageDays = (Date.now() - new Date(record.at).getTime()) / 86400000;
  const rows = [
    ['Velocity 활동비 현황'],
    ['포털 기준 시각', formatKst_(record.at)],
    ['시트 갱신 시각', formatKst_(new Date().toISOString())],
    [''],
    ['한도', money.limit],
    ['지출 (증빙완료만)', money.spent],
    ['신청 가능 (한도 - 지출)', money.available],
    ['금액을 모르는 결제', money.unknownCount > 0 ? money.unknownCount + '건 (Jira 실제 결제액을 채우면 반영된다)' : '없음'],
    [''],
    ['항목 × 차수 (증빙 기준, 원)'],
  ];
  rows.forEach(function (row, index) { sheet.getRange(index + 1, 1, 1, row.length).setValues([row]); });
  const matrix = matrixRows_(record.matrix);
  const matrixTop = rows.length + 1;
  sheet.getRange(matrixTop, 1, matrix.length, matrix[0].length).setValues(matrix);
  const warningTop = matrixTop + matrix.length + 1;
  sheet.getRange(warningTop, 1).setValue('확인할 것');
  (record.warnings || []).forEach(function (warning, index) {
    sheet.getRange(warningTop + 1 + index, 1).setValue('- ' + warning);
  });

  sheet.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  sheet.getRange(5, 2, 3, 1).setNumberFormat('#,##0"원"');
  sheet.getRange(7, 1, 1, 2).setFontWeight('bold').setBackground('#e8f0fe');
  sheet.getRange(matrixTop, 1, 1, matrix[0].length).setFontWeight('bold').setBackground('#f1f3f4');
  sheet.getRange(matrixTop + 1, 2, Math.max(matrix.length - 1, 1), STATUS_ROUNDS.length + 1).setNumberFormat('#,##0');
  sheet.getRange(rows.length, 1).setFontWeight('bold');
  sheet.getRange(warningTop, 1).setFontWeight('bold');
  // 포털 동기화는 사람이 시켜야 돈다. 오래되면 숫자가 낡았다는 것을 화면에서 바로 알게 한다.
  if (ageDays > STATUS_STALE_DAYS) sheet.getRange(2, 1, 1, 2).setBackground('#f4cccc');
  sheet.setColumnWidth(1, 300);
  sheet.setColumnWidths(2, STATUS_ROUNDS.length + 2, 110);
}
