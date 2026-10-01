import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EVIDENCE_COMPLETED, KIND, WARNING, buildSnapshot } from '../portal/lib/snapshot.js';
import { fileNoLabel, fileOk, fileUnreadable, fixtureFileResults } from './helpers/file-results.js';
import { loadPortalOutput } from './helpers/fixtures.js';
import { deepFreeze, fileKey, makePortal } from './helpers/portal-builder.js';
import { DONE, MONTH_TO_ROUND, applicationOf, snapshotOf, warningsOf } from './helpers/snapshot-helpers.js';

describe('constants', () => {
  it('names the completed evidence status and the three application kinds', () => {
    assert.equal(EVIDENCE_COMPLETED, '증빙완료');
    assert.deepEqual(KIND, { NONE: 'none', ONCE: 'once', MONTHLY: 'monthly' });
  });
});

describe('buildSnapshot structure', () => {
  const spec = {
    foundId: '2001',
    category: '재료 구매비',
    title: '재료 구매(7/16)',
    approved: 500000,
    evidenceStatus: DONE,
    date: '2026-07-16',
    items: 2,
    files: ['재료_증빙.pdf'],
    author: '김철수',
  };

  it('describes an application with the fields the later steps need', () => {
    const snapshot = snapshotOf([spec], { [fileKey('2001')]: fileOk(500000) });

    assert.deepEqual(snapshot.applications, [
      {
        foundId: '2001',
        category: '재료 구매비',
        title: '재료 구매(7/16)',
        author: '김철수',
        date: '2026-07-16',
        status: '승인',
        evidenceStatus: DONE,
        requestedKrw: 500000,
        approvedKrw: 500000,
        items: [1, 2].map((number) => ({
          name: `가짜 품목 ${number}`,
          payment: '카드결제',
          quantity: 1,
          requestedKrw: 0,
          approvedKrw: 0,
        })),
        kind: 'once',
        files: [{ key: 'f2001:1', atchFileId: 'f2001', fileSn: '1', name: '재료_증빙.pdf', ext: 'pdf', month: null }],
        payments: [{ key: '2001', round: 1, month: 7, krw: 500000, fileKeys: ['f2001:1'], rawValues: [] }],
      },
    ]);
    assert.deepEqual(snapshot.warnings, []);
  });

  it('carries the list head values', () => {
    const snapshot = snapshotOf([spec, { foundId: '2002', approved: 1000 }]);

    assert.deepEqual(snapshot.head, { total: 2, approvedKrw: 501000 });
  });

  it('keeps the order of the list', () => {
    const snapshot = snapshotOf([{ foundId: '2003' }, { foundId: '2001' }, { foundId: '2002' }]);

    assert.deepEqual(
      snapshot.applications.map((application) => application.foundId),
      ['2003', '2001', '2002'],
    );
  });

  it('does not modify its inputs', () => {
    const output = deepFreeze(makePortal([spec], { errors: [{ where: 'start', message: '알림' }] }));
    const fileResults = deepFreeze({ [fileKey('2001')]: fileOk(500000) });
    const monthToRound = deepFreeze({ ...MONTH_TO_ROUND });

    const snapshot = buildSnapshot({ output, fileResults, monthToRound });

    assert.equal(snapshot.applications.length, 1);
  });

  it('builds an empty snapshot when the list has no applications', () => {
    const snapshot = snapshotOf([]);

    assert.deepEqual(snapshot.applications, []);
    assert.deepEqual(snapshot.warnings, []);
  });

  it('copes with missing view and evidence pages instead of throwing', () => {
    const output = makePortal([{ foundId: '2001', approved: 1000 }]);
    delete output.views['2001'];
    delete output.evidences['2001'];

    const snapshot = buildSnapshot({ output, fileResults: {}, monthToRound: MONTH_TO_ROUND });

    assert.equal(snapshot.applications[0].files.length, 0);
    assert.equal(warningsOf(snapshot, WARNING.VIEW_UNPARSED).length, 1);
  });
});

describe('application kind', () => {
  it('is none when the requested and approved amounts are both zero', () => {
    const snapshot = snapshotOf([{ foundId: '2001', approved: 0, requested: 0 }]);

    assert.equal(applicationOf(snapshot, '2001').kind, 'none');
  });

  it('is once when money is approved and no file name starts with a month', () => {
    const snapshot = snapshotOf([{ foundId: '2001', approved: 1000, files: ['내역서.pdf'] }]);

    assert.equal(applicationOf(snapshot, '2001').kind, 'once');
  });

  it('is once when nothing has been attached yet', () => {
    const snapshot = snapshotOf([{ foundId: '2001', approved: 1000 }]);

    assert.equal(applicationOf(snapshot, '2001').kind, 'once');
  });

  it('is monthly when any file name starts with a month', () => {
    const snapshot = snapshotOf([{ foundId: '2001', approved: 1000, files: ['내역서.pdf', '8월_내역서.pdf'] }]);

    assert.equal(applicationOf(snapshot, '2001').kind, 'monthly');
  });

  it('is none even when month-named files exist, and makes no payment', () => {
    const snapshot = snapshotOf(
      [{ foundId: '2001', approved: 0, requested: 0, evidenceStatus: DONE, files: ['7월_내역서.pdf'] }],
      { [fileKey('2001')]: fileOk(1000) },
    );

    assert.equal(applicationOf(snapshot, '2001').kind, 'none');
    assert.deepEqual(applicationOf(snapshot, '2001').payments, []);
  });

  it('is once when only the requested amount is above zero', () => {
    const snapshot = snapshotOf([{ foundId: '2001', requested: 1000, approved: 0 }]);

    assert.equal(applicationOf(snapshot, '2001').kind, 'once');
  });

  it('ignores files outside the file list when it looks for month names', () => {
    const snapshot = snapshotOf([
      { foundId: '2001', approved: 1000, files: [{ name: '7월_내역서.pdf', container: 'other_list' }, { name: '내역서.pdf', container: 'file_list_new' }] },
    ]);

    const application = applicationOf(snapshot, '2001');

    assert.equal(application.kind, 'once');
    assert.deepEqual(
      application.files.map((file) => file.name),
      ['내역서.pdf'],
    );
  });
});

describe('payments of a one-time application', () => {
  it('makes one payment keyed by the application id in the round of the application month', () => {
    const cases = [
      ['2026-07-16', 7, 1],
      ['2026-08-05', 8, 2],
      ['2026-09-30', 9, 3],
      ['2026-10-01', 10, 4],
      ['2026-11-30', 11, 5],
    ];
    for (const [date, month, round] of cases) {
      const snapshot = snapshotOf([{ foundId: '2001', approved: 1000, evidenceStatus: DONE, date, files: ['내역서.pdf'] }], {
        [fileKey('2001')]: fileOk(1000),
      });

      const [payment] = applicationOf(snapshot, '2001').payments;

      assert.deepEqual([payment.key, payment.month, payment.round], ['2001', month, round], date);
    }
  });

  it('leaves the round empty for a month the map does not know, and warns', () => {
    const snapshot = snapshotOf([{ foundId: '2001', approved: 1000, evidenceStatus: DONE, date: '2026-12-03', files: ['내역서.pdf'] }], {
      [fileKey('2001')]: fileOk(1000),
    });

    const [payment] = applicationOf(snapshot, '2001').payments;
    const [warning] = warningsOf(snapshot, WARNING.ROUND_UNMAPPED);

    assert.deepEqual([payment.key, payment.month, payment.round, payment.krw], ['2001', 12, null, 1000]);
    assert.equal(warning.foundId, '2001');
    assert.equal(warning.key, '2001');
    assert.match(warning.message, /12월/);
  });

  it('warns when the application date could not be read', () => {
    const snapshot = snapshotOf([{ foundId: '2001', approved: 1000, evidenceStatus: DONE, date: null, files: ['내역서.pdf'] }], {
      [fileKey('2001')]: fileOk(1000),
    });

    const [payment] = applicationOf(snapshot, '2001').payments;
    const [warning] = warningsOf(snapshot, WARNING.ROUND_UNMAPPED);

    assert.deepEqual([payment.month, payment.round], [null, null]);
    assert.match(warning.message, /신청일/);
  });

  it('uses the month map it is given', () => {
    const snapshot = snapshotOf(
      [{ foundId: '2001', approved: 1000, evidenceStatus: DONE, date: '2026-12-03', files: ['내역서.pdf'] }],
      { [fileKey('2001')]: fileOk(1000) },
      { monthToRound: { 12: 6 } },
    );

    assert.equal(applicationOf(snapshot, '2001').payments[0].round, 6);
    assert.deepEqual(snapshot.warnings, []);
  });

  it('makes a payment with an unknown amount and a warning when evidence is complete but has no file', () => {
    const snapshot = snapshotOf([{ foundId: '2001', approved: 1000, evidenceStatus: DONE }]);

    const [payment] = applicationOf(snapshot, '2001').payments;
    const [warning] = warningsOf(snapshot, WARNING.COMPLETED_WITHOUT_FILES);

    assert.deepEqual([payment.key, payment.krw, payment.fileKeys], ['2001', null, []]);
    assert.equal(warning.foundId, '2001');
    assert.equal(warning.key, '2001');
  });

  it('makes no payment and no warning while the evidence is not complete and has no file', () => {
    const snapshot = snapshotOf([{ foundId: '2001', approved: 1000, evidenceStatus: '증빙하기' }]);

    assert.deepEqual(applicationOf(snapshot, '2001').payments, []);
    assert.deepEqual(snapshot.warnings, []);
  });

  it('warns about files that were attached before the evidence was completed, and counts no payment', () => {
    const snapshot = snapshotOf(
      [{ foundId: '2001', approved: 1000, evidenceStatus: '증빙하기', files: ['내역서.pdf', '영수증.pdf'] }],
      { [fileKey('2001', 1)]: fileOk(1000) },
    );

    const [warning] = warningsOf(snapshot, WARNING.FILES_BEFORE_COMPLETION);

    assert.deepEqual(applicationOf(snapshot, '2001').payments, []);
    assert.equal(snapshot.warnings.length, 1);
    assert.equal(warning.foundId, '2001');
    assert.match(warning.message, /2개/);
  });

  it('warns about early files for a zero-amount application too', () => {
    const snapshot = snapshotOf([{ foundId: '2001', approved: 0, evidenceStatus: '증빙하기', files: ['내역서.pdf'] }]);

    assert.equal(warningsOf(snapshot, WARNING.FILES_BEFORE_COMPLETION).length, 1);
  });
});

describe('payments of a monthly application', () => {
  const monthlySpec = {
    foundId: '2001',
    approved: 3000000,
    evidenceStatus: DONE,
    date: '2026-07-16',
    files: ['7월_구독_내역서.pdf', '8월_구독_내역서.pdf', '9월_구독_내역서.pdf'],
  };

  it('makes one payment per month, keyed by round', () => {
    const fileResults = {
      [fileKey('2001', 1)]: fileOk(100000),
      [fileKey('2001', 2)]: fileOk(200000),
      [fileKey('2001', 3)]: fileOk(300000),
    };

    const snapshot = snapshotOf([monthlySpec], fileResults);

    assert.deepEqual(applicationOf(snapshot, '2001').payments, [
      { key: '2001-1차', round: 1, month: 7, krw: 100000, fileKeys: ['f2001:1'], rawValues: [] },
      { key: '2001-2차', round: 2, month: 8, krw: 200000, fileKeys: ['f2001:2'], rawValues: [] },
      { key: '2001-3차', round: 3, month: 9, krw: 300000, fileKeys: ['f2001:3'], rawValues: [] },
    ]);
    assert.deepEqual(snapshot.warnings, []);
  });

  it('orders payments by month whatever the order of the files', () => {
    const spec = { ...monthlySpec, files: ['9월_내역서.pdf', '7월_내역서.pdf'] };
    const fileResults = { [fileKey('2001', 1)]: fileOk(1), [fileKey('2001', 2)]: fileOk(2) };

    const snapshot = snapshotOf([spec], fileResults);

    assert.deepEqual(
      applicationOf(snapshot, '2001').payments.map((payment) => payment.month),
      [7, 9],
    );
  });

  it('groups all files of one month into one payment', () => {
    const spec = { ...monthlySpec, files: ['7월_내역서.pdf', '7월_영수증.pdf'] };
    const fileResults = { [fileKey('2001', 1)]: fileOk(100000), [fileKey('2001', 2)]: fileNoLabel() };

    const snapshot = snapshotOf([spec], fileResults);

    const { payments } = applicationOf(snapshot, '2001');

    assert.equal(payments.length, 1);
    assert.deepEqual(payments[0].fileKeys, ['f2001:1', 'f2001:2']);
    assert.equal(payments[0].krw, 100000);
    assert.deepEqual(snapshot.warnings, []);
  });

  it('leaves only the month of an unreadable file unknown', () => {
    const spec = { ...monthlySpec, files: ['7월_내역서.pdf', '7월_영수증.pdf', '8월_내역서.pdf'] };
    const fileResults = {
      [fileKey('2001', 1)]: fileOk(100000),
      [fileKey('2001', 2)]: fileUnreadable(),
      [fileKey('2001', 3)]: fileOk(200000),
    };

    const snapshot = snapshotOf([spec], fileResults);

    const [july, august] = applicationOf(snapshot, '2001').payments;
    assert.deepEqual([july.key, july.krw], ['2001-1차', null]);
    assert.deepEqual([august.key, august.krw], ['2001-2차', 200000]);
    assert.equal(warningsOf(snapshot, WARNING.FILE_UNREADABLE)[0].key, '2001-1차');
  });

  it('leaves both round and key empty for an unmapped month, and warns', () => {
    const spec = { ...monthlySpec, files: ['7월_내역서.pdf', '12월_내역서.pdf'] };
    const fileResults = { [fileKey('2001', 1)]: fileOk(1), [fileKey('2001', 2)]: fileOk(2) };

    const snapshot = snapshotOf([spec], fileResults);

    const [, december] = applicationOf(snapshot, '2001').payments;
    const [warning] = warningsOf(snapshot, WARNING.ROUND_UNMAPPED);

    assert.deepEqual([december.key, december.round, december.month, december.krw], [null, null, 12, 2]);
    assert.equal(warning.foundId, '2001');
    assert.ok(!('key' in warning));
    assert.match(warning.message, /12월/);
  });

  it('warns about a file without a month and leaves it out of every payment', () => {
    const spec = { ...monthlySpec, files: ['7월_내역서.pdf', '영수증_모음.pdf'] };
    const fileResults = { [fileKey('2001', 1)]: fileOk(1000), [fileKey('2001', 2)]: fileOk(999) };

    const snapshot = snapshotOf([spec], fileResults);

    const [warning] = warningsOf(snapshot, WARNING.FILE_WITHOUT_MONTH);

    assert.deepEqual(applicationOf(snapshot, '2001').payments[0].fileKeys, ['f2001:1']);
    assert.equal(warning.foundId, '2001');
    assert.match(warning.message, /영수증_모음\.pdf/);
  });

  it('makes no payment until the evidence is complete', () => {
    const spec = { ...monthlySpec, evidenceStatus: '증빙하기' };

    const snapshot = snapshotOf([spec]);

    assert.deepEqual(applicationOf(snapshot, '2001').payments, []);
    assert.equal(warningsOf(snapshot, WARNING.FILES_BEFORE_COMPLETION).length, 1);
  });

  it('reads the month of a file name written in decomposed Hangul', () => {
    const spec = { ...monthlySpec, files: ['8월_내역서.pdf'.normalize('NFD')] };

    const snapshot = snapshotOf([spec], { [fileKey('2001')]: fileOk(5000) });

    const [payment] = applicationOf(snapshot, '2001').payments;

    assert.deepEqual([payment.key, payment.month, payment.krw], ['2001-2차', 8, 5000]);
  });
});

describe('files whose link had no text', () => {
  const spec = { foundId: '2001', approved: 100000, evidenceStatus: DONE, date: '2026-08-05' };

  it('are named by their key in the messages', () => {
    const snapshot = snapshotOf([{ ...spec, files: [''] }]);

    assert.match(warningsOf(snapshot, WARNING.FILE_NOT_READ)[0].message, /f2001:1/);
  });

  it('are named by their key when unreadable', () => {
    const snapshot = snapshotOf([{ ...spec, files: [''] }], { [fileKey('2001')]: fileUnreadable() });

    assert.match(warningsOf(snapshot, WARNING.FILE_UNREADABLE)[0].message, /f2001:1/);
  });

  it('are named by their key when a monthly application has no month for them', () => {
    const snapshot = snapshotOf([{ ...spec, files: ['7월_내역서.pdf', ''] }], {
      [fileKey('2001', 1)]: fileOk(1),
      [fileKey('2001', 2)]: fileOk(2),
    });

    assert.match(warningsOf(snapshot, WARNING.FILE_WITHOUT_MONTH)[0].message, /f2001:2/);
  });
});

describe('warnings about the view page and the browser', () => {
  it('warns about a zero-amount application with no item', () => {
    const snapshot = snapshotOf([{ foundId: '2001', approved: 0, items: 0 }]);

    const [warning] = warningsOf(snapshot, WARNING.NO_ITEMS);

    assert.equal(warning.foundId, '2001');
    assert.match(warning.message, /품목이 없는 0원 신청/);
  });

  it('does not warn about a zero-amount application that has an item', () => {
    const snapshot = snapshotOf([{ foundId: '2001', approved: 0, items: 1 }]);

    assert.deepEqual(snapshot.warnings, []);
  });

  it('does not warn about the item count of an application that has money', () => {
    const snapshot = snapshotOf([{ foundId: '2001', approved: 1000, items: 0 }]);

    assert.deepEqual(warningsOf(snapshot, WARNING.NO_ITEMS), []);
  });

  it('warns once when the view page has no readable content, without a false item warning', () => {
    const output = makePortal([{ foundId: '2001', approved: 0, items: 0 }]);
    output.views['2001'].text = '오류가 났습니다';

    const snapshot = buildSnapshot({ output, fileResults: {}, monthToRound: MONTH_TO_ROUND });

    assert.equal(warningsOf(snapshot, WARNING.VIEW_UNPARSED).length, 1);
    assert.equal(warningsOf(snapshot, WARNING.NO_ITEMS).length, 0);
  });

  it('warns when the view page and the list disagree about an amount', () => {
    const output = makePortal([{ foundId: '2001', approved: 500000 }]);
    output.views['2001'].text = output.views['2001'].text.replace('총 승인금액 ₩500,000', '총 승인금액 ₩400,000');

    const snapshot = buildSnapshot({ output, fileResults: {}, monthToRound: MONTH_TO_ROUND });

    const [warning] = warningsOf(snapshot, WARNING.VIEW_MISMATCH);

    assert.equal(warning.foundId, '2001');
    assert.match(warning.message, /400,000원/);
    assert.match(warning.message, /500,000원/);
  });

  it('turns the notices the browser recorded into warnings ahead of the others', () => {
    const errors = [{ where: 'view 2001', message: '확인창을 취소했다: 시험' }];

    const snapshot = snapshotOf([{ foundId: '2001', approved: 0, items: 0 }], {}, { errors });

    const [first] = snapshot.warnings;

    assert.equal(first.code, WARNING.BROWSER_ERROR);
    assert.equal(first.foundId, null);
    assert.match(first.message, /view 2001/);
    assert.match(first.message, /확인창을 취소했다/);
    assert.equal(snapshot.warnings.length, 2);
  });

  it('fills in placeholders for a notice that lacks its fields', () => {
    const output = { ...makePortal([{ foundId: '2001', approved: 1 }]), errors: [{}, null] };

    const snapshot = buildSnapshot({ output, fileResults: {}, monthToRound: MONTH_TO_ROUND });

    const notices = warningsOf(snapshot, WARNING.BROWSER_ERROR);

    assert.equal(notices.length, 2);
    assert.match(notices[0].message, /위치 모름/);
    assert.match(notices[1].message, /내용 없음/);
  });

  it('builds an empty snapshot when there is no result at all', () => {
    for (const output of [undefined, null, {}]) {
      const snapshot = buildSnapshot({ output, fileResults: {}, monthToRound: MONTH_TO_ROUND });

      assert.deepEqual(snapshot.applications, []);
      assert.deepEqual(snapshot.warnings, []);
    }
  });

  it('tolerates a malformed error list', () => {
    const output = { ...makePortal([{ foundId: '2001', approved: 1 }]), errors: 'x' };

    const snapshot = buildSnapshot({ output, fileResults: {}, monthToRound: MONTH_TO_ROUND });

    assert.deepEqual(snapshot.warnings, []);
  });
});

describe('the synthetic portal fixture', () => {
  function fixtureSnapshot() {
    return buildSnapshot({
      output: loadPortalOutput(),
      fileResults: fixtureFileResults(),
      monthToRound: MONTH_TO_ROUND,
    });
  }

  it('classifies every application', () => {
    const snapshot = fixtureSnapshot();

    const kinds = Object.fromEntries(snapshot.applications.map((application) => [application.foundId, application.kind]));

    assert.deepEqual(kinds, {
      1001: 'none',
      1002: 'none',
      1003: 'monthly',
      1004: 'once',
      1005: 'once',
      1006: 'once',
      1007: 'once',
      1008: 'none',
      1009: 'once',
      1010: 'once',
      1011: 'monthly',
      1012: 'once',
    });
  });

  it('makes exactly the expected payments', () => {
    const snapshot = fixtureSnapshot();

    const payments = snapshot.applications.flatMap((application) =>
      application.payments.map((payment) => [application.foundId, payment.key, payment.round, payment.krw]),
    );

    assert.deepEqual(payments, [
      ['1011', '1011-3차', 3, 29000],
      ['1007', '1007', 2, 29500],
      ['1006', '1006', 2, 6000],
      ['1005', '1005', 2, null],
      ['1004', '1004', 1, 500000],
      ['1003', '1003-1차', 1, null],
      ['1003', '1003-2차', 2, 900000],
      ['1003', '1003-3차', 3, 890000],
    ]);
  });

  it('counts only the files inside the file list, not the form link next to it', () => {
    const snapshot = fixtureSnapshot();

    const files = applicationOf(snapshot, '1004').files;

    assert.deepEqual(
      files.map((file) => file.name),
      ['재료_구매비_증빙_내역서_가짜팀.pdf'],
    );
    assert.equal(applicationOf(snapshot, '1004').kind, 'once');
    assert.equal(applicationOf(snapshot, '1004').payments[0].krw, 500000);
  });

  it('reads the decomposed file name of the September statement', () => {
    const snapshot = fixtureSnapshot();

    const september = applicationOf(snapshot, '1003').files[2];

    assert.equal(september.month, 9);
    assert.equal(september.name, september.name.normalize('NFC'));
  });

  it('raises exactly the expected warnings', () => {
    const snapshot = fixtureSnapshot();

    const summary = snapshot.warnings.map((warning) => [warning.code, warning.foundId, warning.key ?? null]);

    assert.deepEqual(summary, [
      ['no_items', '1008', null],
      ['not_krw', '1005', '1005'],
      ['not_krw', '1003', '1003-1차'],
    ]);
  });

  it('quotes the values that could not be read as won', () => {
    const snapshot = fixtureSnapshot();

    const byKey = Object.fromEntries(warningsOf(snapshot, WARNING.NOT_KRW).map((warning) => [warning.key, warning.message]));

    assert.match(byKey['1003-1차'], /210\.5/);
    assert.match(byKey['1005'], /5\$/);
  });

  it('carries the list head values', () => {
    const snapshot = fixtureSnapshot();

    assert.deepEqual(snapshot.head, { total: 12, approvedKrw: 4663000 });
  });
});
