import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_CONFIG } from '../portal/lib/config.js';
import { CATEGORY_ORDER, itemRoundMatrix, summarizeMoney } from '../portal/lib/money.js';
import { buildSnapshot } from '../portal/lib/snapshot.js';
import { fixtureFileResults } from './helpers/file-results.js';
import { loadPortalOutput } from './helpers/fixtures.js';
import { deepFreeze } from './helpers/portal-builder.js';

function payment(krw, round = 1) {
  return { key: null, round, month: null, krw, fileKeys: [], rawValues: [] };
}

function application({ kind, approvedKrw = 0, evidenceStatus = '증빙완료', payments = [], category = '기타' }) {
  return { foundId: '1', category, kind, approvedKrw, evidenceStatus, payments };
}

function snapshotOf(...applications) {
  return { head: { total: applications.length, approvedKrw: 0 }, applications, warnings: [] };
}

describe('summarizeMoney', () => {
  it('starts from the whole default limit when there is nothing to count', () => {
    const summary = summarizeMoney(snapshotOf());

    assert.deepEqual(summary, {
      limit: 12000000,
      spent: 0,
      available: 12000000,
      paymentCount: 0,
      unknownCount: 0,
    });
  });

  it('sums the known payments and counts the unknown ones separately', () => {
    const snapshot = snapshotOf(
      application({ kind: 'once', approvedKrw: 500000, payments: [payment(500000)] }),
      application({ kind: 'once', approvedKrw: 7000, payments: [payment(null)] }),
      application({ kind: 'monthly', approvedKrw: 100000, payments: [payment(1000, 1), payment(2000, 2)] }),
    );

    const summary = summarizeMoney(snapshot);

    assert.equal(summary.spent, 503000);
    assert.equal(summary.paymentCount, 4);
    assert.equal(summary.unknownCount, 1);
  });

  it('subtracts only completed spending from the limit, not approved money still waiting for evidence', () => {
    const snapshot = snapshotOf(
      application({ kind: 'once', approvedKrw: 500000, payments: [payment(500000)] }),
      application({ kind: 'once', approvedKrw: 300000, evidenceStatus: '증빙하기' }),
    );

    const summary = summarizeMoney(snapshot, { limit: 1000000 });

    assert.deepEqual(summary, {
      limit: 1000000,
      spent: 500000,
      available: 500000,
      paymentCount: 1,
      unknownCount: 0,
    });
  });

  it('lets the available amount go negative when more is spent than the limit allows', () => {
    const snapshot = snapshotOf(application({ kind: 'once', approvedKrw: 500, payments: [payment(500)] }));

    const summary = summarizeMoney(snapshot, { limit: 100 });

    assert.equal(summary.available, -400);
  });

  it('does not modify the snapshot', () => {
    const snapshot = deepFreeze(snapshotOf(application({ kind: 'once', approvedKrw: 1, payments: [payment(1)] })));

    const summary = summarizeMoney(snapshot);

    assert.equal(summary.spent, 1);
  });
});

describe('itemRoundMatrix', () => {
  it('lists the categories in the documented order followed by any other category', () => {
    const categories = [
      '클라우드 서비스',
      '재료 구매비',
      '프로젝트 활동비 활용계획서',
      '기타',
      'AI·SW 서비스 이용료',
      '',
      '기자재 임대비',
      '전문가 활용비',
      '마케팅비',
      '디자인 제작비',
    ];
    const snapshot = snapshotOf(...categories.map((category) => application({ kind: 'once', category, payments: [payment(1)] })));

    const matrix = itemRoundMatrix(snapshot);

    assert.deepEqual(
      matrix.map((row) => row.category),
      [...CATEGORY_ORDER, '프로젝트 활동비 활용계획서', ''],
    );
  });

  it('documents the fixed category order', () => {
    assert.deepEqual(CATEGORY_ORDER, [
      'AI·SW 서비스 이용료',
      '기자재 임대비',
      '기타',
      '디자인 제작비',
      '마케팅비',
      '재료 구매비',
      '전문가 활용비',
      '클라우드 서비스',
    ]);
  });

  it('leaves out categories that have no payment', () => {
    const snapshot = snapshotOf(
      application({ kind: 'once', category: '기타', payments: [payment(1)] }),
      application({ kind: 'once', category: '마케팅비', payments: [] }),
      application({ kind: 'none', category: '클라우드 서비스', payments: [] }),
    );

    const matrix = itemRoundMatrix(snapshot);

    assert.deepEqual(
      matrix.map((row) => row.category),
      ['기타'],
    );
  });

  it('returns no rows for a snapshot without payments', () => {
    assert.deepEqual(itemRoundMatrix(snapshotOf()), []);
  });

  it('gives every row a cell for each round, empty ones at zero', () => {
    const snapshot = snapshotOf(application({ kind: 'once', payments: [payment(6000, 2)] }));

    const [row] = itemRoundMatrix(snapshot);

    assert.deepEqual(row.cells, {
      1: { krw: 0, unknown: 0 },
      2: { krw: 6000, unknown: 0 },
      3: { krw: 0, unknown: 0 },
      4: { krw: 0, unknown: 0 },
      5: { krw: 0, unknown: 0 },
    });
    assert.deepEqual(row.unassigned, { krw: 0, unknown: 0 });
  });

  it('adds the known amounts of one category and round and counts the unknown payments', () => {
    const snapshot = snapshotOf(
      application({ kind: 'monthly', payments: [payment(900000, 2), payment(null, 1)] }),
      application({ kind: 'once', payments: [payment(29500, 2), payment(null, 2)] }),
    );

    const [row] = itemRoundMatrix(snapshot);

    assert.deepEqual(row.cells[1], { krw: 0, unknown: 1 });
    assert.deepEqual(row.cells[2], { krw: 929500, unknown: 1 });
  });

  it('collects payments that belong to no column so the money does not disappear', () => {
    const snapshot = snapshotOf(
      application({ kind: 'once', payments: [payment(1000, null), payment(null, null), payment(5, 1)] }),
    );

    const [row] = itemRoundMatrix(snapshot);

    assert.deepEqual(row.unassigned, { krw: 1000, unknown: 1 });
    assert.deepEqual(row.cells[1], { krw: 5, unknown: 0 });
  });

  it('keeps a category whose only payment has no round', () => {
    const snapshot = snapshotOf(application({ kind: 'once', payments: [payment(1000, null)] }));

    const matrix = itemRoundMatrix(snapshot);

    assert.equal(matrix.length, 1);
  });

  it('uses the rounds it is given', () => {
    const snapshot = snapshotOf(application({ kind: 'once', payments: [payment(10, 1), payment(20, 3)] }));

    const [row] = itemRoundMatrix(snapshot, { rounds: [1, 2] });

    assert.deepEqual(Object.keys(row.cells), ['1', '2']);
    assert.deepEqual(row.unassigned, { krw: 20, unknown: 0 });
  });

  it('does not modify the snapshot', () => {
    const snapshot = deepFreeze(snapshotOf(application({ kind: 'once', payments: [payment(1)] })));

    const matrix = itemRoundMatrix(snapshot);

    assert.equal(matrix.length, 1);
  });
});

describe('the synthetic portal fixture', () => {
  const snapshot = buildSnapshot({
    output: loadPortalOutput(),
    fileResults: fixtureFileResults(),
    monthToRound: DEFAULT_CONFIG.monthToRound,
  });

  it('reproduces the expected money summary', () => {
    const summary = summarizeMoney(snapshot, { limit: 12000000 });

    assert.equal(summary.spent, 2354500);
    assert.equal(summary.available, 9645500);
    assert.equal(summary.paymentCount, 8);
    assert.equal(summary.unknownCount, 2);
  });

  it('reproduces the expected item by round matrix', () => {
    const matrix = itemRoundMatrix(snapshot);

    const byCategory = Object.fromEntries(matrix.map((row) => [row.category, row.cells]));

    assert.deepEqual(
      matrix.map((row) => row.category),
      ['AI·SW 서비스 이용료', '기타', '재료 구매비'],
    );
    assert.deepEqual(byCategory['AI·SW 서비스 이용료'], {
      1: { krw: 0, unknown: 1 },
      2: { krw: 929500, unknown: 0 },
      3: { krw: 919000, unknown: 0 },
      4: { krw: 0, unknown: 0 },
      5: { krw: 0, unknown: 0 },
    });
    assert.deepEqual(byCategory['기타'][2], { krw: 6000, unknown: 1 });
    assert.deepEqual(byCategory['재료 구매비'][1], { krw: 500000, unknown: 0 });
  });
});
