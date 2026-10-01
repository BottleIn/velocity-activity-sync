// 파일 입출력 없이 이어 붙인 순수한 전체 흐름이다: 가짜 포털 화면과 가짜 증빙 파일 글자에서 보고서까지.
// 진입점이 하는 일 중 브라우저와 파일 입출력을 뺀 나머지가 서로 맞물리는지 잠근다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FILE_REASON, PARSER_VERSION, docxXmlToText, extractAmounts } from '../portal/lib/amounts.js';
import { DEFAULT_CONFIG, DEFAULT_ROUNDS } from '../portal/lib/config.js';
import { itemRoundMatrix, summarizeMoney } from '../portal/lib/money.js';
import { formatReport } from '../portal/lib/report.js';
import { buildSnapshot, validatePortal } from '../portal/lib/snapshot.js';
import { loadEvidenceFiles, loadPortalOutput } from './helpers/fixtures.js';

function readFileResults(evidenceFiles) {
  return Object.fromEntries(
    Object.entries(evidenceFiles).map(([key, file]) => {
      const text = file.kind === 'docx' ? docxXmlToText(file.xml) : file.text;
      const { total, reason, amounts } = extractAmounts(text);
      return [key, { parserVersion: PARSER_VERSION, total, reason, amounts, readAt: '2026-09-30T09:01:00.000Z' }];
    }),
  );
}

function run(fileResults) {
  const output = loadPortalOutput();
  const snapshot = buildSnapshot({ output, fileResults, monthToRound: DEFAULT_CONFIG.monthToRound });
  const money = summarizeMoney(snapshot, { limit: DEFAULT_CONFIG.limit });
  const matrix = itemRoundMatrix(snapshot, { rounds: DEFAULT_ROUNDS });
  return { snapshot, money, matrix, report: formatReport({ snapshot, money, matrix }) };
}

describe('the synthetic portal, end to end', () => {
  const output = loadPortalOutput();
  const fileResults = readFileResults(loadEvidenceFiles());
  const { snapshot, money, matrix, report } = run(fileResults);

  it('passes the checks that would stop the run', () => {
    assert.deepEqual(validatePortal(output), []);
  });

  it('reads the evidence files the way the brief describes', () => {
    const reasons = Object.fromEntries(Object.entries(fileResults).map(([key, result]) => [key.slice(-4), result.reason]));

    assert.equal(fileResults['000000000000000000000000000003eb:1'].reason, FILE_REASON.NOT_KRW);
    assert.equal(fileResults['00000000-0000-0000-0000-000003ef:2'].reason, FILE_REASON.NO_LABEL);
    assert.equal(Object.keys(reasons).length, 9);
  });

  it('matches the list head the portal shows', () => {
    assert.deepEqual(snapshot.head, { total: 12, approvedKrw: 4663000 });
    assert.equal(snapshot.applications.length, 12);
  });

  it('counts the money the way the brief expects', () => {
    assert.equal(money.spent, 2354500);
    assert.equal(money.available, 9645500);
    assert.equal(money.limit, 12000000);
  });

  it('places every payment in the item by round matrix', () => {
    const byCategory = Object.fromEntries(matrix.map((row) => [row.category, row.cells]));

    assert.deepEqual(byCategory['AI·SW 서비스 이용료'][1], { krw: 0, unknown: 1 });
    assert.deepEqual(byCategory['AI·SW 서비스 이용료'][2], { krw: 929500, unknown: 0 });
    assert.deepEqual(byCategory['AI·SW 서비스 이용료'][3], { krw: 919000, unknown: 0 });
    assert.deepEqual(byCategory['기타'][2], { krw: 6000, unknown: 1 });
    assert.deepEqual(byCategory['재료 구매비'][1], { krw: 500000, unknown: 0 });
    assert.equal(matrix.length, 3);
  });

  it('warns about the zero-item application and the two amounts that are not in won', () => {
    const summary = snapshot.warnings.map((warning) => [warning.code, warning.foundId, warning.key ?? null]);

    assert.deepEqual(summary, [
      ['no_items', '1008', null],
      ['not_krw', '1005', '1005'],
      ['not_krw', '1003', '1003-1차'],
    ]);
    assert.match(snapshot.warnings[1].message, /5\$/);
    assert.match(snapshot.warnings[2].message, /210\.5/);
  });

  it('prints the key numbers and the unknown payments in the report', () => {
    for (const expected of [
      '2,354,500원',
      '9,645,500원',
      '12,000,000원',
      '4,663,000원',
      '전체 12건',
      '0 (+모름 1)',
      '6,000 (+모름 1)',
      '929,500',
      '919,000',
      '500,000',
      '1003-1차',
      '읽은 값: 210.5',
      '읽은 값: 5$',
      '신청 1008: 품목이 없는 0원 신청입니다.',
    ]) {
      assert.ok(report.includes(expected), `report is missing ${expected}`);
    }
  });

  it('lists only the two unknown payments', () => {
    const start = report.indexOf('[금액을 알 수 없는 결제');
    const section = report.slice(start, report.indexOf('\n\n', start));

    assert.match(section, /^\[금액을 알 수 없는 결제 2건\]/);
    assert.equal(section.split('\n').filter((line) => line.startsWith('- ')).length, 2);
  });
});

describe('the synthetic portal when a file has not been read', () => {
  const baseline = run(readFileResults(loadEvidenceFiles()));

  it('takes an unread payment out of spent and counts it as unknown', () => {
    const missing = readFileResults(loadEvidenceFiles());
    delete missing['000000000000000000000000000003ec:1'];

    const { money } = run(missing);

    assert.equal(money.spent, baseline.money.spent - 500000);
    assert.equal(money.unknownCount, baseline.money.unknownCount + 1);
  });

  it('warns about the payment whose file was not read', () => {
    const missing = readFileResults(loadEvidenceFiles());
    delete missing['000000000000000000000000000003ec:1'];

    const { snapshot } = run(missing);

    assert.ok(snapshot.warnings.some((warning) => warning.code === 'file_not_read' && warning.key === '1004'));
  });
});

describe('the synthetic portal when a file cannot be read', () => {
  const baseline = run(readFileResults(loadEvidenceFiles()));
  // 1007의 영수증 PDF다. 라벨이 없어서 읽히기만 하면 금액에 영향이 없는 파일이다.
  const RECEIPT_KEY = '00000000-0000-0000-0000-000003ef:2';
  const unreadable = { parserVersion: PARSER_VERSION, total: null, reason: FILE_REASON.UNREADABLE, amounts: [], readAt: '2026-09-30T09:01:00.000Z' };

  function withUnreadable(key) {
    return run({ ...readFileResults(loadEvidenceFiles()), [key]: unreadable });
  }

  it('makes the payment unknown even though the statement beside it was read', () => {
    const { snapshot, money } = withUnreadable(RECEIPT_KEY);

    const payment = snapshot.applications.find((application) => application.foundId === '1007').payments[0];
    assert.equal(payment.krw, null);
    assert.equal(money.spent, baseline.money.spent - 29500);
  });

  it('warns once about that payment and names the receipt', () => {
    const { snapshot } = withUnreadable(RECEIPT_KEY);

    const warnings = snapshot.warnings.filter((warning) => warning.key === '1007');

    assert.deepEqual(
      warnings.map((warning) => warning.code),
      ['file_unreadable'],
    );
    assert.match(warnings[0].message, /가짜_영수증\.pdf/);
  });

  it('lists the payment among the unknown ones in the report', () => {
    const { report } = withUnreadable(RECEIPT_KEY);

    assert.match(report, /\[금액을 알 수 없는 결제 3건\]/);
    assert.match(report, /- 1007 \(AI·SW 서비스 이용료\)/);
  });
});
