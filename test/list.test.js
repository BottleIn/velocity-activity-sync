import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseListHead, parseListPages, parseMoneyCell, parsePortalDate } from '../portal/lib/list.js';
import { loadPortalOutput } from './helpers/fixtures.js';

const HEADER = ['NO.', '구분', '제목', '신청금액', '승인금액', '상태', '증빙접수', '팀명', '작성자', '등록일'];
const TEAM_TABLE = [
  { cells: ['NO.', '팀명', '팀장'], links: [] },
  { cells: ['1', '가짜팀', '홍길동'], links: ['javascript:void(0);'] },
];

function viewLinks(foundId) {
  const view = `/busan/sw/mypage/projectSpt/view.do?foundId=${foundId}&menuNo=200054&pageIndex=1`;
  const evidence = `/busan/sw/mypage/projectSpt/evidence.do?foundId=${foundId}&menuNo=200054&pageIndex=1`;
  return [view, view, view, view, evidence, evidence];
}

function dataRow(foundId, overrides = {}, header = HEADER) {
  const values = {
    'NO.': '1',
    구분: '기타',
    제목: '기타 사용료(8/5)',
    신청금액: '₩7,000\n$5',
    승인금액: '₩7,000\n$0',
    상태: '승인',
    증빙접수: '증빙완료',
    팀명: '가짜팀',
    작성자: '김철수',
    등록일: '2026.08.05',
    ...overrides,
  };
  return { cells: header.map((name) => values[name] ?? ''), links: viewLinks(foundId) };
}

function listPage(rows, { header = HEADER, text = 'Total : 1\n총 승인금액 ₩ 7,000 / $ 0' } = {}) {
  return {
    url: 'https://portal.example.test/list',
    text,
    tables: [TEAM_TABLE, [{ cells: header, links: [] }, ...rows]],
    anchors: [],
  };
}

describe('parseMoneyCell', () => {
  const cases = [
    ['₩41,870\n$31', { krw: 41870, usd: 31 }],
    ['₩0\n$0', { krw: 0, usd: 0 }],
    ['₩3,000,000\n$2,000', { krw: 3000000, usd: 2000 }],
    ['₩ 5,000\n$ 3', { krw: 5000, usd: 3 }],
    ['₩1,000', { krw: 1000, usd: null }],
    ['$5', { krw: null, usd: 5 }],
    ['₩1,000\n$1,234.5', { krw: 1000, usd: 1234.5 }],
    ['', { krw: null, usd: null }],
    ['abc', { krw: null, usd: null }],
  ];
  for (const [cell, expected] of cases) {
    it(`reads ${JSON.stringify(cell)}`, () => {
      const money = parseMoneyCell(cell);

      assert.deepEqual(money, expected);
    });
  }

  it('returns nulls for missing input', () => {
    assert.deepEqual(parseMoneyCell(undefined), { krw: null, usd: null });
    assert.deepEqual(parseMoneyCell(null), { krw: null, usd: null });
  });
});

describe('parsePortalDate', () => {
  const cases = [
    ['2026.09.13', '2026-09-13'],
    ['2026-09-13', '2026-09-13'],
    ['2026/09/13', '2026-09-13'],
    ['2026.13.01', null],
    ['2026.00.10', null],
    ['2026.09.32', null],
    ['26.09.13', null],
    ['2026.9.13', null],
    ['', null],
  ];
  for (const [text, expected] of cases) {
    it(`reads ${JSON.stringify(text)} as ${expected}`, () => {
      assert.equal(parsePortalDate(text), expected);
    });
  }

  it('returns null for missing input', () => {
    assert.equal(parsePortalDate(undefined), null);
  });
});

describe('parseListHead', () => {
  it('reads the total count and the total approved amount from the fixture page', () => {
    const output = loadPortalOutput();

    const head = parseListHead(output.listPages[0].text);

    assert.deepEqual(head, { total: 12, approvedKrw: 4663000 });
  });

  it('reads zero values', () => {
    const head = parseListHead('Total : 0\n총 승인금액 ₩ 0 / $ 0');

    assert.deepEqual(head, { total: 0, approvedKrw: 0 });
  });

  it('returns nulls when the page shows neither value', () => {
    assert.deepEqual(parseListHead('아무 내용'), { total: null, approvedKrw: null });
    assert.deepEqual(parseListHead(undefined), { total: null, approvedKrw: null });
  });
});

describe('parseListPages on the synthetic portal fixture', () => {
  it('finds the header and reads the head values', () => {
    const output = loadPortalOutput();

    const result = parseListPages(output.listPages);

    assert.equal(result.headerFound, true);
    assert.deepEqual(result.missingColumns, []);
    assert.deepEqual(result.head, { total: 12, approvedKrw: 4663000 });
  });

  it('reads every application once, newest first', () => {
    const output = loadPortalOutput();

    const { rows } = parseListPages(output.listPages);

    assert.deepEqual(
      rows.map((row) => row.foundId),
      ['1012', '1011', '1010', '1009', '1008', '1007', '1006', '1005', '1004', '1003', '1002', '1001'],
    );
  });

  it('reads all fields of an application row', () => {
    const output = loadPortalOutput();

    const { rows } = parseListPages(output.listPages);

    assert.deepEqual(
      rows.find((row) => row.foundId === '1003'),
      {
        foundId: '1003',
        category: 'AI·SW 서비스 이용료',
        title: 'AI·SW 서비스 이용료(7/16)',
        requested: { krw: 3000000, usd: 2000 },
        approved: { krw: 3000000, usd: 2000 },
        status: '승인',
        evidenceStatus: '증빙완료',
        author: '홍길동',
        date: '2026-07-16',
      },
    );
  });

  it('keeps an empty category as an empty string', () => {
    const output = loadPortalOutput();

    const { rows } = parseListPages(output.listPages);

    assert.equal(rows.find((row) => row.foundId === '1008').category, '');
  });

  it('sums the approved amounts to the total the page shows', () => {
    const output = loadPortalOutput();

    const { rows, head } = parseListPages(output.listPages);

    const sum = rows.reduce((total, row) => total + row.approved.krw, 0);
    assert.equal(sum, head.approvedKrw);
  });

  it('does not modify the pages it was given', () => {
    const output = loadPortalOutput();
    const before = JSON.stringify(output.listPages);

    parseListPages(output.listPages);

    assert.equal(JSON.stringify(output.listPages), before);
  });
});

describe('parseListPages column lookup and edge cases', () => {
  it('finds columns by name when the portal reorders them', () => {
    const reordered = ['등록일', '작성자', '증빙접수', '상태', '승인금액', '신청금액', '제목', '구분', 'NO.'];
    const pages = [listPage([dataRow('2001', {}, reordered)], { header: reordered })];

    const { rows, headerFound } = parseListPages(pages);

    assert.equal(headerFound, true);
    assert.deepEqual(rows[0], {
      foundId: '2001',
      category: '기타',
      title: '기타 사용료(8/5)',
      requested: { krw: 7000, usd: 5 },
      approved: { krw: 7000, usd: 0 },
      status: '승인',
      evidenceStatus: '증빙완료',
      author: '김철수',
      date: '2026-08-05',
    });
  });

  it('reports the header as missing when no table has the evidence column', () => {
    const page = { url: 'x', text: 'Total : 0', tables: [TEAM_TABLE], anchors: [] };

    const result = parseListPages([page]);

    assert.equal(result.headerFound, false);
    assert.deepEqual(result.rows, []);
  });

  it('reports the header as missing for empty or malformed input', () => {
    for (const input of [undefined, null, [], [{}], [{ tables: 'x' }]]) {
      const result = parseListPages(input);

      assert.equal(result.headerFound, false, JSON.stringify(input));
      assert.deepEqual(result.rows, []);
    }
  });

  it('names the columns that are missing from the header', () => {
    const header = HEADER.filter((name) => name !== '등록일' && name !== '작성자');
    const pages = [listPage([dataRow('2001', {}, header)], { header })];

    const result = parseListPages(pages);

    assert.equal(result.headerFound, true);
    assert.deepEqual(result.missingColumns, ['작성자', '등록일']);
    assert.deepEqual(result.rows, []);
  });

  it('drops a repeated application and keeps the first occurrence', () => {
    const pages = [
      listPage([dataRow('2001', { 제목: '처음' }), dataRow('2002')]),
      listPage([dataRow('2001', { 제목: '중복' }), dataRow('2003')]),
    ];

    const { rows } = parseListPages(pages);

    assert.deepEqual(
      rows.map((row) => [row.foundId, row.title]),
      [
        ['2001', '처음'],
        ['2002', '기타 사용료(8/5)'],
        ['2003', '기타 사용료(8/5)'],
      ],
    );
  });

  it('skips a row that has no application link', () => {
    const noLink = { cells: HEADER.map(() => '값'), links: ['javascript:void(0);'] };
    const empty = { cells: ['등록된 게시물이 없습니다.'], links: [] };
    const pages = [listPage([noLink, empty, dataRow('2001')])];

    const { rows } = parseListPages(pages);

    assert.deepEqual(
      rows.map((row) => row.foundId),
      ['2001'],
    );
  });

  it('skips a row whose link list is missing or holds things that are not links', () => {
    const rows = [
      { cells: HEADER.map(() => '값'), links: null },
      { cells: HEADER.map(() => '값') },
      { cells: HEADER.map(() => '값'), links: [null, 5, undefined] },
      dataRow('2001'),
    ];

    const { rows: parsed } = parseListPages([listPage(rows)]);

    assert.deepEqual(
      parsed.map((row) => row.foundId),
      ['2001'],
    );
  });

  it('takes the application id from the first link that has one', () => {
    const row = { ...dataRow('2001'), links: ['javascript:void(0);', ...viewLinks('2001')] };

    const { rows } = parseListPages([listPage([row])]);

    assert.equal(rows[0].foundId, '2001');
  });

  it('ignores a later page whose table has no header', () => {
    const second = { url: 'x', text: '오류', tables: [TEAM_TABLE], anchors: [] };

    const result = parseListPages([listPage([dataRow('2001')]), second]);

    assert.equal(result.headerFound, true);
    assert.equal(result.rows.length, 1);
  });

  it('judges the header on the first page only', () => {
    const first = { url: 'x', text: '', tables: [TEAM_TABLE], anchors: [] };

    const result = parseListPages([first, listPage([dataRow('2001')])]);

    assert.equal(result.headerFound, false);
  });

  it('reads a short row without crashing and leaves its amounts unknown', () => {
    const short = { cells: ['5', '기타'], links: viewLinks('2001') };

    const { rows } = parseListPages([listPage([short])]);

    assert.equal(rows[0].category, '기타');
    assert.deepEqual(rows[0].approved, { krw: null, usd: null });
    assert.equal(rows[0].date, null);
  });

  it('normalizes decomposed Hangul in text cells', () => {
    const decomposed = '재료 구매비'.normalize('NFD');
    const pages = [listPage([dataRow('2001', { 구분: decomposed, 증빙접수: '증빙완료'.normalize('NFD') })])];

    const { rows } = parseListPages(pages);

    assert.equal(rows[0].category, '재료 구매비');
    assert.equal(rows[0].evidenceStatus, '증빙완료');
  });
});
