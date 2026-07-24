/**
 * jira_sync → 월별 탭(07월~12월) 반영.
 *
 * 월별 탭은 표·드롭다운·KPI·순지출액 수식이 깔린 팀 공유 화면이라 전량 재작성하지
 * 않고, 티켓 링크(신청서 URL 열)를 키로 행 단위 upsert 만 한다.
 * - Jira 가 관리하는 열만 쓴다: 품목~실제 결제액(B~I), 결제 방식~신청서 URL(K~O).
 * - No.(A)·순지출액(J)·증빙 URL·비고는 시트 수식/수기 영역이라 건드리지 않는다.
 * - 티켓 링크가 없는 행은 수기 행으로 보고 절대 건드리지 않는다.
 * - 이 달 배정이 풀린 티켓의 행은 내용을 비워 거울을 유지한다.
 */

const MONTH_TAB_YEAR = '2026';    // 탭 이름(07월)에 연도가 없어 고정한다.
const MONTH_TAB_DATA_START = 7;   // 6행이 표 머리글, 7행부터 데이터.
const ITEM_COL = 2;               // B열 품목·서비스 — 수기 행 판별용.
const LINK_COL = 15;              // O열 신청서 URL — 티켓 링크를 upsert 키로 쓴다.

/** 시간 트리거 진입점. jira_sync 갱신 후 월별 탭까지 반영한다. (트리거에선 UI 금지) */
function scheduledSync() {
  syncNow();
  applyAllMonths_();
}

/**
 * 'NN월' 이름의 모든 탭에 해당 월 배정분을 반영한다.
 * @return {Object[]} 탭별 {tab, added, updated, cleared}
 */
function applyAllMonths_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rows = syncRows_();
  const stats = [];

  ss.getSheets().forEach(function (tab) {
    const name = tab.getName();
    if (/^\d+월\(자동\)$/.test(name)) {
      ss.deleteSheet(tab); // 예전 미리보기 방식의 탭은 치운다.
      return;
    }
    const m = name.match(/^(0[1-9]|1[0-2])월$/);
    if (!m) return;
    // 탭 하나가 실패해도 나머지는 계속 반영하고, 실패 원인은 알림으로 올린다.
    try {
      stats.push(applyMonth_(tab, MONTH_TAB_YEAR + '-' + m[1], rows));
    } catch (err) {
      stats.push({ tab: name, error: err.message });
    }
  });
  return stats;
}

/** 한 달치 upsert. */
function applyMonth_(tab, month, rows) {
  const idx = columnIndex_();
  const height = Math.max(tab.getLastRow() - MONTH_TAB_DATA_START + 1, 0);
  const links = height ? tab.getRange(MONTH_TAB_DATA_START, LINK_COL, height, 1).getValues() : [];
  const items = height ? tab.getRange(MONTH_TAB_DATA_START, ITEM_COL, height, 1).getValues() : [];

  // 이미 이 탭에 있는 티켓 → 행 번호
  const rowByKey = {};
  links.forEach(function (v, i) {
    const m = String(v[0]).match(/\/browse\/([A-Z][A-Z0-9]*-\d+)/);
    if (m) rowByKey[m[1]] = MONTH_TAB_DATA_START + i;
  });

  const state = { items: items, links: links, cursor: 0, appended: 0 };
  const current = {};
  let added = 0;
  let updated = 0;

  rows.forEach(function (r) {
    if (r[idx['배정월']] !== month) return;
    const key = r[idx['이슈키']];
    current[key] = true;
    let rowIndex = rowByKey[key];
    if (rowIndex) {
      updated++;
    } else {
      rowIndex = takeEmptyRow_(state);
      added++;
    }
    writeMonthRow_(tab, rowIndex, r, idx);
  });

  // 배정이 풀린 티켓(월 이동·삭제·취소 아님 주의: 취소는 상태만 바뀌고 남는다)의 행 정리
  let cleared = 0;
  Object.keys(rowByKey).forEach(function (key) {
    if (current[key]) return;
    const rowIndex = rowByKey[key];
    tab.getRange(rowIndex, ITEM_COL, 1, 8).clearContent();
    tab.getRange(rowIndex, 11, 1, 5).clearContent();
    cleared++;
  });

  return { tab: tab.getName(), added: added, updated: updated, cleared: cleared };
}

/** 수기 내용도 티켓 링크도 없는 첫 행을 찾고, 없으면 표 아래에 이어 붙인다. */
function takeEmptyRow_(state) {
  while (state.cursor < state.items.length) {
    const i = state.cursor++;
    if (!state.items[i][0] && !state.links[i][0]) return MONTH_TAB_DATA_START + i;
  }
  return MONTH_TAB_DATA_START + state.items.length + state.appended++;
}

/** Jira 가 관리하는 열만 써 넣는다. J(순지출액)를 사이에 두고 두 구간으로 나눠 쓴다. */
function writeMonthRow_(tab, rowIndex, r, idx) {
  tab.getRange(rowIndex, ITEM_COL, 1, 8).setValues([[
    r[idx['품목·서비스']], r[idx['지원 항목']], r[idx['신청일']], r[idx['활동비 상태']],
    r[idx['승인일']], r[idx['결제일']], r[idx['신청금액']], r[idx['실제 결제액']],
  ]]);
  tab.getRange(rowIndex, 11, 1, 5).setValues([[
    r[idx['결제 방식']], r[idx['담당자']], r[idx['증빙 기한']], r[idx['증빙 상태']], r[idx['티켓 링크']],
  ]]);

  // 서식은 한 셀씩만 손댄다. 표(Table) 안에서 여러 열에 걸친 서식 변경은
  // "열 수준 작업을 수행하려면 단일 열에서 선택하세요" 오류로 거부된다.
  // 표가 열 서식을 자체 관리해 거부하는 경우도 있으므로, 서식 실패는 무시하고
  // 값 입력은 계속한다 (서식은 표시 문제일 뿐 값은 이미 정확하다).
  [
    [4, 'yyyy-mm-dd'],  // 신청일
    [6, 'yyyy-mm-dd'],  // 승인일
    [7, 'yyyy-mm-dd'],  // 결제일
    [8, '#,##0'],       // 신청금액
    [9, '#,##0'],       // 실제 결제액
    [13, 'yyyy-mm-dd'], // 증빙 기한
  ].forEach(function (f) {
    try {
      tab.getRange(rowIndex, f[0]).setNumberFormat(f[1]);
    } catch (e) {
      // 표가 관리하는 열 — 표의 열 서식을 그대로 따른다.
    }
  });

  // 드롭다운·날짜 선택 살리기: 검증 규칙이 없는 행(표 경계 밖이거나 규칙이 지워진 행)에
  // 쓴 값은 일반 텍스트가 되어 드롭다운으로 바꿀 수 없다. 같은 열에서 규칙이 살아 있는
  // 셀을 찾아 검증만 복사한다. (값·서식은 건드리지 않는다)
  [3, 4, 5, 6, 7, 11, 13, 14].forEach(function (col) {
    ensureValidation_(tab, rowIndex, col);
  });
}

/** rowIndex 셀에 데이터 검증이 없으면 같은 열의 다른 셀에서 복사해 온다. */
function ensureValidation_(tab, rowIndex, col) {
  const cell = tab.getRange(rowIndex, col);
  if (cell.getDataValidation()) return;

  const last = Math.min(Math.max(tab.getLastRow(), rowIndex) + 20, tab.getMaxRows());
  for (let r = MONTH_TAB_DATA_START; r <= last; r++) {
    if (r === rowIndex) continue;
    const donor = tab.getRange(r, col);
    if (donor.getDataValidation()) {
      donor.copyTo(cell, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
      return;
    }
  }
}

/** jira_sync 의 데이터 행 전체. */
function syncRows_() {
  const sheet = getSyncSheet_();
  const count = sheet.getLastRow() - HEADER_ROW;
  if (count < 1) return [];
  return sheet.getRange(HEADER_ROW + 1, 1, count, COLUMNS.length).getValues()
    .filter(function (r) { return r[0]; });
}

/** COLUMNS 헤더 → 배열 인덱스. 열 순서가 바뀌어도 깨지지 않게 한다. */
function columnIndex_() {
  const idx = {};
  COLUMNS.forEach(function (col, i) { idx[col.header] = i; });
  return idx;
}
