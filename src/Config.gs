/**
 * 설정 · 열 정의.
 *
 * Jira 커스텀 필드는 ID(customfield_NNNNN)가 아니라 **필드 이름**으로 참조한다.
 * 실제 ID는 FieldMap.gs 가 /rest/api/3/field 로 조회해 캐시하므로,
 * Jira 에서 필드를 만든 뒤 이 파일을 고칠 필요가 없다.
 */

const SYNC_SHEET_NAME = 'jira_sync';

/** 데이터 헤더가 놓이는 행. 1행은 마지막 동기화 상태 줄로 쓴다. */
const HEADER_ROW = 2;

/** Script Properties 키. 값은 Setup.gs 의 설정 마법사로 저장한다. */
const PROP = {
  SITE: 'JIRA_SITE',
  EMAIL: 'JIRA_EMAIL',
  TOKEN: 'JIRA_API_TOKEN',
  PROJECT: 'PROJECT_KEY',
  ISSUE_TYPE: 'ISSUE_TYPE',
  JQL: 'JQL_OVERRIDE',
  FIELD_MAP: 'FIELD_MAP_CACHE',
};

/** Script Properties 가 비었을 때 쓰는 기본값. */
const DEFAULTS = {
  [PROP.SITE]: 'soma28.atlassian.net',
  [PROP.PROJECT]: 'VEL',
  [PROP.ISSUE_TYPE]: '활동비',
};

/**
 * jira_sync 탭의 열 정의. 배열 순서가 곧 시트의 열 순서다.
 *
 * source
 *   key       - 이슈 키 (VEL-165)
 *   summary   - 요약
 *   assignee  - 담당자 표시 이름
 *   browseUrl - 티켓 링크
 *   month     - 배정월 텍스트 ('2026-07'). 결제일의 월, 결제 전이면 신청일의 월.
 *               월별 탭 QUERY 가 날짜 타입에 기대지 않고 문자열 비교로 거를 수 있게 한다.
 *   custom    - 커스텀 필드. jiraField 에 Jira 에 만든 필드 이름을 그대로 적는다.
 *
 * type (source === 'custom' 일 때만)
 *   option | date | number | text
 *
 * 신청서·증빙 URL 열은 두지 않는다. 증빙 자료는 Jira 티켓의 첨부 파일이 이미 원본이라
 * URL 을 손으로 또 적으면 둘이 어긋난다. 필요해지면 첨부 목록을 읽어 자동으로 채운다.
 */
const COLUMNS = [
  { header: '이슈키', source: 'key' },
  { header: '품목·서비스', source: 'summary' },
  { header: '지원 항목', source: 'custom', jiraField: '지원 항목', type: 'option' },
  { header: '활동비 상태', source: 'custom', jiraField: '활동비 상태', type: 'option' },
  { header: '신청일', source: 'custom', jiraField: '신청일', type: 'date' },
  { header: '승인일', source: 'custom', jiraField: '승인일', type: 'date' },
  { header: '결제일', source: 'custom', jiraField: '결제일', type: 'date' },
  { header: '신청금액', source: 'custom', jiraField: '신청금액', type: 'number' },
  { header: '실제 결제액', source: 'custom', jiraField: '실제 결제액', type: 'number' },
  { header: '결제 방식', source: 'custom', jiraField: '결제 방식', type: 'option' },
  { header: '담당자', source: 'assignee' },
  { header: '증빙 기한', source: 'custom', jiraField: '증빙 기한', type: 'date' },
  { header: '증빙 상태', source: 'custom', jiraField: '증빙 상태', type: 'option' },
  { header: '티켓 링크', source: 'browseUrl' },
  { header: '배정월', source: 'month' },
];

/** 시트가 참조하는 커스텀 필드 이름 목록. */
/** portal/lib/jira-plan.js의 SHEET_EXCLUDED_LABEL과 같은 값이어야 한다. */
const SHEET_EXCLUDED_LABEL = '시트제외';

function customFieldNames_() {
  return COLUMNS.filter(function (c) { return c.source === 'custom'; })
                .map(function (c) { return c.jiraField; });
}

/** Script Property 를 읽고, 없으면 기본값·에러로 처리한다. */
function prop_(key, required) {
  const value = PropertiesService.getScriptProperties().getProperty(key) || DEFAULTS[key] || '';
  if (!value && required) {
    throw new Error(
      '설정이 비어 있습니다: ' + key + '\n' +
      '시트 메뉴 [활동비 동기화 > 설정...] 에서 Jira 계정과 API 토큰을 먼저 등록하세요.'
    );
  }
  return value;
}
