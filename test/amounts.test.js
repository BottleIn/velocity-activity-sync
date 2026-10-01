import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FILE_REASON,
  MAX_LABELS,
  PARSER_VERSION,
  RAW_MAX_LENGTH,
  docxXmlToText,
  extractAmounts,
  isKnown,
  parseKrwValue,
} from '../portal/lib/amounts.js';
import { loadEvidenceFiles } from './helpers/fixtures.js';

const LABEL = '금액(VAT포함)';

function wordDocument(body) {
  return `<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body>${body}</w:body></w:document>`;
}

function run(text) {
  return `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
}

describe('constants', () => {
  it('is past version 1, whose stored results kept whole value strings and older reading rules', () => {
    assert.ok(Number.isInteger(PARSER_VERSION));
    assert.ok(PARSER_VERSION >= 2);
  });

  it('caps a stored raw value at 20 characters and a file at 50 amount labels', () => {
    assert.equal(RAW_MAX_LENGTH, 20);
    assert.equal(MAX_LABELS, 50);
  });

  it('exports every file reason the I/O layer and the parser can set', () => {
    assert.deepEqual(FILE_REASON, {
      OK: 'ok',
      NOT_KRW: 'not_krw',
      NO_LABEL: 'no_label',
      UNREADABLE: 'unreadable',
      UNSUPPORTED: 'unsupported',
    });
  });
});

describe('isKnown', () => {
  it('accepts finite numbers, zero included', () => {
    for (const value of [0, 1, 500000, -5]) {
      assert.equal(isKnown(value), true, String(value));
    }
  });

  it('rejects anything that is not a finite number', () => {
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, '1000', {}, []]) {
      assert.equal(isKnown(value), false, String(value));
    }
  });
});

describe('parseKrwValue', () => {
  const krwCases = [
    ['310,000원 (220$)', 310000],
    ['27,450원(19달러)', 27450],
    ['200달러(280,000원)', 280000],
    ['211,340원($151.20)', 211340],
    ['6,000 원', 6000],
    ['0원', 0],
    ['(12,000원)', 12000],
    ['12,000원 (12,000원)', 12000],
    ['₩3,000원', 3000],
    ['₩5,000 (5,000원)', 5000],
    ['₩1,000 ($5)', 1000],
    ['₩1,000.', 1000],
    ['₩1,000,', 1000],
    ['합계 3,000원', 3000],
    ['₩1,234,567', 1234567],
    ['₩ 5000', 5000],
    ['KRW 12,000', 12000],
    ['krw12000', 12000],
    ['$220 (₩295,000)', 295000],
    ['500,000', 500000],
    ['500000', 500000],
    ['  1,234  ', 1234],
  ];
  for (const [value, expected] of krwCases) {
    it(`reads ${JSON.stringify(value)} as ${expected} won`, () => {
      const result = parseKrwValue(value);

      assert.equal(result, expected);
    });
  }

  const notKrwCases = ['25$', '5$ 원', '210.5', '220달러', 'USD 30', '$1,000', '12,34', 'abc', '', '   ', '원', '3.5 원'];
  for (const value of notKrwCases) {
    it(`does not read ${JSON.stringify(value)} as won`, () => {
      const result = parseKrwValue(value);

      assert.equal(result, null);
    });
  }

  // 틀린 숫자를 돌려주느니 null로 두고 사람이 확인하게 한다.
  const wrongNumberCases = [
    ['a decimal point after a symbol amount', '₩1,000.50'],
    ['a decimal point after a KRW amount', 'KRW 1,000.5'],
    ['dots used as thousands separators', '₩ 1.234.567'],
    ['a decimal before the won unit', '1,000.5원'],
    ['a minus sign', '-12,000원'],
    ['a minus sign in parentheses', '(-12,000원)'],
    ['a Unicode minus sign', '\u221212,000원'],
    ['an en dash used as a minus sign', '\u201312,000원'],
    ['a fullwidth hyphen used as a minus sign', '\uff0d12,000원'],
    ['a minus sign before the currency symbol', '-₩12,000'],
    ['a range joined by a hyphen', '1,000-2,000원'],
    ['a digit and one space before the number', '1 000원'],
    ['a digit and two spaces before the number', '1  000원'],
    ['a digit and a no-break space before the number', '1\u00a0000원'],
    ['thousands separated by spaces', '1 000 000원'],
    ['thousands separated by spaces after a symbol', '₩1 000'],
    ['more spaced thousands after a symbol', '₩12 345 678'],
    ['a price and a total that differ', '1,000원 x 12개 = 12,000원'],
    ['two different won figures', '1,000원 2,000원'],
    ['a symbol figure and a unit figure that differ', '₩1,000 = 2,000원'],
    ['a unit figure and a symbol figure that differ', '2,000원 ₩3,000'],
    ['a symbol figure followed by a figure with a space before it', '₩1,000 2,000원'],
    ['a won figure followed by a figure written with a space inside', '1,000원 5 000원'],
    ['an amount beyond any plausible payment', '1,000,000,000,000원'],
    ['a bare number as long as a card number', '1234567890123456'],
    ['a number too large to hold exactly', '99999999999999999999원'],
  ];
  for (const [title, value] of wrongNumberCases) {
    it(`returns null instead of a wrong number for ${title}: ${JSON.stringify(value)}`, () => {
      const result = parseKrwValue(value);

      assert.equal(result, null);
    });
  }

  it('reads the largest plausible amount', () => {
    assert.equal(parseKrwValue('999,999,999,999원'), 999999999999);
  });

  it('stops at the second different won figure instead of collecting them all', () => {
    const value = `1원 2원 ${'3원 '.repeat(100_000)}`;
    const start = performance.now();

    const result = parseKrwValue(value);

    assert.equal(result, null);
    assert.ok(performance.now() - start < 1500);
  });

  it('returns null for missing input', () => {
    assert.equal(parseKrwValue(undefined), null);
    assert.equal(parseKrwValue(null), null);
  });

  it('prefers the won figure when a dollar figure comes first', () => {
    const result = parseKrwValue('200달러(280,000원)');

    assert.equal(result, 280000);
  });
});

describe('docxXmlToText', () => {
  it('joins adjacent runs without a separator, even in the middle of a number', () => {
    const xml = wordDocument(`<w:p>${run('29,500')}${run('원 (20$)')}</w:p>`);

    const text = docxXmlToText(xml);

    assert.equal(text, '29,500원 (20$)\n');
  });

  it('turns paragraph ends, cell ends, tabs and breaks into newlines and tabs', () => {
    const xml = wordDocument(
      `<w:p>${run('a')}</w:p><w:tc><w:p>${run('b')}</w:p></w:tc><w:p>${run('c')}<w:tab/>${run('d')}<w:br/>${run('e')}</w:p>`,
    );

    const text = docxXmlToText(xml);

    assert.equal(text, 'a\nb\n\tc\td\ne\n');
  });

  it('treats a page break element as a line break', () => {
    const xml = wordDocument(`<w:p>${run('a')}<w:br w:type="page"/>${run('b')}</w:p>`);

    assert.equal(docxXmlToText(xml), 'a\nb\n');
  });

  it('does not turn a tab stop definition into a tab character', () => {
    const xml = wordDocument(`<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>${run('a')}</w:p>`);

    assert.equal(docxXmlToText(xml), 'a\n');
  });

  it('decodes the five named entities and numeric references', () => {
    const xml = wordDocument(`<w:p>${run('&amp; &lt; &gt; &quot; &apos; &#65; &#x41; &#xAC00;')}</w:p>`);

    const text = docxXmlToText(xml);

    assert.equal(text, `& < > " ' A A 가\n`);
  });

  it('decodes an entity that a run boundary split in two', () => {
    const xml = wordDocument(`<w:p>${run('가짜팀 &a')}${run('mp; 친구들')}</w:p>`);

    assert.equal(docxXmlToText(xml), '가짜팀 & 친구들\n');
  });

  it('decodes only once so an escaped entity survives', () => {
    const xml = wordDocument(`<w:p>${run('&amp;lt;')}</w:p>`);

    assert.equal(docxXmlToText(xml), '&lt;\n');
  });

  it('leaves unknown or invalid references untouched', () => {
    const xml = wordDocument(`<w:p>${run('&nbsp; &#1114112; &#xD800; &#0;')}</w:p>`);

    assert.equal(docxXmlToText(xml), '&nbsp; &#1114112; &#xD800; &#0;\n');
  });

  it('normalizes decomposed Hangul to NFC', () => {
    const decomposed = '한글'.normalize('NFD');
    const xml = wordDocument(`<w:p>${run(decomposed)}</w:p>`);

    const text = docxXmlToText(xml);

    assert.equal(text, '한글\n');
    assert.notEqual(decomposed, '한글');
  });

  it('leaves out text that a tracked deletion removed', () => {
    const deleted = '<w:del><w:r><w:delText xml:space="preserve">지워진 글자</w:delText></w:r></w:del>';
    const xml = wordDocument(`<w:p>${run('남은 글자')}${deleted}</w:p>`);

    assert.equal(docxXmlToText(xml), '남은 글자\n');
  });

  it('leaves out field codes, which are not visible text', () => {
    const field = '<w:r><w:instrText xml:space="preserve"> HYPERLINK "https://example.test" </w:instrText></w:r>';
    const xml = wordDocument(`<w:p>${field}${run('보이는 글자')}</w:p>`);

    assert.equal(docxXmlToText(xml), '보이는 글자\n');
  });

  it('reads the visible amount when a figure was edited with tracked changes', () => {
    const deleted = '<w:del><w:r><w:delText xml:space="preserve">100원</w:delText></w:r></w:del>';
    const xml = wordDocument(`<w:p>${run('금액(VAT포함) ')}${deleted}${run('200원')}</w:p>`);

    const result = extractAmounts(docxXmlToText(xml));

    assert.deepEqual(result.amounts, [{ krw: 200 }]);
  });

  it('does not let an empty self-closing deletion swallow the text after it', () => {
    const xml = wordDocument(`<w:p><w:r><w:delText/></w:r><w:r><w:instrText w:x="1"/></w:r>${run('남는 글자')}</w:p>`);

    assert.equal(docxXmlToText(xml), '남는 글자\n');
  });

  it('does not swallow the rest of the document when a deletion is never closed', () => {
    const xml = wordDocument(`<w:p><w:r><w:delText>열린 채</w:r></w:p><w:p>${run('뒤의 글자')}</w:p>`);

    assert.ok(docxXmlToText(xml).includes('뒤의 글자'));
  });

  it('strips tags in linear time even when the markup is never closed', () => {
    const inputs = ['<'.repeat(200_000), '<w:br '.repeat(40_000), '<w:delText>'.repeat(40_000)];

    for (const input of inputs) {
      const start = performance.now();

      docxXmlToText(input);

      assert.ok(performance.now() - start < 1500, `${input.slice(0, 12)} took ${performance.now() - start} ms`);
    }
  });

  it('returns an empty string for missing input', () => {
    assert.equal(docxXmlToText(undefined), '');
    assert.equal(docxXmlToText(null), '');
    assert.equal(docxXmlToText(''), '');
  });
});

describe('extractAmounts', () => {
  it('reports no_label when the text has no amount label', () => {
    const text = '영수증\n금액 500원\nAmount paid $20.00';

    const result = extractAmounts(text);

    assert.deepEqual(result, { amounts: [], total: null, reason: 'no_label' });
  });

  it('reads the value after the label on the same line and drops the payer name', () => {
    const text = `팀명 가짜팀(홍길동) ${LABEL} 310,000원 (220$)\n서비스명 가짜 구독`;

    const result = extractAmounts(text);

    assert.deepEqual(result, { amounts: [{ krw: 310000 }], total: 310000, reason: 'ok' });
    assert.ok(!JSON.stringify(result).includes('홍길동'));
  });

  it('sums one label per payer', () => {
    const text = [`${LABEL} 300,000원`, `${LABEL} 305,000원($220)`, `${LABEL} 220달러(295,000원)`].join('\n');

    const result = extractAmounts(text);

    assert.equal(result.total, 900000);
    assert.equal(result.reason, 'ok');
    assert.deepEqual(
      result.amounts.map((amount) => amount.krw),
      [300000, 305000, 295000],
    );
  });

  const labelSpellings = [
    '금액(VAT포함)',
    '금액 (VAT 포함)',
    '금액（VAT포함）',
    '금액 ( VAT포함 )',
    '금액(VAT  포함)',
    '금액(VAT포함）',
  ];
  for (const spelling of labelSpellings) {
    it(`recognizes the label spelled ${JSON.stringify(spelling)}`, () => {
      const text = `${spelling} 1,000원`;

      const result = extractAmounts(text);

      assert.equal(result.total, 1000);
    });
  }

  it('recognizes a label written in decomposed Hangul', () => {
    const text = `${LABEL} 1,000원`.normalize('NFD');

    const result = extractAmounts(text);

    assert.equal(result.total, 1000);
  });

  const separators = [' | ', ': ', ' :\t', '：', '\t', '   '];
  for (const separator of separators) {
    it(`strips the separator ${JSON.stringify(separator)} before the value`, () => {
      const text = `${LABEL}${separator}300,000원`;

      const result = extractAmounts(text);

      assert.deepEqual(result.amounts, [{ krw: 300000 }]);
    });
  }

  it('takes the next non-empty line when nothing follows the label', () => {
    const text = `${LABEL}\n310,000원\n다음 줄`;

    const result = extractAmounts(text);

    assert.deepEqual(result.amounts, [{ krw: 310000 }]);
  });

  it('skips blank and whitespace-only lines while looking ahead', () => {
    const text = `${LABEL}  \n\n \t \n\t29,500원 (20$)\n`;

    const result = extractAmounts(text);

    assert.deepEqual(result.amounts, [{ krw: 29500 }]);
  });

  it('looks ahead exactly one non-empty line', () => {
    const text = `${LABEL}\n서비스명 가짜\n300,000원`;

    const result = extractAmounts(text);

    assert.equal(result.reason, 'not_krw');
    assert.deepEqual(result.amounts, [{ raw: '', krw: null }]);
  });

  it('never uses a following line that is itself a label line as the value', () => {
    const text = `${LABEL}\n팀명 가짜팀(이영희) ${LABEL} 300,000원`;

    const result = extractAmounts(text);

    assert.deepEqual(result.amounts, [{ raw: '', krw: null }, { krw: 300000 }]);
    assert.ok(!JSON.stringify(result).includes('이영희'));
  });

  it('reads two labels that share one line', () => {
    const text = `${LABEL} 300,000원 ${LABEL} 200,000원`;

    const result = extractAmounts(text);

    assert.deepEqual(
      result.amounts.map((amount) => amount.krw),
      [300000, 200000],
    );
    assert.equal(result.total, 500000);
  });

  it('reports not_krw with an empty value when the label ends the text', () => {
    const text = `팀명 가짜팀 ${LABEL}`;

    const result = extractAmounts(text);

    assert.deepEqual(result, { amounts: [{ raw: '', krw: null }], total: null, reason: 'not_krw' });
  });

  it('reports not_krw and no total when any payer amount is not in won', () => {
    const text = [`${LABEL} 310,000원 (220$)`, `${LABEL} 200달러(280,000원)`, `${LABEL} 210.5`].join('\n');

    const result = extractAmounts(text);

    assert.equal(result.reason, 'not_krw');
    assert.equal(result.total, null);
    assert.deepEqual(
      result.amounts.map((amount) => amount.krw),
      [310000, 280000, null],
    );
    assert.deepEqual(result.amounts[2], { raw: '210.5', krw: null });
  });

  it('stores only the amount for a value that was read, and nothing that came with it', () => {
    const text = `${LABEL} 4,000원 홍길동 카드 1234-5678-9012-3456`;

    const result = extractAmounts(text);

    assert.deepEqual(result.amounts, [{ krw: 4000 }]);
    assert.ok(!JSON.stringify(result).includes('홍길동'));
    assert.ok(!JSON.stringify(result).includes('1234'));
  });

  it('stores only the first amount-like token of a value that could not be read as won', () => {
    const text = `${LABEL} 220달러 홍길동 카드 1234-5678-9012-3456`;

    const result = extractAmounts(text);

    assert.deepEqual(result.amounts, [{ raw: '220달러', krw: null }]);
    assert.ok(!JSON.stringify(result).includes('홍길동'));
    assert.ok(!JSON.stringify(result).includes('1234'));
  });

  const rawCases = [
    ['a decimal number', '210.5', '210.5'],
    ['a dollar sign after the number', '5$ 원', '5$'],
    ['a dollar sign before the number', '$ 1,000 남는 말', '$ 1,000'],
    ['a dollar word', '220달러 (환율 적용 전)', '220달러'],
    ['a currency code after the number', '30 USD 결제', '30 USD'],
    ['a currency code before the number', 'USD 30', 'USD 30'],
    ['a currency code before a decimal number', 'KRW 5.5', 'KRW 5.5'],
    ['a decimal with a thousands separator', '1,000.50', '1,000.50'],
    ['a won sign before a decimal', '₩1,000.50', '₩1,000.50'],
    ['an amount followed by a name', '$310 홍길동', '$310'],
    ['an amount followed by a comma and a name', '$310, 홍길동', '$310'],
    ['the first of two amounts', '220달러 300달러', '220달러'],
    ['the number that follows a sign, not the number ahead of that sign', '5 $ 1,000', '1,000'],
    ['no number at all', '서비스명 가짜', ''],
    ['an empty value', '', ''],
  ];
  for (const [title, value, expected] of rawCases) {
    it(`keeps ${JSON.stringify(expected)} as the raw value for ${title}`, () => {
      const result = extractAmounts(`${LABEL} ${value}`);

      assert.deepEqual(result.amounts, [{ raw: expected, krw: null }]);
    });
  }

  // 카드 번호·날짜·전화번호는 구분 문자가 무엇이든 조각 하나도 남기지 않는다. 첫 묶음만이라도 남으면 번호의 일부다.
  const notAmountCases = [
    ['a card number with hyphens', '카드 1234-5678-9012-3456'],
    ['a card number with no separator', '카드 1234567890123456'],
    ['a card number with spaces', '카드 1234 5678 9012 3456'],
    ['a card number with spaces and no other text', '1234 5678 9012 3456'],
    ['a card number after a name', '홍길동 1234 5678 9012 3456'],
    ['a date with hyphens', '2026-09-30'],
    ['a date with slashes', '2026/09/30'],
    ['a date with spaces', '2026 09 30'],
    ['a date with dots and spaces', '2026. 9. 30.'],
    ['a date with dots', '2026.09.30'],
    ['a phone number with hyphens', '010-1234-5678'],
    ['a phone number with spaces', '010 1234 5678'],
    ['a phone number with dots', '010.1234.5678'],
    ['an address made of numbers with dots', '192.168.0.1'],
    ['a card number with hyphens between spaces', '1234 - 5678 - 9012 - 3456'],
    ['a date with hyphens between spaces', '2026 - 09 - 30'],
    ['a card number after a name and a number', '홍길동 1234 - 5678 - 9012 - 3456 4321'],
    ['the last digits of a card after a word', '카드 9967'],
    ['a phone number with no separator after a word', '전화 01012345678'],
    ['a compact date after a word', '일자 20260930'],
    ['a business number with hyphens', '123-45-67890'],
    ['a plain number after a word, which cannot be told from an id', '결제 30'],
    ['a card-length number followed by the won unit', '1234567890123456원'],
    ['a card-length number followed by a dollar sign', '1234567890123456$'],
    ['the last group of a spaced card number with the won unit', '카드 1234 5678 9012 3456원'],
    ['a negative amount', '-12,000원'],
    ['a negative amount in dollars', '-5$'],
    ['thousands groups glued to more digits', '1,000,00'],
    ['a currency sign far from its number', '$     5'],
    ['a currency code far from its number', '30      USD'],
    ['a decimal joined to more digits with a hyphen', '2026.09-30'],
    ['a number followed by the currency code of the next amount', '5 USD 45'],
    ['a number followed by the currency sign of a number', '9967 $5'],
  ];
  for (const [title, value] of notAmountCases) {
    it(`keeps nothing of ${title}: ${JSON.stringify(value)}`, () => {
      const [amount] = extractAmounts(`${LABEL} ${value}`).amounts;

      assert.deepEqual(amount, { raw: '', krw: null });
    });
  }

  it('caps a stored raw value at the fixed length', () => {
    const value = 'USD   999,999,999,999';
    assert.ok(value.length > RAW_MAX_LENGTH);

    const [amount] = extractAmounts(`${LABEL} ${value}`).amounts;

    assert.equal(amount.raw, value.slice(0, RAW_MAX_LENGTH));
    assert.equal(amount.raw.length, RAW_MAX_LENGTH);
  });

  // 꾸민 파일이 처리 시간을 늘리지 못하게 한다. 숫자·구분 문자·공백·통화 기호가 길게 이어져도 금방 끝나야 한다.
  const slowInputs = [
    ['dots between single digits', '1.'.repeat(100_000)],
    ['currency signs and spaces', '$ '.repeat(100_000)],
    ['a digit and a long run of spaces, repeated', `1${' '.repeat(100)}`.repeat(2000)],
    ['thousands groups with a dangling comma', '1,000,'.repeat(50_000)],
    ['single digits and spaces', '5 '.repeat(100_000)],
    ['currency codes with no number', 'USD '.repeat(50_000)],
    ['a code letter and a long run of spaces, repeated', `U${' '.repeat(100)}`.repeat(2000)],
  ];
  for (const [title, value] of slowInputs) {
    it(`looks for the money token of ${title} in a short time and finds none`, () => {
      const start = performance.now();

      const [amount] = extractAmounts(`${LABEL} ${value}`).amounts;

      assert.deepEqual(amount, { raw: '', krw: null });
      assert.ok(performance.now() - start < 1500, `took ${performance.now() - start} ms`);
    });
  }

  it('reads a value that holds two different won figures as not readable', () => {
    const result = extractAmounts(`${LABEL} 1,000원 x 12개 = 12,000원`);

    assert.deepEqual(result, { amounts: [{ raw: '1,000원', krw: null }], total: null, reason: 'not_krw' });
  });

  it('reads exactly the maximum number of labels', () => {
    const text = Array.from({ length: MAX_LABELS }, () => `${LABEL} 1,000원`).join('\n');

    const result = extractAmounts(text);

    assert.equal(result.reason, 'ok');
    assert.equal(result.amounts.length, MAX_LABELS);
    assert.equal(result.total, 1000 * MAX_LABELS);
  });

  it('gives up on a file with more labels than a statement can have, so it is not cached', () => {
    const text = Array.from({ length: MAX_LABELS + 1 }, () => `${LABEL} 1,000원`).join('\n');

    const result = extractAmounts(text);

    assert.equal(result.reason, 'unreadable');
    assert.equal(result.total, null);
    assert.equal(result.amounts.length, MAX_LABELS);
    assert.equal(typeof result.detail, 'string');
    assert.match(result.detail, /금액\(VAT포함\)/);
    assert.ok(result.detail.includes(String(MAX_LABELS)));
  });

  it('gives up the same way when the labels all sit on one line', () => {
    const text = `${LABEL} 1원 `.repeat(1000);

    const result = extractAmounts(text);

    assert.equal(result.reason, 'unreadable');
    assert.equal(result.amounts.length, MAX_LABELS);
  });

  it('looks for the next line without copying the rest of the text for every label', () => {
    const text = `${LABEL}\nx\n`.repeat(200_000);
    const start = performance.now();

    const result = extractAmounts(text);

    assert.equal(result.reason, 'unreadable');
    assert.ok(performance.now() - start < 1500, `took ${performance.now() - start} ms`);
  });

  it('handles Windows line endings', () => {
    const text = `${LABEL} 1,000원\r\n서비스명 가짜\r\n`;

    const result = extractAmounts(text);

    assert.deepEqual(result.amounts, [{ krw: 1000 }]);
  });

  it('treats non-string input as text with no label', () => {
    for (const input of [undefined, null, 42]) {
      assert.equal(extractAmounts(input).reason, 'no_label');
    }
  });
});

describe('extractAmounts on the synthetic evidence fixtures', () => {
  const evidenceFiles = loadEvidenceFiles();
  const textOf = (key) => {
    const file = evidenceFiles[key];
    return file.kind === 'docx' ? docxXmlToText(file.xml) : file.text;
  };
  const cases = [
    ['000000000000000000000000000003eb:1', 'not_krw', null, [310000, 280000, null]],
    ['000000000000000000000000000003eb:2', 'ok', 900000, [300000, 305000, 295000]],
    ['000000000000000000000000000003eb:3', 'ok', 890000, [298000, 302000, 290000]],
    ['000000000000000000000000000003ec:1', 'ok', 500000, [500000]],
    ['00000000-0000-0000-0000-000003ef:1', 'ok', 29500, [29500]],
    ['00000000-0000-0000-0000-000003ef:2', 'no_label', null, []],
    ['000000000000000000000000000003ee:1', 'ok', 6000, [6000]],
    ['000000000000000000000000000003ed:1', 'not_krw', null, [null]],
    ['000000000000000000000000000003f3:1', 'ok', 29000, [29000]],
  ];
  for (const [key, reason, total, krwList] of cases) {
    it(`reads ${key} as ${reason}`, () => {
      const text = textOf(key);

      const result = extractAmounts(text);

      assert.equal(result.reason, reason);
      assert.equal(result.total, total);
      assert.deepEqual(
        result.amounts.map((amount) => amount.krw),
        krwList,
      );
    });
  }

  it('keeps the raw text of the value that could not be read as won', () => {
    const result = extractAmounts(textOf('000000000000000000000000000003ed:1'));

    assert.deepEqual(result.amounts, [{ raw: '5$', krw: null }]);
  });

  it('finds the value in the next table cell of a converted docx', () => {
    const text = textOf('000000000000000000000000000003f3:1');

    const result = extractAmounts(text);

    assert.deepEqual(result.amounts, [{ krw: 29000 }]);
    assert.ok(text.includes('가짜팀 & 친구들'));
  });
});
