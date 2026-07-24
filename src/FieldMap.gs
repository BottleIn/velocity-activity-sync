/**
 * Jira 필드 이름 → customfield_NNNNN ID 해석.
 *
 * Jira 에서 커스텀 필드를 만들면 ID 가 자동 부여되는데, 이걸 손으로 옮겨 적으면
 * 필드를 다시 만들 때마다 코드가 틀어진다. 이름으로 조회해 캐시한다.
 */

/**
 * 이름 → 필드 ID 매핑을 돌려준다. 캐시가 없거나 낡았으면 Jira 에서 받아온다.
 *
 * 캐시에 없는 필드는 조회 대상에서 빠져 해당 열이 조용히 비는데, Jira 에 필드를
 * 만들고 [필드 매핑 확인] 을 누르는 걸 잊기 쉽다. 빠진 이름이 하나라도 있으면
 * 스스로 다시 받아 그 함정을 없앤다.
 * @return {Object<string,string>}
 */
function getFieldMap_() {
  const cached = PropertiesService.getScriptProperties().getProperty(PROP.FIELD_MAP);
  if (cached) {
    try {
      const map = JSON.parse(cached);
      const complete = customFieldNames_().every(function (name) { return map[name]; });
      if (complete) return map;
    } catch (e) {
      // 캐시가 깨졌으면 새로 받는다.
    }
  }
  return refreshFieldMap();
}

/**
 * Jira 에서 필드 목록을 다시 받아 캐시한다.
 * 커스텀 필드를 새로 만들거나 이름을 바꾼 뒤 실행한다.
 * @return {Object<string,string>}
 */
function refreshFieldMap() {
  const fields = jiraFetch_('/field');
  const wanted = customFieldNames_();
  const map = {};

  fields.forEach(function (field) {
    if (!field.custom) return;
    if (wanted.indexOf(field.name) === -1) return;
    // 같은 이름의 필드가 여럿이면 먼저 만난 것을 쓰고 경고를 남긴다.
    if (map[field.name]) {
      console.warn('이름이 같은 커스텀 필드가 둘 이상입니다: ' + field.name +
                   ' (' + map[field.name] + ', ' + field.id + ')');
      return;
    }
    map[field.name] = field.id;
  });

  PropertiesService.getScriptProperties().setProperty(PROP.FIELD_MAP, JSON.stringify(map));

  const missing = wanted.filter(function (name) { return !map[name]; });
  if (missing.length) {
    console.warn('Jira 에서 찾지 못한 필드 (해당 열은 비워둡니다): ' + missing.join(', '));
  }
  return map;
}

/** 현재 매핑 상태를 시트 UI 로 보여준다. 필드 생성 후 확인용. */
function showFieldMap() {
  const map = refreshFieldMap();
  const lines = customFieldNames_().map(function (name) {
    return (map[name] ? '  ✅ ' : '  ❌ ') + name + (map[name] ? '  →  ' + map[name] : '  →  Jira 에 없음');
  });
  SpreadsheetApp.getUi().alert(
    'Jira 커스텀 필드 매핑',
    lines.join('\n') + '\n\n❌ 항목은 Jira 프로젝트 설정에서 같은 이름으로 만든 뒤 다시 확인하세요.',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}
