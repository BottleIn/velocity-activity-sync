import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as formatModule from '../portal/lib/format.js';
import { displayWidth, formatReport, formatWon } from '../portal/lib/report.js';

const MONEY = {
  limit: 12000000,
  spent: 2354500,
  available: 9645500,
  paymentCount: 8,
  unknownCount: 2,
};

function file(key, name) {
  return { key, atchFileId: 'a', fileSn: '1', name, ext: 'pdf', month: null };
}

function application(overrides = {}) {
  return {
    foundId: '2001',
    category: '기타',
    title: '시험 신청',
    author: '홍길동',
    date: '2026-08-05',
    status: '승인',
    evidenceStatus: '증빙완료',
    requestedKrw: 7000,
    approvedKrw: 7000,
    items: [],
    kind: 'once',
    files: [],
    payments: [],
    ...overrides,
  };
}

function payment(overrides = {}) {
  return { key: '2001', round: 2, month: 8, krw: 7000, fileKeys: [], rawValues: [], ...overrides };
}

function cell(krw = 0, unknown = 0) {
  return { krw, unknown };
}

function matrixRow(category, cells, unassigned = cell()) {
  return { category, cells: { 1: cell(), 2: cell(), 3: cell(), ...cells }, unassigned };
}

function reportOf({ applications = [], warnings = [], head = { total: applications.length, approvedKrw: 0 }, money = MONEY, matrix = [], readStats } = {}) {
  return formatReport({ snapshot: { head, applications, warnings }, money, matrix, readStats });
}

function sectionOf(report, heading) {
  const start = report.indexOf(heading);
  assert.notEqual(start, -1, `missing ${heading}`);
  const next = report.indexOf('\n\n', start);
  return report.slice(start, next === -1 ? undefined : next).trimEnd();
}

describe('formatWon', () => {
  it('is the same function the format module exports', () => {
    assert.equal(formatWon, formatModule.formatWon);
    assert.equal(formatWon(1234567), '1,234,567원');
  });
});

describe('displayWidth', () => {
  const cases = [
    ['', 0],
    ['abc', 3],
    ['가나다', 6],
    ['1차', 3],
    ['AI·SW 서비스 이용료', 19],
    ['ㆍ', 2],
    ['₩1,000', 6],
  ];
  for (const [text, expected] of cases) {
    it(`measures ${JSON.stringify(text)} as ${expected} columns`, () => {
      assert.equal(displayWidth(text), expected);
    });
  }
});

describe('formatReport layout', () => {
  it('ends with a newline and shows the sections in order', () => {
    const report = reportOf();

    const headings = ['활동비 포털 읽기 결과', '[읽은 내용]', '[항목별 지출', '[금액 요약]', '[금액을 알 수 없는 결제', '[주의할 점'];
    const positions = headings.map((heading) => report.indexOf(heading));

    assert.ok(report.endsWith('\n'));
    assert.ok(positions.every((position) => position >= 0), JSON.stringify(positions));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  });

  it('counts applications by kind, payments and files', () => {
    const applications = [
      application({ foundId: '1', kind: 'none', files: [] }),
      application({ foundId: '2', kind: 'once', files: [file('k1', 'a.pdf')] }),
      application({ foundId: '3', kind: 'once', files: [file('k2', 'b.pdf'), file('k3', 'c.pdf')] }),
      application({ foundId: '4', kind: 'monthly', files: [] }),
    ];

    const report = reportOf({
      applications,
      head: { total: 4, approvedKrw: 4663000 },
      readStats: { readCount: 2, cachedCount: 1, failed: [{ key: 'k9', name: 'x.pdf', message: 'HTTP 500' }] },
    });

    const section = sectionOf(report, '[읽은 내용]');
    assert.match(section, /신청 4건: 금액 없음 1건, 한 번에 결제 2건, 월별 결제 1건/);
    assert.match(section, /결제 8건 \(금액을 알 수 없는 결제 2건\)/);
    assert.match(section, /증빙 파일 3개: 이번에 새로 받아 읽음 2개, 저장된 결과 사용 1개, 받기 실패 1개/);
    assert.match(section, /전체 4건, 총 승인금액 4,663,000원/);
  });

  it('says the portal total is unknown when the page did not show it', () => {
    const report = reportOf({ head: { total: null, approvedKrw: null } });

    assert.match(sectionOf(report, '[읽은 내용]'), /전체 알 수 없음건, 총 승인금액 알 수 없음/);
  });

  it('works without read statistics', () => {
    const report = reportOf();

    assert.match(report, /받기 실패 0개/);
  });
});

describe('formatReport item by round table', () => {
  const matrix = [
    matrixRow('AI·SW 서비스 이용료', { 1: cell(0, 1), 2: cell(929500), 3: cell(919000) }),
    matrixRow('기타', { 2: cell(6000, 1) }),
  ];

  it('prints unknown counts next to the amount and a dash for an empty cell', () => {
    const report = reportOf({ matrix });

    const section = sectionOf(report, '[항목별 지출');
    assert.match(section, /0 \(\+모름 1\)/);
    assert.match(section, /6,000 \(\+모름 1\)/);
    assert.match(section, /929,500/);
    assert.match(section, /919,000/);
    assert.match(section, / -( |$)/m);
  });

  it('prints one header column per round and one row per category', () => {
    const report = reportOf({ matrix });

    const lines = sectionOf(report, '[항목별 지출').split('\n');

    assert.equal(lines.length, 1 + 1 + 2);
    assert.match(lines[1], /^구분\s+1차\s+2차\s+3차$/);
    assert.ok(lines[2].startsWith('AI·SW 서비스 이용료'));
    assert.ok(lines[3].startsWith('기타'));
  });

  it('pads every line to the same display width and right-aligns the numbers', () => {
    const report = reportOf({ matrix });

    const lines = sectionOf(report, '[항목별 지출').split('\n').slice(1);

    const widths = new Set(lines.map((line) => displayWidth(line)));
    assert.equal(widths.size, 1, JSON.stringify([...widths]));
    assert.ok(lines[0].endsWith('3차'));
    assert.ok(lines[1].endsWith('919,000'));
    assert.ok(lines[2].endsWith('-'));
  });

  it('adds a column for payments that belong to no round only when there is one', () => {
    const without = sectionOf(reportOf({ matrix }), '[항목별 지출');
    const withUnassigned = sectionOf(
      reportOf({ matrix: [matrixRow('기타', {}, cell(1000, 1))] }),
      '[항목별 지출',
    );

    assert.ok(!without.includes('차수 없음'));
    assert.match(withUnassigned, /차수 없음/);
    assert.match(withUnassigned, /1,000 \(\+모름 1\)/);
  });

  it('labels an empty category', () => {
    const report = reportOf({ matrix: [matrixRow('', { 1: cell(10) })] });

    assert.match(sectionOf(report, '[항목별 지출'), /\(구분 없음\)/);
  });

  it('says so when there is no payment at all', () => {
    const report = reportOf({ matrix: [] });

    assert.match(sectionOf(report, '[항목별 지출'), /결제가 없습니다/);
  });
});

describe('formatReport money summary', () => {
  it('prints limit, spent and available with thousands separators and no planned line', () => {
    const report = reportOf();

    const section = sectionOf(report, '[금액 요약]');
    const valueOf = (label) => new RegExp(`${label}\\s+(-?[\\d,]+원)`).exec(section)?.[1];
    assert.equal(valueOf('한도'), '12,000,000원');
    assert.equal(valueOf('지출'), '2,354,500원');
    assert.equal(valueOf('사용 가능'), '9,645,500원');
    assert.doesNotMatch(section, /집행 예정|잔액/);
  });

  it('shows a negative available amount with its sign', () => {
    const report = reportOf({ money: { ...MONEY, available: -400 } });

    assert.match(sectionOf(report, '[금액 요약]'), /-400원/);
  });

  it('warns that spending is understated when some payments are unknown', () => {
    const understated = sectionOf(reportOf(), '[금액 요약]');
    const complete = sectionOf(reportOf({ money: { ...MONEY, unknownCount: 0 } }), '[금액 요약]');

    assert.match(understated, /2건은 지출에 넣지 못/);
    assert.ok(!complete.includes('지출에 넣지 못'));
  });
});

describe('formatReport unknown payments', () => {
  it('lists each payment with its files and the raw values that were read', () => {
    const applications = [
      application({
        foundId: '1003',
        category: 'AI·SW 서비스 이용료',
        kind: 'monthly',
        files: [file('k1', '7월_가짜구독_증빙_내역서(가짜팀).pdf'), file('k2', '8월_가짜구독_증빙_내역서(가짜팀).pdf')],
        payments: [
          payment({ key: '1003-1차', round: 1, month: 7, krw: null, fileKeys: ['k1'], rawValues: ['210.5'] }),
          payment({ key: '1003-2차', round: 2, month: 8, krw: 900000, fileKeys: ['k2'] }),
        ],
      }),
      application({
        foundId: '1005',
        files: [file('k3', '(가짜등록비)기타_사용료_증빙_내역서.docx')],
        payments: [payment({ key: '1005', krw: null, fileKeys: ['k3'], rawValues: ['5$ 원', ''] })],
      }),
    ];

    const report = reportOf({ applications });

    const section = sectionOf(report, '[금액을 알 수 없는 결제');
    assert.match(section, /^\[금액을 알 수 없는 결제 2건\]/);
    assert.match(section, /- 1003-1차 \(AI·SW 서비스 이용료\)/);
    assert.match(section, /파일: 7월_가짜구독_증빙_내역서\(가짜팀\)\.pdf/);
    assert.match(section, /읽은 값: 210\.5/);
    assert.match(section, /- 1005 \(기타\)/);
    assert.match(section, /읽은 값: 5\$ 원, \(빈 값\)/);
    assert.ok(!section.includes('1003-2차'), 'a known payment must not be listed');
    assert.ok(!section.includes('8월_가짜구독'), 'a known payment must not be listed');
  });

  it('labels a payment without a round by its month and shows that it has no file', () => {
    const applications = [
      application({ foundId: '1003', payments: [payment({ key: null, round: null, month: 12, krw: null })] }),
      application({ foundId: '1004', payments: [payment({ key: null, round: null, month: null, krw: null })] }),
    ];

    const section = sectionOf(reportOf({ applications }), '[금액을 알 수 없는 결제');

    assert.match(section, /- 1003 \(12월\) \(기타\)/);
    assert.match(section, /- 1004 \(기타\)/);
    assert.match(section, /파일: \(없음\)/);
    assert.ok(!section.includes('읽은 값'));
  });

  it('names a file by its key when the link had no text', () => {
    const applications = [
      application({
        files: [file('abc:1', '')],
        payments: [payment({ krw: null, fileKeys: ['abc:1'] })],
      }),
    ];

    const section = sectionOf(reportOf({ applications }), '[금액을 알 수 없는 결제');

    assert.match(section, /파일: abc:1/);
  });

  it('shows a plain none marker when every payment amount is known', () => {
    const applications = [application({ payments: [payment({ krw: 7000 })] })];

    const section = sectionOf(reportOf({ applications }), '[금액을 알 수 없는 결제');

    assert.match(section, /^\[금액을 알 수 없는 결제\]\n없음$/);
  });
});

describe('formatReport warnings', () => {
  it('lists every warning message and counts them', () => {
    const warnings = [
      { code: 'no_items', foundId: '1008', message: '신청 1008: 품목이 없는 0원 신청입니다.' },
      { code: 'not_krw', foundId: '1005', key: '1005', message: '신청 1005: 원화 금액으로 읽지 못한 값이 있습니다 (읽은 값: 5$ 원).' },
    ];

    const section = sectionOf(reportOf({ warnings }), '[주의할 점');

    assert.match(section, /^\[주의할 점 2건\]/);
    assert.match(section, /- 신청 1008: 품목이 없는 0원 신청입니다\./);
    assert.match(section, /- 신청 1005: 원화 금액으로 읽지 못한 값이 있습니다 \(읽은 값: 5\$ 원\)\./);
  });

  it('adds the files that could not be downloaded', () => {
    const readStats = { readCount: 0, cachedCount: 0, failed: [{ key: 'k1', name: '내역서.pdf', message: '받기에 실패했습니다 (HTTP 500)' }] };

    const section = sectionOf(reportOf({ readStats }), '[주의할 점');

    assert.match(section, /^\[주의할 점 1건\]/);
    assert.match(section, /증빙 파일을 받지 못했습니다: 내역서\.pdf \(받기에 실패했습니다 \(HTTP 500\)\)/);
  });

  it('shows a plain none marker when there is nothing to warn about', () => {
    const section = sectionOf(reportOf(), '[주의할 점');

    assert.match(section, /^\[주의할 점\]\n없음$/);
  });
});

describe('formatReport terminal safety', () => {
  // 화면을 지우고 창 제목을 바꾸는 이스케이프 시퀀스다. 포털에 올라온 글자가 이런 모양일 수 있다.
  const ESCAPE = '\u001b[2J\u001b]0;제목\u0007';
  const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

  function hostileReport() {
    const applications = [
      application({
        category: `기타${ESCAPE}`,
        files: [file('k1', `내역서${ESCAPE}.pdf`)],
        payments: [payment({ key: `2001${ESCAPE}`, krw: null, fileKeys: ['k1'], rawValues: [`5$${ESCAPE}`] })],
      }),
    ];
    const warnings = [{ code: 'not_krw', foundId: '2001', message: `경고${ESCAPE}` }];
    const readStats = {
      readCount: 0,
      cachedCount: 0,
      failed: [{ key: 'k2', name: `이름${ESCAPE}.pdf`, message: `실패${ESCAPE}` }],
    };
    const matrix = [matrixRow(`기타${ESCAPE}`, { 1: cell(1000) })];
    return reportOf({ applications, warnings, readStats, matrix });
  }

  it('leaves no control character anywhere in the report', () => {
    const report = hostileReport();

    assert.equal(CONTROL.test(report), false);
  });

  it('still shows the text around the removed characters in every section', () => {
    const report = hostileReport();

    for (const shown of ['기타[2J]0;제목', '내역서[2J]0;제목.pdf', '5$[2J]0;제목', '경고[2J]0;제목', '이름[2J]0;제목.pdf', '실패[2J]0;제목']) {
      assert.ok(report.includes(shown), `report is missing ${shown}`);
    }
  });

  it('keeps line breaks and tabs, which the layout needs', () => {
    const report = hostileReport();

    assert.ok(report.includes('\n'));
    assert.match(report, /^구분\s/m);
  });
});
