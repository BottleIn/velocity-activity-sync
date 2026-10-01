// 증빙 파일에는 카드 영수증이 들어 있다. 내려받은 파일과 읽은 결과가 실수로 커밋되지 않는지 git이 실제로 무시하는지로 확인한다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function git(args) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

const inWorkTree = git(['rev-parse', '--is-inside-work-tree']).stdout?.trim() === 'true';
const NEEDS_GIT = { skip: inWorkTree ? false : 'not inside a git work tree' };

// --no-index: 이미 추적 중인 파일이어도 규칙만으로 판정한다. 종료 코드 0이 무시됨, 1이 무시되지 않음이다.
function isIgnored(file) {
  const { status, stderr } = git(['check-ignore', '--no-index', '-q', file]);
  assert.ok(status === 0 || status === 1, `git check-ignore failed: ${stderr}`);
  return status === 0;
}

describe('.gitignore keeps evidence files and what was read from them out of the repository', () => {
  const ignored = [
    '증빙.pdf',
    'portal/내려받음.pdf',
    '증빙.docx',
    'downloads/deep/내역서.docx',
    'state.json',
    'portal/state.json',
    'portal-output.json',
    'tmp/portal-output.json',
    'pdftext',
    'portal/pdftext',
  ];
  for (const file of ignored) {
    it(`ignores ${file}`, NEEDS_GIT, () => {
      assert.equal(isIgnored(file), true);
    });
  }

  const tracked = [
    'portal/pdftext.swift',
    'portal/read-portal.js',
    'package.json',
    'test/fixtures/portal-output.json',
    'test/fixtures/evidence-files.json',
  ];
  for (const file of tracked) {
    it(`does not ignore ${file}, which belongs in the repository`, NEEDS_GIT, () => {
      assert.equal(isIgnored(file), false);
    });
  }

  it('still ignores the credentials it ignored before', NEEDS_GIT, () => {
    for (const file of ['.env', 'credentials.json', '.clasprc.json', 'x.token']) {
      assert.equal(isIgnored(file), true, file);
    }
  });
});
