/**
 * 설정 마법사와 점검 함수.
 *
 * API 토큰은 Script Properties 에만 저장한다. 코드 파일이나 git 에 절대 넣지 않는다.
 */

/** 메뉴 [설정...] — Jira 사이트·계정·토큰·동기화 대상을 입력받아 저장한다. */
function showSetup() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();

  const site = askValue_(ui, 'Jira 사이트', '예: soma28.atlassian.net', prop_(PROP.SITE, false));
  if (site === null) return;

  const email = askValue_(ui, 'Jira 계정 이메일', 'Atlassian 로그인 이메일', prop_(PROP.EMAIL, false));
  if (email === null) return;

  const tokenHint = prop_(PROP.TOKEN, false) ? '(저장된 토큰이 있습니다. 비워두면 유지)' : '';
  const token = askValue_(
    ui, 'Jira API 토큰',
    'id.atlassian.com/manage-profile/security/api-tokens 에서 발급 ' + tokenHint, ''
  );
  if (token === null) return;

  const project = askValue_(ui, '프로젝트 키', '예: VEL', prop_(PROP.PROJECT, false));
  if (project === null) return;

  const issueType = askValue_(
    ui, '활동비 이슈 유형 이름',
    'Jira 에 만든 전용 이슈 유형 이름을 그대로 (예: 활동비)', prop_(PROP.ISSUE_TYPE, false)
  );
  if (issueType === null) return;

  props.setProperty(PROP.SITE, site.trim());
  props.setProperty(PROP.EMAIL, email.trim());
  if (token.trim()) props.setProperty(PROP.TOKEN, token.trim());
  props.setProperty(PROP.PROJECT, project.trim().toUpperCase());
  props.setProperty(PROP.ISSUE_TYPE, issueType.trim());
  props.deleteProperty(PROP.FIELD_MAP); // 사이트가 바뀌었을 수 있으니 필드 캐시를 버린다.

  ui.alert('설정 저장 완료', '[연결 테스트] 로 확인해 보세요.', ui.ButtonSet.OK);
}

function askValue_(ui, title, help, current) {
  const response = ui.prompt(title, help + (current ? '\n현재 값: ' + current : ''), ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return null;
  const text = response.getResponseText();
  return text.trim() ? text : (current || '');
}

/** 인증·필드·조회가 모두 성립하는지 한 번에 확인한다. */
function testConnection() {
  const ui = SpreadsheetApp.getUi();
  const lines = [];

  try {
    const me = jiraFetch_('/myself');
    lines.push('✅ 인증 성공 — ' + me.displayName + ' (' + (me.emailAddress || '') + ')');
  } catch (err) {
    ui.alert('연결 테스트', '❌ 인증 실패\n' + err.message, ui.ButtonSet.OK);
    return;
  }

  const map = getFieldMap_();
  const missing = customFieldNames_().filter(function (name) { return !map[name]; });
  lines.push(missing.length
    ? '⚠️ 아직 없는 커스텀 필드 ' + missing.length + '개 — ' + missing.join(', ')
    : '✅ 커스텀 필드 ' + customFieldNames_().length + '개 모두 확인');

  try {
    const issues = fetchActivityIssues_();
    lines.push('✅ 티켓 ' + issues.length + '건 조회 — ' + buildJql_());
    if (issues.length) {
      lines.push('   예: ' + issues.slice(0, 3).map(function (i) {
        return i.key + ' ' + i.fields.summary;
      }).join(' / '));
    }
  } catch (err) {
    lines.push('❌ 티켓 조회 실패 — ' + err.message);
  }

  ui.alert('연결 테스트', lines.join('\n'), ui.ButtonSet.OK);
}

/** 편집기에서 직접 실행하는 점검용. 로그로 첫 티켓의 원본 필드를 보여준다. */
function testFetchOne() {
  const issues = fetchActivityIssues_();
  console.log('조회된 티켓: ' + issues.length + '건');
  issues.slice(0, 5).forEach(function (issue) {
    console.log(issue.key + ' — ' + issue.fields.summary);
  });
  if (issues.length) console.log(JSON.stringify(issues[0].fields, null, 2));
  return issues.length;
}
