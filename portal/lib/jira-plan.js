/**
 * 포털 스냅숏과 Jira 활동비 티켓을 비교해 만들 티켓과 고칠 칸을 정한다. 순수 함수만 둔다.
 *
 * 포털 신청과 티켓은 티켓의 엔티티 속성(PROPERTY_KEY)에 적은 포털 키로 짝짓는다. 엔티티 속성은 화면에
 * 보이지 않고 Jira 설정을 바꾸지 않아도 쓸 수 있어서, 포털 키 칸을 새로 만들지 않기로 했다.
 * 신청 티켓의 포털 키는 신청 번호(`9288`), 여러 달 신청의 달별 집행 티켓은 번호와 차수(`9288-3차`)다.
 *
 * 칸마다 주인이 있다. 포털이 주인인 칸(신청금액, 지원 항목, 증빙 상태, 실제 결제액)은 포털과 다르면 고친다.
 * 나머지 칸은 만들 때 채우고 그 뒤에는 비어 있을 때만 채워서, 사람이 고친 값을 되돌리지 않는다.
 * 실제 결제액은 증빙에서 원화를 읽었을 때만 고친다. 모르는 금액으로 사람이 채운 값을 지우지 않으려는 것이다.
 */
export const PROPERTY_KEY = 'velocity.portal';
export const MAX_CREATES = 5;
// 여러 달 신청의 신청금액은 몇 달 치를 어림해 적은 값이라 실제 지출이 아니다. 실제 금액은 달별 집행 티켓에 있으므로
// 신청 티켓에는 이 라벨을 달아 시트가 가져가지 않게 한다. 라벨은 Jira 설정을 바꾸지 않고 붙일 수 있다.
export const SHEET_EXCLUDED_LABEL = '시트제외';

export const FIELD = Object.freeze({
  actual: '실제 결제액',
  requested: '신청금액',
  paidDate: '결제일',
  status: '활동비 상태',
  item: '지원 항목',
  method: '결제 방식',
  appliedDate: '신청일',
  evidence: '증빙 상태',
});

// 포털 구분 이름이 Jira 지원 항목과 다른 것만 적는다. 디자인 제작비는 팀이 전문가 활용비로 처리한다.
const ITEM_MAP = Object.freeze({
  기타: '기타 사용료',
  '클라우드 서비스': '클라우드 서비스 이용료',
  '디자인 제작비': '전문가 활용비',
});
const JIRA_ITEMS = new Set([
  '클라우드 서비스 이용료',
  '재료 구매비',
  '기자재 임대비',
  'AI·SW 서비스 이용료',
  '전문가 활용비',
  '마케팅비',
  '기타 사용료',
]);
// 활동비 상태는 이 순서로 앞으로만 옮긴다. 취소나 이 목록에 없는 값은 사람이 정한 것이라 건드리지 않는다.
const STATUS_ORDER = ['신청 예정', '승인 대기', '승인 완료', '결제 완료'];

export function jiraItemOf(category) {
  const item = ITEM_MAP[category] ?? category;
  return JIRA_ITEMS.has(item) ? item : null;
}

export function paymentMethodOf(text) {
  const compact = String(text ?? '').replace(/\s/g, '');
  if (compact === '카드결제') return '사무국 카드';
  if (compact === '사후정산' || compact === '사후청산') return '개인 카드 정산';
  return '기타/확인 필요';
}

function itemNames(application) {
  const names = [...new Set(application.items.map((item) => item.name).filter(Boolean))];
  return names.length > 0 ? names.join(', ') : application.title;
}

function applicationStatus(application) {
  if (application.status !== '승인') return '승인 대기';
  const paidOnce = application.kind === 'once' && application.evidenceStatus === '증빙완료';
  return paidOnce ? '결제 완료' : '승인 완료';
}

function evidenceStatusOf(application) {
  if (application.kind === 'monthly') return application.payments.length > 0 ? '일부 제출' : '미제출';
  return application.evidenceStatus === '증빙완료' ? '제출 완료' : '미제출';
}

// 한 번 결제 신청의 실제 결제액. 여러 달 신청 티켓은 금액을 집행 티켓에 두므로 비운다(null).
// 금액을 모르면 undefined를 돌려 칸을 건드리지 않는다.
function applicationActual(application) {
  if (application.kind === 'monthly') return null;
  const payment = application.payments[0];
  return payment && payment.krw !== null ? payment.krw : undefined;
}

function applicationTicket(application, item) {
  const name = itemNames(application);
  return {
    portalKey: application.foundId,
    foundId: application.foundId,
    author: application.author,
    owned: {
      requested: application.approvedKrw,
      item,
      evidence: evidenceStatusOf(application),
      actual: applicationActual(application),
    },
    status: applicationStatus(application),
    labels: application.kind === 'monthly' ? [SHEET_EXCLUDED_LABEL] : [],
    createOnly: {
      summary: `${item}: ${name}`,
      method: paymentMethodOf(application.items[0]?.payment),
      appliedDate: application.date,
      paidDate: application.kind === 'once' && application.evidenceStatus === '증빙완료' ? application.date : undefined,
    },
  };
}

function paymentTicket(application, item, payment) {
  const year = application.date.slice(0, 4);
  const amount = payment.krw === null ? undefined : payment.krw;
  return {
    portalKey: payment.key,
    foundId: application.foundId,
    author: application.author,
    // 달별 결제는 따로 신청한 금액이 없다. 신청금액을 비워 두면 시트의 항목별 신청금액 합계가 실제보다 작게 나와서
    // 그 달 결제액을 신청금액으로 둔다. 어림값인 전체 신청금액은 신청 티켓에만 있고, 그 티켓은 시트에서 뺀다.
    owned: { requested: amount, item, evidence: '제출 완료', actual: amount },
    status: '결제 완료',
    createOnly: {
      summary: `${item}: ${itemNames(application)} - ${payment.month}월`,
      method: paymentMethodOf(application.items[0]?.payment),
      appliedDate: application.date,
      // 증빙에는 결제자마다 결제일이 달라 하루를 정할 수 없다. 차수를 정하는 데는 달만 필요해서 1일로 둔다.
      paidDate: `${year}-${String(payment.month).padStart(2, '0')}-01`,
    },
  };
}

export function desiredTickets(snapshot) {
  const tickets = [];
  const warnings = [];
  for (const application of snapshot.applications) {
    // 증빙하기에 머문 신청은 팀이 안 쓸 수도 있어서 티켓을 만들지 않는다. 증빙완료가 되면 그때 만든다.
    if (application.kind === 'none' || application.evidenceStatus !== '증빙완료') continue;
    const item = jiraItemOf(application.category);
    if (item === null) {
      warnings.push(`신청 ${application.foundId}: 포털 구분 '${application.category}'에 맞는 Jira 지원 항목이 없어 티켓을 만들지 않았습니다.`);
      continue;
    }
    tickets.push(applicationTicket(application, item));
    if (application.kind !== 'monthly') continue;
    for (const payment of application.payments) {
      if (payment.key === null) {
        warnings.push(`신청 ${application.foundId}: ${payment.month}월 결제는 차수를 정하지 못해 티켓을 만들지 않았습니다.`);
        continue;
      }
      tickets.push(paymentTicket(application, item, payment));
    }
  }
  return { tickets, warnings };
}

function isEmpty(value) {
  return value === null || value === undefined || value === '';
}

function sameValue(current, desired) {
  if (isEmpty(current) && isEmpty(desired)) return true;
  if (typeof desired === 'number') return Number(current) === desired;
  return current === desired;
}

function ownedChanges(issue, ticket) {
  const changes = [];
  for (const [name, desired] of Object.entries(ticket.owned)) {
    if (desired === undefined) continue;
    const current = issue.values[name];
    if (!sameValue(current, desired)) changes.push({ name, from: current ?? null, to: desired });
  }
  return changes;
}

function statusChange(issue, ticket) {
  const current = issue.values.status;
  if (isEmpty(current)) return [{ name: 'status', from: null, to: ticket.status }];
  const from = STATUS_ORDER.indexOf(current);
  const to = STATUS_ORDER.indexOf(ticket.status);
  return from !== -1 && from < to ? [{ name: 'status', from: current, to: ticket.status }] : [];
}

function fillEmptyChanges(issue, ticket) {
  return ['method', 'appliedDate', 'paidDate']
    .filter((name) => ticket.createOnly[name] !== undefined && isEmpty(issue.values[name]))
    .map((name) => ({ name, from: null, to: ticket.createOnly[name] }));
}

function indexIssues(issues, links) {
  const byKey = new Map();
  const problems = [];
  for (const issue of issues) {
    const portalKey = issue.portalKey ?? links[issue.key] ?? null;
    if (portalKey === null) continue;
    if (byKey.has(portalKey)) {
      problems.push(`포털 키 ${portalKey}가 ${byKey.get(portalKey).key}와 ${issue.key} 두 티켓에 있습니다.`);
      continue;
    }
    byKey.set(portalKey, { ...issue, portalKey, needsProperty: issue.portalKey !== portalKey });
  }
  return { byKey, problems };
}

/**
 * @param {object} args
 * @param {object} args.snapshot buildSnapshot 결과
 * @param {Array} args.issues [{ key, portalKey, values: { 칸 이름: 값 } }] (values의 열쇠는 FIELD의 열쇠)
 * @param {object} args.links 엔티티 속성이 아직 없는 기존 티켓의 포털 키 { 'VEL-168': '9271' }
 * @param {boolean} args.firstRun 만들 티켓 수 제한을 푼다
 * @return {{ creates, updates, properties, warnings, problems }} problems가 있으면 쓰지 않고 멈춘다
 */
export function planJiraOps({ snapshot, issues, links = {}, firstRun = false }) {
  const { tickets, warnings } = desiredTickets(snapshot);
  const { byKey, problems } = indexIssues(issues, links);
  const creates = [];
  const updates = [];
  const properties = [];
  for (const ticket of tickets) {
    const issue = byKey.get(ticket.portalKey);
    if (issue === undefined) {
      creates.push(ticket);
      continue;
    }
    byKey.delete(ticket.portalKey);
    if (issue.needsProperty) properties.push({ key: issue.key, portalKey: ticket.portalKey });
    const changes = [...ownedChanges(issue, ticket), ...statusChange(issue, ticket), ...fillEmptyChanges(issue, ticket)];
    if (changes.length > 0) updates.push({ key: issue.key, portalKey: ticket.portalKey, changes });
  }
  for (const [portalKey, issue] of byKey) {
    warnings.push(`${issue.key}의 포털 키 ${portalKey}에 해당하는 포털 신청이나 증빙이 없습니다.`);
  }
  const linked = new Set(issues.filter((issue) => issue.portalKey ?? links[issue.key]).map((issue) => issue.key));
  for (const issue of issues.filter((candidate) => !linked.has(candidate.key))) {
    warnings.push(`${issue.key}에 포털 키가 없어 포털 신청과 짝짓지 못했습니다.`);
  }
  if (creates.length > MAX_CREATES && !firstRun) {
    problems.push(`새로 만들 티켓이 ${creates.length}건으로 ${MAX_CREATES}건을 넘습니다. 포털 키를 못 찾아 티켓이 두 벌 생기는 것일 수 있습니다. 맞다면 --first-run을 붙여 다시 실행하세요.`);
  }
  return { creates, updates, properties, warnings, problems };
}
