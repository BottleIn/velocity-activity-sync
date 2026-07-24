/**
 * Jira → jira_sync 탭 동기화.
 *
 * 원칙: 이 스크립트는 jira_sync 탭 **하나만** 건드린다.
 * 월별 탭·대시보드의 서식과 수식은 절대 손대지 않는다.
 *
 * 매번 전량 재작성하므로 티켓 수정·삭제·유형 변경이 그대로 반영된다.
 * Jira 조회가 실패하면 시트를 지우지 않고 1행에 오류만 남긴다.
 */

/** 메뉴·트리거의 진입점. */
function syncNow() {
  const started = new Date();
  let issues;

  try {
    issues = fetchActivityIssues_();
  } catch (err) {
    writeStatus_('❌ 동기화 실패 (' + formatStamp_(started) + ') — ' + err.message +
                 ' · 아래 데이터는 마지막 성공 시점의 값입니다.');
    throw err;
  }

  // 매핑과 사이트 주소는 한 번만 읽어 행마다 반복 조회하지 않는다.
  const context = { fieldMap: getFieldMap_(), site: prop_(PROP.SITE, true) };
  const rows = issues.map(function (issue) { return buildRow_(issue, context); });
  writeRows_(rows);
  writeStatus_('✅ 마지막 동기화 ' + formatStamp_(started) + ' · ' + rows.length + '건 · ' +
               'JQL: ' + buildJql_() + ' · ' +
               '이 탭은 자동 생성되므로 직접 수정하면 다음 동기화에 사라집니다.');

  return rows.length;
}

/**
 * 이슈 하나를 COLUMNS 순서의 배열로 바꾼다.
 * @param {Object} issue
 * @param {{fieldMap: Object<string,string>, site: string}} context
 */
function buildRow_(issue, context) {
  const fieldMap = context.fieldMap;
  const site = context.site;

  return COLUMNS.map(function (col) {
    switch (col.source) {
      case 'key':
        return issue.key;
      case 'summary':
        return issue.fields.summary || '';
      case 'assignee':
        return issue.fields.assignee ? issue.fields.assignee.displayName : '';
      case 'browseUrl':
        return 'https://' + site + '/browse/' + issue.key;
      case 'month': {
        // 결제일이 있으면 그 월, 결제 전이면 신청일의 월. 둘 다 없으면 미배정.
        const payId = fieldMap['결제일'];
        const reqId = fieldMap['신청일'];
        const raw = (payId && issue.fields[payId]) || (reqId && issue.fields[reqId]) || '';
        const m = String(raw).match(/^(\d{4})-(\d{2})/);
        return m ? m[1] + '-' + m[2] : '';
      }
      case 'custom': {
        const id = fieldMap[col.jiraField];
        if (!id) return ''; // Jira 에 아직 없는 필드
        return coerceValue_(issue.fields[id], col.type);
      }
      default:
        return '';
    }
  });
}

/** Jira 필드 값을 시트 셀 값으로 변환한다. */
function coerceValue_(raw, type) {
  if (raw === null || raw === undefined) return '';

  switch (type) {
    case 'option':
      if (Array.isArray(raw)) {
        return raw.map(function (o) { return o && o.value ? o.value : String(o); }).join(', ');
      }
      return raw.value || String(raw);

    case 'date':
      return parseJiraDate_(raw);

    case 'number': {
      const n = Number(raw);
      return isNaN(n) ? '' : n;
    }

    case 'url':
    case 'text':
    default:
      if (typeof raw === 'object') return adfToText_(raw);
      return String(raw);
  }
}

/**
 * Jira 날짜("2026-07-23")를 시트의 날짜 시리얼 넘버로 바꾼다.
 *
 * - Date 객체는 "시각"이라, 스크립트 시간대(Asia/Seoul)의 0시가 문서 시간대에
 *   따라 전날 오후로 표시돼 날짜가 하루 밀린다.
 * - 문자열은 setValues 가 타이핑처럼 해석해 로케일·서식에 따라 결과가 달라진다.
 * - 시리얼 넘버(1899-12-30 기준 일수)는 시간대와 무관한 순수 "날짜 값"이라
 *   어느 문서 시간대에서도 같은 날로 표시되고 날짜 연산도 된다.
 */
function parseJiraDate_(raw) {
  const match = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(raw);
  const daysSinceEpoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000;
  return daysSinceEpoch + 25569; // 1899-12-30 → 1970-01-01 이 25569일
}

/** 서술형 필드가 ADF 로 올 경우 평문만 뽑는다. */
function adfToText_(node) {
  if (!node || typeof node !== 'object') return String(node || '');
  if (node.type === 'text') return node.text || '';
  if (!Array.isArray(node.content)) return '';
  return node.content.map(adfToText_).join(node.type === 'doc' ? '\n' : '');
}

/** jira_sync 탭을 헤더부터 전량 재작성한다. */
function writeRows_(rows) {
  const sheet = getSyncSheet_();
  const headers = COLUMNS.map(function (c) { return c.header; });
  const width = headers.length;

  // 기존 데이터 영역만 비운다. 1행(상태 줄)은 건드리지 않는다.
  const lastRow = sheet.getMaxRows();
  if (lastRow >= HEADER_ROW) {
    sheet.getRange(HEADER_ROW, 1, lastRow - HEADER_ROW + 1, sheet.getMaxColumns()).clearContent();
  }

  const values = [headers].concat(rows.length ? rows : []);

  // 새 탭의 기본 행 수보다 항목이 많아지면 먼저 행을 늘린다.
  const needed = HEADER_ROW + values.length - 1;
  if (sheet.getMaxRows() < needed) {
    sheet.insertRowsAfter(sheet.getMaxRows(), needed - sheet.getMaxRows());
  }
  if (sheet.getMaxColumns() < width) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  }

  // 배정월처럼 문자열을 그대로 보존해야 하는 열은 쓰기 전에 서식을 일반 텍스트로
  // 고정한다. setValues 는 타이핑처럼 값을 해석해 '2026-07' 을 날짜로 바꿔 버려서,
  // 월별 탭의 문자열 비교(where O = '2026-07')가 조용히 실패한다.
  COLUMNS.forEach(function (col, index) {
    if (col.source !== 'month') return;
    sheet.getRange(HEADER_ROW, index + 1, values.length, 1).setNumberFormat('@');
  });

  sheet.getRange(HEADER_ROW, 1, values.length, width).setValues(values);

  // 날짜·금액 열 표시 형식. 값만 쓰면 숫자로 보여서 매번 지정한다.
  COLUMNS.forEach(function (col, index) {
    if (rows.length === 0) return;
    const range = sheet.getRange(HEADER_ROW + 1, index + 1, rows.length, 1);
    if (col.type === 'date') range.setNumberFormat('yyyy-mm-dd');
    if (col.type === 'number') range.setNumberFormat('#,##0');
  });
}

/** 1행 상태 줄. 열 전체를 병합하지 않고 A1 에만 쓴다. */
function writeStatus_(message) {
  getSyncSheet_().getRange(1, 1).setValue(message);
}

/** jira_sync 탭을 가져오고, 없으면 만든다. */
function getSyncSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SYNC_SHEET_NAME);
  if (sheet) return sheet;

  sheet = ss.insertSheet(SYNC_SHEET_NAME);
  sheet.setFrozenRows(HEADER_ROW);
  sheet.getRange(HEADER_ROW, 1, 1, COLUMNS.length).setFontWeight('bold');
  sheet.getRange(1, 1).setFontStyle('italic');
  return sheet;
}

function formatStamp_(date) {
  return Utilities.formatDate(date, 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
}
