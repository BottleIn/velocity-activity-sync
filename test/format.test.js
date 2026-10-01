import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatNumber, formatRawValues, formatWon, stripControlCharacters, UNKNOWN_AMOUNT } from '../portal/lib/format.js';

describe('formatNumber', () => {
  it('inserts thousands separators without relying on locale data', () => {
    const cases = [
      [0, '0'],
      [7, '7'],
      [999, '999'],
      [1000, '1,000'],
      [12345, '12,345'],
      [123456, '123,456'],
      [1234567, '1,234,567'],
      [12000000, '12,000,000'],
    ];

    for (const [input, expected] of cases) {
      assert.equal(formatNumber(input), expected, `input ${input}`);
    }
  });

  it('keeps the sign in front of negative numbers', () => {
    assert.equal(formatNumber(-500), '-500');
    assert.equal(formatNumber(-1234567), '-1,234,567');
  });

  it('agrees with the en-US locale formatter for a spread of integers', () => {
    for (let value = 0; value < 5_000_000; value += 123_457) {
      assert.equal(formatNumber(value), value.toLocaleString('en-US'));
    }
  });

  it('does not print a negative zero', () => {
    assert.equal(formatNumber(-0), '0');
    assert.equal(formatNumber(-0.4), '0');
  });

  it('rounds fractional input to whole won', () => {
    assert.equal(formatNumber(1234.6), '1,235');
  });
});

describe('formatWon', () => {
  it('appends the won unit', () => {
    assert.equal(formatWon(2354500), '2,354,500원');
    assert.equal(formatWon(0), '0원');
    assert.equal(formatWon(-1000), '-1,000원');
  });

  it('prints a fixed phrase when the amount is unknown', () => {
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, '1000']) {
      assert.equal(formatWon(value), UNKNOWN_AMOUNT, `input ${String(value)}`);
    }
  });
});

describe('formatRawValues', () => {
  it('joins the values with commas', () => {
    assert.equal(formatRawValues(['210.5', '5$']), '210.5, 5$');
  });

  it('shows an empty value as such so it is not mistaken for nothing', () => {
    assert.equal(formatRawValues(['5$', '']), '5$, (빈 값)');
    assert.equal(formatRawValues(['']), '(빈 값)');
  });

  it('says there is nothing when no value was kept', () => {
    assert.equal(formatRawValues([]), '없음');
  });
});

describe('stripControlCharacters', () => {
  it('keeps ordinary text, Korean, line breaks and tabs as they are', () => {
    const text = '한도\t12,000,000원\n지출  100원\n';

    assert.equal(stripControlCharacters(text), text);
  });

  it('removes the escape character so a colour or cursor sequence cannot run', () => {
    assert.equal(stripControlCharacters('\u001b[31m빨강\u001b[0m'), '[31m빨강[0m');
    assert.equal(stripControlCharacters('\u001b]0;제목\u0007'), ']0;제목');
  });

  it('removes every other C0 control character except the tab and the line feed', () => {
    for (let code = 0; code <= 0x1f; code += 1) {
      const kept = code === 0x09 || code === 0x0a;

      const result = stripControlCharacters(`a${String.fromCharCode(code)}b`);

      assert.equal(result, kept ? `a${String.fromCharCode(code)}b` : 'ab', `U+${code.toString(16).padStart(4, '0')}`);
    }
  });

  it('removes the delete character and the C1 control characters', () => {
    for (let code = 0x7f; code <= 0x9f; code += 1) {
      const result = stripControlCharacters(`a${String.fromCharCode(code)}b`);

      assert.equal(result, 'ab', `U+${code.toString(16).padStart(4, '0')}`);
    }
  });

  it('keeps the characters just outside the ranges', () => {
    assert.equal(stripControlCharacters('\u0020\u00a0\u00a1'), '\u0020\u00a0\u00a1');
  });

  it('treats missing input as empty text', () => {
    assert.equal(stripControlCharacters(undefined), '');
    assert.equal(stripControlCharacters(null), '');
  });
});
