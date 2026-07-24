/**
 * Jira Cloud REST API v3 클라이언트.
 *
 * 검색은 /rest/api/3/search/jql 을 쓴다. 구 /rest/api/3/search 는 완전히 제거되어
 * 410 Gone 을 반환하며, 새 엔드포인트는 startAt 대신 nextPageToken 으로 페이징하고
 * fields 를 명시하지 않으면 필드를 돌려주지 않는다.
 */

function jiraBaseUrl_() {
  return 'https://' + prop_(PROP.SITE, true) + '/rest/api/3';
}

function jiraAuthHeader_() {
  const email = prop_(PROP.EMAIL, true);
  const token = prop_(PROP.TOKEN, true);
  return 'Basic ' + Utilities.base64Encode(email + ':' + token);
}

/**
 * Jira API 호출. 2xx 가 아니면 본문을 붙여 에러를 던진다.
 * @param {string} path  /field, /search/jql 처럼 v3 이후 경로
 * @param {Object=} options  {method, payload}
 */
function jiraFetch_(path, options) {
  options = options || {};
  const params = {
    method: options.method || 'get',
    headers: {
      Authorization: jiraAuthHeader_(),
      Accept: 'application/json',
    },
    muteHttpExceptions: true,
  };
  if (options.payload) {
    params.contentType = 'application/json';
    params.payload = JSON.stringify(options.payload);
  }

  const response = UrlFetchApp.fetch(jiraBaseUrl_() + path, params);
  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code < 200 || code >= 300) {
    let hint = '';
    if (code === 401) hint = ' (이메일 또는 API 토큰이 잘못됐거나 토큰이 만료됐습니다)';
    if (code === 403) hint = ' (해당 계정에 조회 권한이 없습니다)';
    if (code === 410) hint = ' (제거된 엔드포인트입니다)';
    throw new Error('Jira API ' + code + hint + ' — ' + path + '\n' + body.slice(0, 500));
  }
  return JSON.parse(body);
}

/**
 * JQL 검색. nextPageToken 이 사라질 때까지 모든 페이지를 모은다.
 * @param {string} jql
 * @param {string[]} fields  요청할 필드 ID 목록
 * @return {Object[]} 이슈 배열
 */
function jiraSearch_(jql, fields) {
  const issues = [];
  let nextPageToken = null;
  let guard = 0;

  do {
    const payload = { jql: jql, fields: fields, maxResults: 100 };
    if (nextPageToken) payload.nextPageToken = nextPageToken;

    const page = jiraFetch_('/search/jql', { method: 'post', payload: payload });
    (page.issues || []).forEach(function (issue) { issues.push(issue); });
    nextPageToken = page.nextPageToken || null;

    if (++guard > 50) throw new Error('페이지네이션이 50회를 넘었습니다. JQL 을 확인하세요.');
  } while (nextPageToken);

  return issues;
}

/**
 * 동기화 대상 JQL.
 *
 * 활동비 전용 이슈 유형으로 잡는다. 에픽(parent) 기준이 아니라 유형 기준이라
 * 에픽에 붙이는 걸 깜빡한 티켓도 누락되지 않는다.
 * 특수한 조건이 필요하면 Script Property JQL_OVERRIDE 에 전체 JQL 을 넣어 덮어쓴다.
 */
function buildJql_() {
  const override = prop_(PROP.JQL, false);
  if (override) return override;

  return 'project = ' + prop_(PROP.PROJECT, true) +
         ' AND issuetype = "' + prop_(PROP.ISSUE_TYPE, true) + '"' +
         ' ORDER BY created ASC';
}

/** 활동비 항목 티켓 전체를 조회한다. */
function fetchActivityIssues_() {
  const fieldMap = getFieldMap_();
  const fieldIds = ['summary', 'assignee'];

  COLUMNS.forEach(function (col) {
    if (col.source !== 'custom') return;
    const id = fieldMap[col.jiraField];
    if (id) fieldIds.push(id);
  });

  return jiraSearch_(buildJql_(), fieldIds);
}
