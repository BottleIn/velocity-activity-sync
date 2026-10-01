// buildSnapshot이 결제 묶음 하나의 금액을 어떻게 정하는지 본다. 읽은 파일, 아직 못 읽은 파일, 읽을 수 없던 파일,
// 금액 칸이 없는 파일이 섞였을 때의 규칙이다. 구조와 종류 판정은 test/snapshot.test.js가 본다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WARNING, buildSnapshot } from '../portal/lib/snapshot.js';
import { fileNoLabel, fileNotKrw, fileOk, fileUnreadable, fileUnsupported } from './helpers/file-results.js';
import { fileKey, makePortal } from './helpers/portal-builder.js';
import { DONE, MONTH_TO_ROUND, applicationOf, snapshotOf, warningsOf } from './helpers/snapshot-helpers.js';

describe('the amount of one payment group', () => {
  const spec = { foundId: '2001', approved: 100000, evidenceStatus: DONE, date: '2026-08-05' };

  // results의 항목이 undefined이면 그 파일은 아직 읽지 못한(저장된 결과가 없는) 것이다.
  function oneTime(results) {
    const names = results.map((_, index) => `내역서${index + 1}.pdf`);
    const fileResults = Object.fromEntries(
      results.map((result, index) => [fileKey('2001', index + 1), result]).filter(([, result]) => result !== undefined),
    );
    return snapshotOf([{ ...spec, files: names }], fileResults);
  }

  it('takes the total of the only labeled file and ignores a file without a label', () => {
    const snapshot = oneTime([fileOk(29500), fileNoLabel()]);

    const [payment] = applicationOf(snapshot, '2001').payments;

    assert.equal(payment.krw, 29500);
    assert.deepEqual(snapshot.warnings, []);
  });

  it('ignores an unsupported file when another file has the amount', () => {
    const snapshot = oneTime([fileUnsupported(), fileOk(7000)]);

    assert.equal(applicationOf(snapshot, '2001').payments[0].krw, 7000);
    assert.deepEqual(snapshot.warnings, []);
  });

  // 읽지 못한 파일은 다른 결제자의 내역서일 수 있어서, 읽은 파일만으로 합계를 내면 실제보다 작게 나온다.
  it('leaves the amount unknown when an unreadable file sits beside a labeled one', () => {
    const snapshot = oneTime([fileOk(7000), fileUnreadable()]);

    const [warning] = warningsOf(snapshot, WARNING.FILE_UNREADABLE);

    assert.equal(applicationOf(snapshot, '2001').payments[0].krw, null);
    assert.equal(snapshot.warnings.length, 1);
    assert.equal(warning.foundId, '2001');
    assert.equal(warning.key, '2001');
    assert.match(warning.message, /내역서2\.pdf/);
    assert.ok(!warning.message.includes('내역서1.pdf'));
  });

  it('leaves the amount unknown whichever side the unreadable file is on', () => {
    const snapshot = oneTime([fileUnreadable(), fileOk(7000)]);

    assert.equal(applicationOf(snapshot, '2001').payments[0].krw, null);
    assert.equal(warningsOf(snapshot, WARNING.FILE_UNREADABLE).length, 1);
  });

  it('still ignores files without a label or of an unsupported kind beside a labeled one', () => {
    const snapshot = oneTime([fileNoLabel(), fileUnsupported(), fileOk(7000)]);

    assert.equal(applicationOf(snapshot, '2001').payments[0].krw, 7000);
    assert.deepEqual(snapshot.warnings, []);
  });

  it('names every file it could not use when some were not read and some were unreadable', () => {
    const snapshot = oneTime([undefined, fileUnreadable(), fileOk(7000)]);

    const [warning] = warningsOf(snapshot, WARNING.FILE_NOT_READ);

    assert.equal(applicationOf(snapshot, '2001').payments[0].krw, null);
    assert.equal(snapshot.warnings.length, 1);
    assert.match(warning.message, /내역서1\.pdf/);
    assert.match(warning.message, /내역서2\.pdf/);
    assert.ok(!warning.message.includes('내역서3.pdf'));
  });

  it('leaves the amount unknown when two files carry a label', () => {
    const snapshot = oneTime([fileOk(7000), fileOk(7000)]);

    const [warning] = warningsOf(snapshot, WARNING.DUPLICATE_STATEMENT);

    assert.equal(applicationOf(snapshot, '2001').payments[0].krw, null);
    assert.equal(snapshot.warnings.length, 1);
    assert.equal(warning.key, '2001');
    assert.match(warning.message, /내역서1\.pdf/);
    assert.match(warning.message, /내역서2\.pdf/);
  });

  it('counts a labeled file that is not in won toward the duplicate rule', () => {
    const snapshot = oneTime([fileOk(7000), fileNotKrw('5$')]);

    assert.equal(applicationOf(snapshot, '2001').payments[0].krw, null);
    assert.equal(warningsOf(snapshot, WARNING.DUPLICATE_STATEMENT).length, 1);
  });

  it('leaves the amount unknown and quotes the raw values when the only labeled file is not in won', () => {
    const snapshot = oneTime([fileNotKrw('210.5', '5$ 원'), fileNoLabel()]);

    const [payment] = applicationOf(snapshot, '2001').payments;
    const [warning] = warningsOf(snapshot, WARNING.NOT_KRW);

    assert.equal(payment.krw, null);
    assert.deepEqual(payment.rawValues, ['210.5', '5$ 원']);
    assert.equal(warning.key, '2001');
    assert.match(warning.message, /210\.5/);
    assert.match(warning.message, /5\$ 원/);
  });

  it('quotes only the raw values that could not be read as won', () => {
    const mixed = {
      ...fileNotKrw(),
      amounts: [
        { krw: 300000 },
        { raw: '210.5', krw: null },
      ],
    };

    const snapshot = oneTime([mixed]);

    const [payment] = applicationOf(snapshot, '2001').payments;

    assert.deepEqual(payment.rawValues, ['210.5']);
    assert.ok(!warningsOf(snapshot, WARNING.NOT_KRW)[0].message.includes('300000'));
  });

  it('copes with a not-in-won entry that lost its raw value', () => {
    const broken = { ...fileNotKrw(), amounts: [{ krw: null }] };

    const snapshot = oneTime([broken]);

    assert.deepEqual(applicationOf(snapshot, '2001').payments[0].rawValues, ['']);
    assert.match(warningsOf(snapshot, WARNING.NOT_KRW)[0].message, /\(빈 값\)/);
  });

  it('leaves the amount unknown when no file carries a label', () => {
    const snapshot = oneTime([fileNoLabel(), fileUnsupported()]);

    const [warning] = warningsOf(snapshot, WARNING.NO_LABELED_FILE);

    assert.equal(applicationOf(snapshot, '2001').payments[0].krw, null);
    assert.equal(snapshot.warnings.length, 1);
    assert.equal(warning.key, '2001');
  });

  it('warns once, about the file, when the only file is unreadable', () => {
    const snapshot = oneTime([fileUnreadable()]);

    assert.equal(applicationOf(snapshot, '2001').payments[0].krw, null);
    assert.equal(snapshot.warnings.length, 1);
    assert.equal(warningsOf(snapshot, WARNING.FILE_UNREADABLE).length, 1);
    assert.match(warningsOf(snapshot, WARNING.FILE_UNREADABLE)[0].message, /다시 실행하면 다시 시도/);
  });

  it('leaves the amount unknown when a file has not been read', () => {
    const snapshot = oneTime([undefined]);

    const [warning] = warningsOf(snapshot, WARNING.FILE_NOT_READ);

    assert.equal(applicationOf(snapshot, '2001').payments[0].krw, null);
    assert.equal(snapshot.warnings.length, 1);
    assert.match(warning.message, /내역서1\.pdf/);
  });

  it('leaves the amount unknown when one file is read and another is not', () => {
    const snapshot = oneTime([fileOk(7000), undefined]);

    assert.equal(applicationOf(snapshot, '2001').payments[0].krw, null);
    assert.equal(warningsOf(snapshot, WARNING.FILE_NOT_READ).length, 1);
  });

  it('does not trust a cached ok result whose total is missing', () => {
    const broken = { ...fileOk(7000), total: null };

    const snapshot = oneTime([broken]);

    assert.equal(applicationOf(snapshot, '2001').payments[0].krw, null);
    assert.equal(warningsOf(snapshot, WARNING.NOT_KRW).length, 1);
  });

  it('copes with a cached result that lost its amounts as well', () => {
    const broken = { parserVersion: 1, total: null, reason: 'ok', readAt: 'x' };

    const snapshot = oneTime([broken]);

    const [payment] = applicationOf(snapshot, '2001').payments;
    const [warning] = warningsOf(snapshot, WARNING.NOT_KRW);

    assert.deepEqual([payment.krw, payment.rawValues], [null, []]);
    assert.match(warning.message, /읽은 값: 없음/);
  });

  it('shows an empty raw value as such', () => {
    const snapshot = oneTime([fileNotKrw('')]);

    assert.match(warningsOf(snapshot, WARNING.NOT_KRW)[0].message, /\(빈 값\)/);
  });

  it('treats a cached entry that is not an object as not read', () => {
    const output = makePortal([{ ...spec, files: ['내역서.pdf'] }]);

    const snapshot = buildSnapshot({ output, fileResults: { [fileKey('2001')]: null }, monthToRound: MONTH_TO_ROUND });

    assert.equal(warningsOf(snapshot, WARNING.FILE_NOT_READ).length, 1);
  });
});
