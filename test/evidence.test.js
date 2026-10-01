import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fileLabel, monthFromName, parseEvidenceLinks } from '../portal/lib/evidence.js';
import { loadPortalOutput } from './helpers/fixtures.js';

function hrefFor(atchFileId, fileSn) {
  return `/busan/sw/cmmn/file/fileDown.do?menuNo=200054&atchFileId=${atchFileId}&fileSn=${fileSn}`;
}

function anchor(text, { atchFileId = 'abc123', fileSn = 1, ...extra } = {}) {
  return { text, href: hrefFor(atchFileId, fileSn), ...extra };
}

describe('monthFromName', () => {
  const cases = [
    ['7월_가짜구독_증빙.pdf', 7],
    ['07월 내역서.pdf', 7],
    ['12월.docx', 12],
    ['1월', 1],
    ['13월_증빙.pdf', null],
    ['0월_증빙.pdf', null],
    ['00월_증빙.pdf', null],
    ['100월_증빙.pdf', null],
    ['월_증빙.pdf', null],
    ['x7월_증빙.pdf', null],
    ['(7월)_증빙.pdf', null],
    ['증빙_7월.pdf', null],
    ['', null],
  ];
  for (const [name, expected] of cases) {
    it(`reads ${JSON.stringify(name)} as month ${expected}`, () => {
      const month = monthFromName(name);

      assert.equal(month, expected);
    });
  }

  it('reads a month from a decomposed (NFD) Hangul name', () => {
    const name = '9월_가짜구독.pdf'.normalize('NFD');

    const month = monthFromName(name);

    assert.notEqual(name, name.normalize('NFC'));
    assert.equal(month, 9);
  });

  it('returns null for missing input', () => {
    assert.equal(monthFromName(undefined), null);
    assert.equal(monthFromName(null), null);
  });
});

describe('fileLabel', () => {
  it('shows the file name', () => {
    assert.equal(fileLabel({ key: 'abc:1', name: '내역서.pdf' }), '내역서.pdf');
  });

  it('falls back to the key when the link had no text', () => {
    assert.equal(fileLabel({ key: 'abc:1', name: '' }), 'abc:1');
  });
});

describe('parseEvidenceLinks on the synthetic portal fixture', () => {
  it('reads the three monthly statements of one application in order', () => {
    const output = loadPortalOutput();

    const files = parseEvidenceLinks(output.evidences['1003'].anchors);

    assert.deepEqual(
      files.map((file) => [file.key, file.atchFileId, file.fileSn, file.ext, file.month]),
      [
        ['000000000000000000000000000003eb:1', '000000000000000000000000000003eb', '1', 'pdf', 7],
        ['000000000000000000000000000003eb:2', '000000000000000000000000000003eb', '2', 'pdf', 8],
        ['000000000000000000000000000003eb:3', '000000000000000000000000000003eb', '3', 'pdf', 9],
      ],
    );
  });

  it('normalizes a decomposed Hangul file name to NFC', () => {
    const output = loadPortalOutput();
    const stored = output.evidences['1003'].anchors[2].text;

    const files = parseEvidenceLinks(output.evidences['1003'].anchors);

    assert.notEqual(stored, stored.normalize('NFC'));
    assert.equal(files[2].name, stored.normalize('NFC'));
    assert.equal(files[2].month, 9);
  });

  it('reads files without a month prefix', () => {
    const output = loadPortalOutput();

    const files = parseEvidenceLinks(output.evidences['1007'].anchors);

    assert.deepEqual(
      files.map((file) => [file.fileSn, file.ext, file.month]),
      [
        ['1', 'docx', null],
        ['2', 'pdf', null],
      ],
    );
  });

  it('returns an empty list for an application with no attachments', () => {
    const output = loadPortalOutput();

    assert.deepEqual(parseEvidenceLinks(output.evidences['1001'].anchors), []);
  });

  it('gives every link the container the real page reports, except one form link outside the list', () => {
    const output = loadPortalOutput();

    const anchors = Object.values(output.evidences).flatMap((page) => page.anchors);

    assert.ok(anchors.every((item) => typeof item.container === 'string'));
    assert.deepEqual(
      anchors.filter((item) => !item.container.includes('file_list')).map((item) => item.text),
      ['증빙_양식.hwp'],
    );
  });

  it('leaves out the form link that sits outside the file list', () => {
    const output = loadPortalOutput();

    const files = parseEvidenceLinks(output.evidences['1004'].anchors);

    assert.equal(output.evidences['1004'].anchors.length, 2);
    assert.deepEqual(
      files.map((file) => file.name),
      ['재료_구매비_증빙_내역서_가짜팀.pdf'],
    );
  });
});

describe('parseEvidenceLinks link filtering', () => {
  it('skips anything that is not a fileDown link', () => {
    const anchors = [
      { text: '상세', href: '/busan/sw/mypage/projectSpt/view.do?foundId=1001&menuNo=200054' },
      { text: '스크립트', href: 'javascript:void(0);' },
      { text: '메일', href: 'mailto:a@example.test' },
      { text: '다른 경로', href: '/busan/sw/other/fileDown.do?atchFileId=abc&fileSn=1' },
      { text: '깨진 주소', href: 'http://' },
      { text: '빈 주소', href: '' },
      { text: '주소 없음' },
      { text: '널 주소', href: null },
      anchor('진짜.pdf', { atchFileId: 'real' }),
    ];

    const files = parseEvidenceLinks(anchors);

    assert.deepEqual(
      files.map((file) => file.name),
      ['진짜.pdf'],
    );
  });

  const badParameters = [
    ['atchFileId is missing', '/busan/sw/cmmn/file/fileDown.do?fileSn=1'],
    ['fileSn is missing', '/busan/sw/cmmn/file/fileDown.do?atchFileId=abc'],
    ['fileSn is not a number', '/busan/sw/cmmn/file/fileDown.do?atchFileId=abc&fileSn=x'],
    ['atchFileId has a path separator', '/busan/sw/cmmn/file/fileDown.do?atchFileId=..%2Fetc&fileSn=1'],
    ['atchFileId has a backslash', '/busan/sw/cmmn/file/fileDown.do?atchFileId=a%5Cb&fileSn=1'],
    ['atchFileId has a dot', '/busan/sw/cmmn/file/fileDown.do?atchFileId=a.b&fileSn=1'],
    ['atchFileId is only dots', '/busan/sw/cmmn/file/fileDown.do?atchFileId=..&fileSn=1'],
    ['atchFileId has a space', '/busan/sw/cmmn/file/fileDown.do?atchFileId=a%20b&fileSn=1'],
    ['atchFileId has a colon, which the key format uses as its separator', '/busan/sw/cmmn/file/fileDown.do?atchFileId=a%3Ab&fileSn=1'],
    ['atchFileId is empty', '/busan/sw/cmmn/file/fileDown.do?atchFileId=&fileSn=1'],
  ];
  for (const [title, href] of badParameters) {
    it(`skips a link when ${title}`, () => {
      const anchors = [{ text: '파일.pdf', href }];

      const files = parseEvidenceLinks(anchors);

      assert.deepEqual(files, []);
    });
  }

  it('accepts an attachment id with hyphens, which the portal issues for some files', () => {
    const atchFileId = '00000000-0000-0000-0000-000000ab';

    const files = parseEvidenceLinks([anchor('내역서.pdf', { atchFileId })]);

    assert.deepEqual(
      files.map((file) => [file.key, file.atchFileId]),
      [[`${atchFileId}:1`, atchFileId]],
    );
  });

  it('keeps the first of two links with the same key and both of different keys', () => {
    const anchors = [
      anchor('처음.pdf', { atchFileId: 'same', fileSn: 1 }),
      anchor('중복.pdf', { atchFileId: 'same', fileSn: 1 }),
      anchor('두번째.pdf', { atchFileId: 'same', fileSn: 2 }),
    ];

    const files = parseEvidenceLinks(anchors);

    assert.deepEqual(
      files.map((file) => [file.key, file.name]),
      [
        ['same:1', '처음.pdf'],
        ['same:2', '두번째.pdf'],
      ],
    );
  });

  it('ignores array items that are not anchor objects', () => {
    const anchors = [null, undefined, 'x', 5, anchor('진짜.pdf', { atchFileId: 'real' })];

    const files = parseEvidenceLinks(anchors);

    assert.deepEqual(
      files.map((file) => file.name),
      ['진짜.pdf'],
    );
  });

  it('returns an empty list when the input is not an array', () => {
    assert.deepEqual(parseEvidenceLinks(undefined), []);
    assert.deepEqual(parseEvidenceLinks(null), []);
    assert.deepEqual(parseEvidenceLinks('x'), []);
  });

  it('does not modify the anchors it was given', () => {
    const anchors = Object.freeze([Object.freeze(anchor('7월.pdf', { container: 'file_list_new' }))]);

    const files = parseEvidenceLinks(anchors);

    assert.equal(files.length, 1);
  });
});

describe('parseEvidenceLinks container rule', () => {
  const cases = [
    ['file_list_new', true],
    ['file_list', true],
    ['attach file_list_x', true],
    ['', false],
    ['other_list', false],
    [undefined, true],
    [null, true],
  ];
  for (const [container, kept] of cases) {
    it(`${kept ? 'keeps' : 'drops'} an anchor whose container is ${JSON.stringify(container)}`, () => {
      const item = container === undefined ? anchor('a.pdf') : anchor('a.pdf', { container });

      const files = parseEvidenceLinks([item]);

      assert.equal(files.length, kept ? 1 : 0);
    });
  }
});

describe('parseEvidenceLinks file names and extensions', () => {
  const cases = [
    ['내역서.PDF', 'pdf'],
    ['내역서.docx', 'docx'],
    ['a.b.docx', 'docx'],
    ['확장자없음', 'bin'],
    ['x.abcdefg', 'bin'],
    ['끝점.', 'bin'],
  ];
  for (const [name, ext] of cases) {
    it(`reads the extension of ${JSON.stringify(name)} as ${ext}`, () => {
      const files = parseEvidenceLinks([anchor(name)]);

      assert.equal(files[0].ext, ext);
    });
  }

  it('trims the name and tolerates a missing anchor text', () => {
    const files = parseEvidenceLinks([
      anchor('  공백.pdf  ', { fileSn: 1 }),
      { href: hrefFor('abc123', 2) },
    ]);

    assert.deepEqual(
      files.map((file) => [file.name, file.ext, file.month]),
      [
        ['공백.pdf', 'pdf', null],
        ['', 'bin', null],
      ],
    );
  });
});
