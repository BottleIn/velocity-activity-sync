import { readFileSync } from 'node:fs';

// 시험마다 새로 읽어서 돌려준다. 시험끼리 같은 객체를 공유하다가 서로의 변경에 영향받지 않게 하려는 것이다.
function readFixture(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
}

export function loadPortalOutput() {
  return readFixture('portal-output.json');
}

export function loadEvidenceFiles() {
  return readFixture('evidence-files.json');
}
