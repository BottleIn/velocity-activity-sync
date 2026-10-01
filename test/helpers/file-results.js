import { FILE_REASON, PARSER_VERSION, docxXmlToText, extractAmounts } from '../../portal/lib/amounts.js';
import { loadEvidenceFiles } from './fixtures.js';

const READ_AT = '2026-09-30T09:01:00.000Z';

function entry(reason, total, amounts) {
  return { parserVersion: PARSER_VERSION, total, reason, amounts, readAt: READ_AT };
}

// 실제 파서가 남기는 모양대로, 원화로 읽은 값에는 raw를 붙이지 않는다.
export function fileOk(total) {
  return entry(FILE_REASON.OK, total, [{ krw: total }]);
}

export function fileNotKrw(...raws) {
  return entry(
    FILE_REASON.NOT_KRW,
    null,
    raws.map((raw) => ({ raw, krw: null })),
  );
}

export function fileNoLabel() {
  return entry(FILE_REASON.NO_LABEL, null, []);
}

export function fileUnreadable() {
  return entry(FILE_REASON.UNREADABLE, null, []);
}

export function fileUnsupported() {
  return entry(FILE_REASON.UNSUPPORTED, null, []);
}

// 가짜 증빙 파일 글자(test/fixtures/evidence-files.json)를 실제 파서로 읽은 결과를 만든다.
export function fixtureFileResults() {
  return Object.fromEntries(
    Object.entries(loadEvidenceFiles()).map(([key, file]) => {
      const text = file.kind === 'docx' ? docxXmlToText(file.xml) : file.text;
      const { total, reason, amounts } = extractAmounts(text);
      return [key, entry(reason, total, amounts)];
    }),
  );
}
