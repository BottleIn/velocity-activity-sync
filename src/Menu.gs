/** 시트 메뉴와 시간 트리거. */

const TRIGGER_HANDLER = 'scheduledSync';
// 예전 버전이 설치한 트리거도 끄기·상태에서 같이 다룬다.
const TRIGGER_HANDLERS = [TRIGGER_HANDLER, 'syncNow'];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('활동비 동기화')
    .addItem('지금 동기화 (월별 탭까지)', 'menuSyncNow')
    .addSeparator()
    .addItem('자동 동기화 켜기 (1시간)', 'installTrigger')
    .addItem('자동 동기화 끄기', 'removeTrigger')
    .addItem('자동 동기화 상태', 'showTriggerStatus')
    .addSeparator()
    .addItem('설정...', 'showSetup')
    .addItem('Jira 필드 매핑 확인', 'showFieldMap')
    .addItem('연결 테스트', 'testConnection')
    .addToUi();
}

/** 메뉴 [지금 동기화]. jira_sync 갱신 후 월별 탭까지 반영하고 결과를 알려준다. */
function menuSyncNow() {
  const ui = SpreadsheetApp.getUi();
  try {
    const count = syncNow();
    const stats = applyAllMonths_();
    ui.alert('활동비 동기화', 'Jira ' + count + '건 동기화\n' + formatStats_(stats), ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('동기화 실패', String(err.message), ui.ButtonSet.OK);
  }
}

function formatStats_(stats) {
  const lines = stats
    .filter(function (s) { return s.error || s.added || s.updated || s.cleared; })
    .map(function (s) {
      if (s.error) return s.tab + ': ❌ ' + s.error;
      return s.tab + ': 신규 ' + s.added + ' · 갱신 ' + s.updated + ' · 제거 ' + s.cleared;
    });
  return lines.length ? lines.join('\n') : '월별 탭에 반영할 변경이 없습니다.';
}

function installTrigger() {
  removeTrigger();
  ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyHours(1).create();
  SpreadsheetApp.getActiveSpreadsheet().toast('1시간마다 자동 동기화합니다. (월별 탭 포함)', '활동비 동기화', 5);
}

function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (TRIGGER_HANDLERS.indexOf(trigger.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(trigger);
  });
}

function showTriggerStatus() {
  const active = ScriptApp.getProjectTriggers().filter(function (t) {
    return TRIGGER_HANDLERS.indexOf(t.getHandlerFunction()) !== -1;
  });
  const ui = SpreadsheetApp.getUi();
  ui.alert(
    '자동 동기화 상태',
    active.length ? '켜짐 — 1시간 간격 트리거 ' + active.length + '개' : '꺼짐 — 수동 동기화만 동작합니다.',
    ui.ButtonSet.OK
  );
}
