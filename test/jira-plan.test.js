import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SHEET_EXCLUDED_LABEL, jiraItemOf, paymentMethodOf, planJiraOps } from '../portal/lib/jira-plan.js';
import { DONE_TRANSITION_ID, applyPlan, createFields, parseNetrc } from '../portal/lib/jira.js';
import { formatJiraMoney, formatPlan } from '../portal/lib/jira-sync.js';

function application(overrides = {}) {
  return {
    foundId: '1007',
    category: 'AI·SW 서비스 이용료',
    title: 'AI·SW 서비스 이용료(8/14)',
    author: '김철수',
    date: '2026-08-14',
    status: '승인',
    evidenceStatus: '증빙완료',
    requestedKrw: 30000,
    approvedKrw: 30000,
    items: [{ name: '가짜 호스팅 Pro', payment: '사후정산' }],
    kind: 'once',
    payments: [{ key: '1007', round: 2, month: 8, krw: 29500 }],
    ...overrides,
  };
}

const monthly = application({
  foundId: '1003',
  approvedKrw: 3000000,
  requestedKrw: 3000000,
  items: [{ name: '가짜 AI 구독', payment: '사후청산' }],
  date: '2026-07-16',
  kind: 'monthly',
  payments: [
    { key: '1003-1차', round: 1, month: 7, krw: null },
    { key: '1003-2차', round: 2, month: 8, krw: 900000 },
  ],
});

function issue(key, portalKey, values = {}) {
  return { key, portalKey, values };
}

describe('jiraItemOf and paymentMethodOf', () => {
  it('maps portal categories to the Jira options the team uses', () => {
    assert.equal(jiraItemOf('기타'), '기타 사용료');
    assert.equal(jiraItemOf('디자인 제작비'), '전문가 활용비');
    assert.equal(jiraItemOf('재료 구매비'), '재료 구매비');
    assert.equal(jiraItemOf(''), null);
  });

  it('maps the free-text payment method after removing spaces', () => {
    assert.equal(paymentMethodOf('카드 결제'), '사무국 카드');
    assert.equal(paymentMethodOf('사후청산'), '개인 카드 정산');
    assert.equal(paymentMethodOf('세금계산서'), '기타/확인 필요');
  });
});

describe('planJiraOps', () => {
  it('creates an application ticket and one ticket per paid month for a monthly application', () => {
    const plan = planJiraOps({ snapshot: { applications: [monthly] }, issues: [] });

    assert.deepEqual(plan.creates.map((ticket) => ticket.portalKey), ['1003', '1003-1차', '1003-2차']);
    assert.equal(plan.creates[0].owned.actual, null);
    assert.equal(plan.creates[1].owned.actual, undefined);
    assert.equal(plan.creates[2].owned.actual, 900000);
    // 달별 결제는 따로 신청한 금액이 없어서, 시트 집계가 맞도록 그 달 결제액을 신청금액으로 둔다.
    assert.equal(plan.creates[2].owned.requested, 900000);
    assert.equal(plan.creates[1].owned.requested, undefined);
    assert.equal(plan.creates[2].createOnly.summary, 'AI·SW 서비스 이용료: 가짜 AI 구독 - 8월');
    assert.equal(plan.creates[2].createOnly.paidDate, '2026-08-01');
  });

  it('fixes portal-owned fields on a linked ticket and records the missing property', () => {
    const existing = issue('VEL-9', null, {
      actual: 31000, requested: 31000, item: 'AI·SW 서비스 이용료', evidence: '제출 완료', status: null,
      method: '개인 카드 정산', appliedDate: '2026-08-14', paidDate: '2026-08-20',
    });

    const plan = planJiraOps({ snapshot: { applications: [application()] }, issues: [existing], links: { 'VEL-9': '1007' } });

    assert.deepEqual(plan.creates, []);
    assert.deepEqual(plan.properties, [{ key: 'VEL-9', portalKey: '1007' }]);
    assert.deepEqual(plan.updates[0].changes, [
      { name: 'requested', from: 31000, to: 30000 },
      { name: 'actual', from: 31000, to: 29500 },
      { name: 'status', from: null, to: '결제 완료' },
    ]);
  });

  it('leaves an amount a person filled in when the evidence amount is unknown', () => {
    const unknown = application({ payments: [{ key: '1007', round: 2, month: 8, krw: null }] });
    const existing = issue('VEL-9', '1007', {
      actual: 29999, requested: 30000, item: 'AI·SW 서비스 이용료', evidence: '제출 완료', status: '결제 완료',
      method: '개인 카드 정산', appliedDate: '2026-08-14', paidDate: '2026-08-14',
    });

    const plan = planJiraOps({ snapshot: { applications: [unknown] }, issues: [existing] });

    assert.deepEqual(plan.updates, []);
  });

  it('only moves the status forward and never touches a cancelled ticket', () => {
    const done = issue('VEL-8', '1003', { status: '결제 완료' });
    const cancelled = issue('VEL-8', '1003', { status: '취소' });

    const plans = [done, cancelled].map((existing) => planJiraOps({ snapshot: { applications: [monthly] }, issues: [existing] }));

    for (const plan of plans) {
      const statusChanges = plan.updates.flatMap((update) => update.changes).filter((change) => change.name === 'status');
      assert.deepEqual(statusChanges, []);
    }
  });

  it('makes no ticket for an application whose evidence is not complete, since the team may never spend it', () => {
    const pending = application({ foundId: '1009', evidenceStatus: '증빙하기', payments: [] });
    const pendingMonthly = { ...monthly, foundId: '1010', evidenceStatus: '증빙하기', payments: [] };

    const plan = planJiraOps({ snapshot: { applications: [pending, pendingMonthly] }, issues: [] });

    assert.deepEqual(plan.creates, []);
    assert.deepEqual(plan.warnings, []);
  });

  it('fills a person-owned field only when it is empty', () => {
    const existing = issue('VEL-9', '1007', {
      actual: 29500, requested: 30000, item: 'AI·SW 서비스 이용료', evidence: '제출 완료', status: '결제 완료',
      method: null, appliedDate: '2026-08-01', paidDate: '2026-08-20',
    });

    const plan = planJiraOps({ snapshot: { applications: [application()] }, issues: [existing] });

    assert.deepEqual(plan.updates[0].changes, [{ name: 'method', from: null, to: '개인 카드 정산' }]);
  });

  it('clears the amount on a monthly application ticket because each month has its own ticket', () => {
    const existing = issue('VEL-8', '1003', {
      actual: 880000, requested: 3000000, item: 'AI·SW 서비스 이용료', evidence: '일부 제출', status: '승인 완료',
      method: '개인 카드 정산', appliedDate: '2026-07-16',
    });

    const plan = planJiraOps({ snapshot: { applications: [monthly] }, issues: [existing] });

    assert.deepEqual(plan.updates[0].changes, [{ name: 'actual', from: 880000, to: null }]);
  });

  it('stops before creating more than five tickets unless it is the first run', () => {
    const many = Array.from({ length: 6 }, (_, index) => application({ foundId: String(2000 + index), payments: [] }));

    const blocked = planJiraOps({ snapshot: { applications: many }, issues: [] });
    const allowed = planJiraOps({ snapshot: { applications: many }, issues: [], firstRun: true });

    assert.equal(blocked.problems.length, 1);
    assert.deepEqual(allowed.problems, []);
  });

  it('stops when two tickets claim the same portal key', () => {
    const plan = planJiraOps({ snapshot: { applications: [application()] }, issues: [issue('VEL-1', '1007'), issue('VEL-2', '1007')] });

    assert.match(plan.problems[0], /VEL-1와 VEL-2/);
  });

  it('warns about tickets without a portal key and skips categories Jira does not have', () => {
    const plan = planJiraOps({
      snapshot: { applications: [application({ category: '', foundId: '1008' })] },
      issues: [issue('VEL-5', null)],
    });

    assert.deepEqual(plan.creates, []);
    assert.equal(plan.warnings.length, 2);
  });

  it('prints the plan with won amounts', () => {
    const plan = planJiraOps({ snapshot: { applications: [application()] }, issues: [] });

    assert.match(formatPlan(plan), /새로 만듦 \[1007\] AI·SW 서비스 이용료: 가짜 호스팅 Pro \(결제 완료, 실제 결제액 29,500원\)/);
  });
});

describe('parseNetrc', () => {
  it('finds the login and password of one machine', () => {
    const text = 'machine other.example login a password b\nmachine jira.example.test\n  login me@example.test\n  password fake-token\n';

    assert.deepEqual(parseNetrc(text, 'jira.example.test'), { login: 'me@example.test', password: 'fake-token' });
    assert.equal(parseNetrc(text, 'missing.example'), null);
  });
});

describe('withJiraAmounts', () => {
  it('uses an amount a person filled in Jira only where the evidence amount is unknown', async () => {
    const { withJiraAmounts } = await import('../portal/lib/jira-sync.js');
    const snapshot = { applications: [monthly] };
    const issues = [issue('VEL-1', '1003-1차', { actual: 700000 }), issue('VEL-2', '1003-2차', { actual: 1 })];

    const merged = withJiraAmounts(snapshot, issues);

    assert.equal(merged.filled, 1);
    assert.deepEqual(merged.snapshot.applications[0].payments.map((payment) => payment.krw), [700000, 900000]);
    assert.equal(snapshot.applications[0].payments[0].krw, null);
  });
});

describe('formatJiraMoney', () => {
  it('prints the money again with the amounts people filled in Jira', () => {
    const text = formatJiraMoney({ spent: 3000000, available: 9000000 }, 2);

    assert.match(text, /Jira에 적은 금액 2건을 넣은 금액/);
    assert.match(text, /지출\s+3,000,000원/);
    assert.match(text, /사용 가능\s+9,000,000원/);
  });

  it('prints nothing when no amount came from Jira', () => {
    assert.equal(formatJiraMoney({ spent: 1, available: 1 }, 0), '');
  });
});

describe('the sheet-excluded label', () => {
  const jira = { projectKey: 'VEL', issueTypeId: '1', epicKey: 'VEL-1', authors: {}, fields: {} };

  it('marks a monthly application ticket so the sheet leaves out its rough requested amount', () => {
    const plan = planJiraOps({ snapshot: { applications: [monthly, application()] }, issues: [] });
    const byKey = Object.fromEntries(plan.creates.map((ticket) => [ticket.portalKey, ticket]));

    assert.deepEqual(createFields({ jira, ticket: byKey['1003'], baseUrl: 'https://portal.test' }).labels, [SHEET_EXCLUDED_LABEL]);
    assert.equal(createFields({ jira, ticket: byKey['1003-2차'], baseUrl: 'https://portal.test' }).labels, undefined);
    assert.equal(createFields({ jira, ticket: byKey['1007'], baseUrl: 'https://portal.test' }).labels, undefined);
  });
});

describe('applyPlan', () => {
  it('moves a new ticket to done, since only completed evidence becomes a ticket', async () => {
    const jira = { projectKey: 'VEL', issueTypeId: '1', epicKey: 'VEL-1', authors: {}, fields: {} };
    const plan = planJiraOps({ snapshot: { applications: [application()] }, issues: [] });
    const calls = [];
    const request = async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === 'POST' && path === '/issue') return { key: 'VEL-50' };
      if (method === 'GET') return { fields: { summary: plan.creates[0].createOnly.summary } };
      return {};
    };

    await applyPlan(request, { jira, plan, baseUrl: 'https://portal.test' });

    assert.deepEqual(calls.find((call) => call.path === '/issue/VEL-50/transitions').body, { transition: { id: DONE_TRANSITION_ID } });
  });
});
