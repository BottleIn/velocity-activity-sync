/**
 * 포털 스냅숏으로 Jira 활동비 티켓을 맞추는 단계다. 기본은 미리보기이고 --apply일 때만 쓴다.
 * 쓰고 나면 운영 에픽의 엔티티 속성에 실행 기록과 돈 요약을 남긴다. 시트 현황 탭이 이 기록을 읽는다.
 */
import { formatWon, stripControlCharacters } from './format.js';
import { applyPlan, createJiraClient, fetchActivityIssues, readCredentials, writeRunRecord } from './jira.js';
import { FIELD, planJiraOps } from './jira-plan.js';
import { UserError } from './errors.js';
import { itemRoundMatrix, summarizeMoney } from './money.js';
import { roundsOf } from './config.js';

// 증빙에 원화가 없어 포털로는 모르는 결제는 사람이 Jira 실제 결제액에 채운 값을 쓴다.
// 그래야 시트 현황이 사람이 채운 금액까지 넣은 숫자를 보여 준다.
export function withJiraAmounts(snapshot, issues, links = {}) {
  const actualByKey = new Map();
  for (const issue of issues) {
    const portalKey = issue.portalKey ?? links[issue.key];
    if (portalKey && typeof issue.values.actual === 'number') actualByKey.set(portalKey, issue.values.actual);
  }
  let filled = 0;
  const applications = snapshot.applications.map((application) => ({
    ...application,
    payments: application.payments.map((payment) => {
      if (payment.krw !== null || !actualByKey.has(payment.key)) return payment;
      filled += 1;
      return { ...payment, krw: actualByKey.get(payment.key), fromJira: true };
    }),
  }));
  return { snapshot: { ...snapshot, applications }, filled };
}

// 포털 보고서는 Jira를 읽기 전에 찍혀서 사람이 Jira에 채운 금액이 빠져 있다. 시트 현황 탭과 같은 숫자를 여기서 다시 보여 준다.
export function formatJiraMoney(money, filled) {
  if (filled === 0) return '';
  return [
    '',
    `Jira에 적은 금액 ${filled}건을 넣은 금액 (시트 현황 탭과 같은 숫자)`,
    `지출       ${formatWon(money.spent)}`,
    `사용 가능  ${formatWon(money.available)}`,
    '',
  ].join('\n');
}

function show(name, value) {
  if (value === null || value === undefined || value === '') return '(빈 칸)';
  return typeof value === 'number' && name !== 'month' ? formatWon(value) : String(value);
}

export function formatPlan(plan) {
  const lines = ['', 'Jira 활동비 티켓'];
  if (plan.creates.length + plan.updates.length + plan.properties.length === 0) lines.push('바꿀 것이 없습니다.');
  for (const ticket of plan.creates) {
    const amount = ticket.owned.actual === undefined || ticket.owned.actual === null ? '' : `, 실제 결제액 ${formatWon(ticket.owned.actual)}`;
    lines.push(`- 새로 만듦 [${ticket.portalKey}] ${ticket.createOnly.summary} (${ticket.status}${amount})`);
  }
  for (const update of plan.updates) {
    const changes = update.changes.map(({ name, from, to }) => `${FIELD[name]} ${show(name, from)} → ${show(name, to)}`);
    lines.push(`- ${update.key} [${update.portalKey}] ${changes.join(', ')}`);
  }
  for (const { key, portalKey } of plan.properties) lines.push(`- ${key}에 포털 키 ${portalKey}를 적음`);
  for (const warning of plan.warnings) lines.push(`! ${warning}`);
  for (const problem of plan.problems) lines.push(`멈춤: ${problem}`);
  return stripControlCharacters(`${lines.join('\n')}\n`);
}

export async function runJira({ config, snapshot, apply, firstRun, now = () => new Date(), deps = {} }) {
  const jira = config.jira;
  const credentials = deps.credentials ?? readCredentials(jira.site);
  const request = deps.request ?? createJiraClient({ site: jira.site, credentials });
  const issues = await fetchActivityIssues(request, jira);
  // 금액을 모르는 결제는 사람이 Jira에 적은 값으로 채운 뒤 계획을 세운다. 이미 Jira에 있는 값이라 실제 결제액은
  // 바뀌지 않고, 달별 결제 티켓의 신청금액이 그 값으로 채워진다.
  const merged = withJiraAmounts(snapshot, issues, jira.links);
  const plan = planJiraOps({ snapshot: merged.snapshot, issues, links: jira.links, firstRun });
  const money = summarizeMoney(merged.snapshot, { limit: config.limit });
  const text = `${formatJiraMoney(money, merged.filled)}${formatPlan(plan)}`;
  if (!apply) return { text: `${text}\n미리보기입니다. 적용하려면 --apply를 붙여 다시 실행하세요.\n`, plan, created: [] };
  if (plan.problems.length > 0) throw new UserError(`${text}\nJira에 쓰지 않고 멈췄습니다.`);
  const created = await applyPlan(request, { jira, plan, baseUrl: config.baseUrl });
  await writeRunRecord(request, jira, {
    at: now().toISOString(),
    result: 'ok',
    created: created.length,
    updated: plan.updates.length,
    filledFromJira: merged.filled,
    money,
    matrix: itemRoundMatrix(merged.snapshot, { rounds: roundsOf(config.monthToRound) }),
    warnings: [...plan.warnings, ...snapshot.warnings.map((warning) => warning.message)],
  });
  const made = created.map(({ key, portalKey }) => `${key}(${portalKey})`).join(', ');
  return { text: `${text}\n적용했습니다.${made ? ` 새 티켓: ${made}` : ''}\n`, plan, created };
}
