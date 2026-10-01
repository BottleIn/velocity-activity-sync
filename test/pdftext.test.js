// portal/pdftext.swift를 진짜 swiftc로 만들어 진짜 PDF에 돌려 본다. macOS의 PDFKit이 필요하다.
// swiftc가 없으면 건너뛴다. 만들고 돌리는 데 몇 초 걸린다.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { extractText, ensurePdftext, readDownload } from '../portal/lib/files.js';

const execFileAsync = promisify(execFile);
const PDFTEXT_SOURCE = fileURLToPath(new URL('../portal/pdftext.swift', import.meta.url));
const GENERATOR_SOURCE = fileURLToPath(new URL('./helpers/make-test-pdfs.swift', import.meta.url));

const hasSwift = process.platform === 'darwin' && spawnSync('swiftc', ['--version'], { stdio: 'ignore' }).status === 0;
const NEEDS_SWIFT = { skip: hasSwift ? false : 'swiftc or PDFKit is not available' };

const workRoot = mkdtempSync(path.join(os.tmpdir(), 'vas-pdftext-'));
after(() => rmSync(workRoot, { recursive: true, force: true }));

const plainPdf = path.join(workRoot, 'plain.pdf');
const lockedPdf = path.join(workRoot, 'locked.pdf');
const junkPdf = path.join(workRoot, 'junk.pdf');
const pdftextBin = path.join(workRoot, 'bin', 'pdftext');

before(async () => {
  if (!hasSwift) return;
  mkdirSync(path.join(workRoot, 'bin'), { recursive: true });
  const generator = path.join(workRoot, 'bin', 'make-test-pdfs');
  await execFileAsync('swiftc', ['-O', '-o', generator, GENERATOR_SOURCE], { timeout: 5 * 60_000 });
  await execFileAsync(generator, [plainPdf, lockedPdf]);
  writeFileSync(junkPdf, '이건 PDF가 아니다');
  await ensurePdftext(pdftextBin, PDFTEXT_SOURCE);
});

function run(args) {
  return spawnSync(pdftextBin, args, { encoding: 'utf8' });
}

describe('portal/pdftext.swift compiled with the real swiftc', () => {
  it('is built by ensurePdftext into the requested path', NEEDS_SWIFT, () => {
    assert.ok(existsSync(pdftextBin));
  });

  it('prints the text of each page after a page marker', NEEDS_SWIFT, () => {
    const result = run([plainPdf]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /^=== page 1\n/);
    assert.ok(result.stdout.includes('Amount test 1000'));
  });

  it('exits with 3 and says LOCKED for a pdf that needs a password, printing no page', NEEDS_SWIFT, () => {
    const result = run([lockedPdf]);

    assert.equal(result.status, 3);
    assert.match(result.stderr, /LOCKED/);
    assert.equal(result.stdout, '');
  });

  it('exits with 1 and says OPEN_FAIL for a file that is not a pdf', NEEDS_SWIFT, () => {
    const result = run([junkPdf]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /OPEN_FAIL/);
  });

  it('exits with 2 and shows the usage when the arguments are wrong', NEEDS_SWIFT, () => {
    assert.equal(run([]).status, 2);
    assert.equal(run([plainPdf, plainPdf]).status, 2);
    assert.match(run([]).stderr, /usage/);
  });

  it('turns a locked pdf into an unreadable file instead of an empty one without a label', NEEDS_SWIFT, async () => {
    const result = await extractText(lockedPdf, 'pdf', { pdftextBin });

    assert.equal(result.reason, 'unreadable');
    assert.match(result.detail, /LOCKED/);
  });

  it('does not cache a locked pdf, so it is looked at again on the next run', NEEDS_SWIFT, async () => {
    const copy = path.join(workRoot, 'download', 'abc123_1.pdf');
    mkdirSync(path.dirname(copy), { recursive: true });
    writeFileSync(copy, spawnSync('cat', [lockedPdf]).stdout);
    const download = { key: 'abc123:1', name: '내역서.pdf', ext: 'pdf', path: copy, ok: true, status: 200, contentType: 'application/pdf' };

    const result = await readDownload(download, { downloadDir: path.dirname(copy), pdftextBin });

    assert.equal(result.entry.reason, 'unreadable');
    assert.equal(result.persist, false);
    assert.match(result.detail, /LOCKED/);
  });
});
