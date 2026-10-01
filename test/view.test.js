import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseViewText } from '../portal/lib/view.js';
import { loadPortalOutput } from './helpers/fixtures.js';

const NAV = ['마이페이지', '신청/접수', '프로젝트 활동비'];
const HEADER = [
  '제목 시험 신청',
  '구분 개발지원비',
  '상태 승인',
  '총 신청금액 ₩3,000,000',
  '$2,000',
  '총 승인금액 ₩2,500,000',
  '$1,500',
  '작성자 홍길동',
  '작성일 2026.07.16',
  '신청내용',
];
const FOOTER = ['멘토 평가의견', '멘토가', '2026.07.16', '시험용 평가 의견이다.', '목록'];

function itemLines(number, { name = '가짜 품목', payment = '카드결제', quantity = '수량 1', requested = '₩1,000', approved = '₩900' } = {}) {
  return [
    String(number),
    `품목명 ${name}`,
    `결제방식 ${payment}`,
    '세부사항 없음',
    quantity,
    `신청금액 ${requested}`,
    '$1',
    '※ USD 외의 해외 결제는 금액 입력 후 ‘세부사항’에 단위(유로, 엔 등) 명시',
    `승인금액 ${approved}`,
    '$1',
    '구매사유 시험용 사유다.',
    '첨부파일',
    '가짜_첨부.png [10.00 KB , 2026-07-01 ]',
  ];
}

function viewText(...blocks) {
  return [...NAV, ...HEADER, ...blocks.flat(), ...FOOTER].join('\n');
}

describe('parseViewText on the synthetic portal fixture', () => {
  it('reads the header and three items of a multi-item application', () => {
    const output = loadPortalOutput();

    const view = parseViewText(output.views['1003'].text);

    assert.deepEqual(view, {
      title: 'AI·SW 서비스 이용료(7/16)',
      status: '승인',
      requestedKrw: 3000000,
      approvedKrw: 3000000,
      author: '홍길동',
      date: '2026-07-16',
      items: [1, 2, 3].map(() => ({
        name: '가짜 AI 구독',
        payment: '사후청산',
        quantity: 1,
        requestedKrw: 1000000,
        approvedKrw: 1000000,
      })),
    });
  });

  it('does not read a field-like line inside the purchase reason as a field', () => {
    const output = loadPortalOutput();

    const view = parseViewText(output.views['1003'].text);

    assert.equal(view.items[0].requestedKrw, 1000000);
    assert.ok(view.items.every((item) => item.requestedKrw !== 999999));
  });

  it('leaves the quantity empty when the quantity line has no value', () => {
    const output = loadPortalOutput();

    const view = parseViewText(output.views['1001'].text);

    assert.deepEqual(view.items, [
      { name: '프로젝트 활동비 활용계획서', payment: '없음', quantity: null, requestedKrw: 0, approvedKrw: 0 },
    ]);
  });

  it('reads an application with zero items', () => {
    const output = loadPortalOutput();

    const view = parseViewText(output.views['1008'].text);

    assert.deepEqual(view.items, []);
    assert.equal(view.title, 'AI·SW 서비스 이용료(8/14)');
    assert.equal(view.requestedKrw, 0);
    assert.equal(view.approvedKrw, 0);
  });

  it('keeps commas inside an item name', () => {
    const output = loadPortalOutput();

    const view = parseViewText(output.views['1004'].text);

    assert.equal(view.items[0].name, '가짜 허브 3개, 외장 저장장치');
  });

  it('reads every fixture view without leaving the header empty', () => {
    const output = loadPortalOutput();

    for (const [foundId, page] of Object.entries(output.views)) {
      const view = parseViewText(page.text);

      assert.notEqual(view.title, null, foundId);
      assert.equal(typeof view.approvedKrw, 'number', foundId);
      assert.match(view.date, /^\d{4}-\d{2}-\d{2}$/, foundId);
    }
  });
});

describe('parseViewText header', () => {
  it('starts reading at the first line that begins with the title key and a space', () => {
    const text = ['제목', '제목없음', ...NAV, ...HEADER, ...FOOTER].join('\n');

    const view = parseViewText(text);

    assert.equal(view.title, '시험 신청');
    assert.equal(view.requestedKrw, 3000000);
    assert.equal(view.approvedKrw, 2500000);
    assert.equal(view.status, '승인');
    assert.equal(view.author, '홍길동');
    assert.equal(view.date, '2026-07-16');
  });

  it('takes the date from the header and not from the mentor opinion', () => {
    const text = viewText([]).replace('2026.07.16\n시험용', '2026.12.31\n시험용');

    const view = parseViewText(text);

    assert.equal(view.date, '2026-07-16');
  });

  it('returns an empty result when there is no title line', () => {
    for (const input of ['', '마이페이지\n목록', undefined, null]) {
      const view = parseViewText(input);

      assert.deepEqual(view, {
        title: null,
        status: null,
        requestedKrw: null,
        approvedKrw: null,
        author: null,
        date: null,
        items: [],
      });
    }
  });

  it('leaves a header value null when its line is missing', () => {
    const text = ['제목 이름만 있는 신청', '신청내용', '목록'].join('\n');

    const view = parseViewText(text);

    assert.equal(view.title, '이름만 있는 신청');
    assert.equal(view.approvedKrw, null);
    assert.equal(view.date, null);
  });

  it('normalizes decomposed Hangul in the text', () => {
    const text = viewText([]).normalize('NFD');

    const view = parseViewText(text);

    assert.equal(view.title, '시험 신청');
    assert.equal(view.status, '승인');
  });
});

describe('parseViewText items', () => {
  it('reads each item between its name line and its purchase reason', () => {
    const text = viewText(
      itemLines(1, { name: '첫째', requested: '₩1,000', approved: '₩900' }),
      itemLines(2, { name: '둘째', requested: '₩2,000', approved: '₩1,800' }),
    );

    const view = parseViewText(text);

    assert.deepEqual(
      view.items.map((item) => [item.name, item.requestedKrw, item.approvedKrw]),
      [
        ['첫째', 1000, 900],
        ['둘째', 2000, 1800],
      ],
    );
  });

  it('ignores everything from the purchase reason until the next item name', () => {
    const text = viewText(
      [
        '1',
        '품목명 첫째',
        '결제방식 카드',
        '수량 2',
        '신청금액 ₩1,000',
        '승인금액 ₩900',
        '구매사유 첫 줄',
        '수량 99',
        '결제방식 다른 방식',
        '신청금액 ₩999,999',
        '승인금액 ₩888,888',
        '첨부파일',
      ],
      itemLines(2, { name: '둘째' }),
    );

    const view = parseViewText(text);

    assert.deepEqual(view.items[0], {
      name: '첫째',
      payment: '카드',
      quantity: 2,
      requestedKrw: 1000,
      approvedKrw: 900,
    });
    assert.equal(view.items.length, 2);
  });

  it('treats a bare purchase reason line as the end of the item fields', () => {
    const lines = ['1', '품목명 첫째', '신청금액 ₩1,000', '승인금액 ₩900', '구매사유', '신청금액 ₩999,999'];

    const view = parseViewText(viewText(lines));

    assert.equal(view.items[0].requestedKrw, 1000);
  });

  it('lets a later line win when a field name repeats before the purchase reason', () => {
    const lines = [
      '1',
      '품목명 첫째',
      '세부사항 여러 줄로 적은 설명',
      '신청금액 ₩1',
      '수량 1',
      '신청금액 ₩1,000',
      '승인금액 ₩900',
      '구매사유 사유',
    ];

    const view = parseViewText(viewText(lines));

    assert.equal(view.items[0].requestedKrw, 1000);
  });

  it('does not take the header totals for an item amount', () => {
    const view = parseViewText(viewText(itemLines(1, { requested: '₩1,000', approved: '₩900' })));

    assert.equal(view.requestedKrw, 3000000);
    assert.equal(view.items[0].requestedKrw, 1000);
  });

  it('reads the quantity as a number and leaves anything else empty', () => {
    const cases = [
      ['수량 3', 3],
      ['수량 12', 12],
      ['수량 1,000', 1000],
      ['수량', null],
      ['수량 여러 개', null],
    ];
    for (const [line, expected] of cases) {
      const view = parseViewText(viewText(itemLines(1, { quantity: line })));

      assert.equal(view.items[0].quantity, expected, line);
    }
  });

  it('leaves the payment empty when its line has no value', () => {
    const view = parseViewText(viewText(itemLines(1, { payment: '' }).map((line) => line.trimEnd())));

    assert.equal(view.items[0].payment, '');
  });

  it('leaves an amount null when the item has no such line', () => {
    const lines = ['1', '품목명 첫째', '신청금액 ₩1,000', '구매사유 사유'];

    const view = parseViewText(viewText(lines));

    assert.equal(view.items[0].requestedKrw, 1000);
    assert.equal(view.items[0].approvedKrw, null);
  });

  it('stops at the mentor opinion when an item has no purchase reason', () => {
    const lines = ['1', '품목명 첫째', '신청금액 ₩1,000', '승인금액 ₩900'];
    const text = [...NAV, ...HEADER, ...lines, '멘토 평가의견', '신청금액 ₩5', '목록'].join('\n');

    const view = parseViewText(text);

    assert.equal(view.items.length, 1);
    assert.equal(view.items[0].requestedKrw, 1000);
  });

  it('reads an item name line that has no name', () => {
    const view = parseViewText(viewText(['1', '품목명', '신청금액 ₩1,000', '구매사유 사유']));

    assert.equal(view.items.length, 1);
    assert.equal(view.items[0].name, '');
  });
});
