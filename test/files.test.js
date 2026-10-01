import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { PARSER_VERSION } from '../portal/lib/amounts.js';
import { UserError } from '../portal/lib/errors.js';
import { ensurePdftext, extractText, readDownload } from '../portal/lib/files.js';
import { loadEvidenceFiles } from './helpers/fixtures.js';

const workRoot = mkdtempSync(path.join(os.tmpdir(), 'vas-files-'));
after(() => rmSync(workRoot, { recursive: true, force: true }));

const hasCommand = (command, args) => spawnSync(command, args, { stdio: 'ignore' }).status !== null;
const HAS_ZIP = hasCommand('zip', ['-v']) && hasCommand('unzip', ['-v']);
const NEEDS_ZIP = { skip: HAS_ZIP ? false : 'zip and unzip are not available' };

const READ_AT = new Date('2026-09-30T09:00:00.000Z');
const now = () => READ_AT;
const STATEMENT_XML = loadEvidenceFiles()['00000000-0000-0000-0000-000003ef:1'].xml;

let dir;
let counter = 0;
beforeEach(() => {
  counter += 1;
  dir = path.join(workRoot, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
});

function writeScript(name, body) {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function makeDocx(name, xml, part = 'word/document.xml') {
  const source = path.join(dir, `${name}-src`);
  mkdirSync(path.dirname(path.join(source, part)), { recursive: true });
  writeFileSync(path.join(source, part), xml);
  const out = path.join(dir, `${name}.docx`);
  execFileSync('zip', ['-q', '-r', out, '.'], { cwd: source });
  return out;
}

function fakePdftext(text = '=== page 1\n금액(VAT포함) 12,345원\n') {
  const textFile = path.join(dir, 'pdf-text.txt');
  writeFileSync(textFile, text);
  return writeScript('pdftext', `printf '%s\\n' "$1" > "$0.arg"\ncat "${textFile}"`);
}

function download(overrides = {}) {
  return {
    foundId: '2001',
    key: 'abc123:1',
    atchFileId: 'abc123',
    fileSn: '1',
    name: '내역서.docx',
    container: 'file_list_new',
    ext: 'docx',
    path: path.join(dir, 'abc123_1.docx'),
    ok: true,
    status: 200,
    contentType: 'application/octet-stream',
    ...overrides,
  };
}

describe('extractText', () => {
  it('reads the text of a docx and the amount can be found in it', NEEDS_ZIP, async () => {
    const file = makeDocx('statement', STATEMENT_XML);

    const result = await extractText(file, 'docx', {});

    assert.ok(result.text.includes('금액(VAT포함)'));
    assert.ok(result.text.includes('29,500원 (20$)'));
    assert.equal(result.reason, undefined);
  });

  it('accepts an upper-case extension', NEEDS_ZIP, async () => {
    const file = makeDocx('statement', STATEMENT_XML);

    const result = await extractText(file, 'DOCX', {});

    assert.ok(result.text.includes('금액(VAT포함)'));
  });

  it('reports a file that is not a zip archive as unreadable', NEEDS_ZIP, async () => {
    const file = path.join(dir, 'broken.docx');
    writeFileSync(file, '이건 zip이 아니다');

    const result = await extractText(file, 'docx', {});

    assert.equal(result.reason, 'unreadable');
    assert.equal(typeof result.detail, 'string');
    assert.equal(result.text, undefined);
  });

  it('reports a docx without the main document part as unreadable', NEEDS_ZIP, async () => {
    const file = makeDocx('other', '<x/>', 'word/other.xml');

    const result = await extractText(file, 'docx', {});

    assert.equal(result.reason, 'unreadable');
  });

  it('passes a dummy password so an encrypted member fails instead of asking on the terminal', async () => {
    const unzipBin = writeScript('unzip', `printf '%s\\n' "$*" > "${dir}/unzip-args"\nprintf '<w:p/>'`);
    const file = path.join(dir, 'x.docx');

    await extractText(file, 'docx', { unzipBin });

    assert.equal(readFileSync(path.join(dir, 'unzip-args'), 'utf8').trim(), `-p -P x ${file} word/document.xml`);
  });

  it('reports a password-protected docx as unreadable without asking for the password', NEEDS_ZIP, async () => {
    const source = path.join(dir, 'locked-src');
    mkdirSync(path.join(source, 'word'), { recursive: true });
    writeFileSync(path.join(source, 'word', 'document.xml'), STATEMENT_XML);
    const file = path.join(dir, 'locked.docx');
    execFileSync('zip', ['-q', '-r', '-P', 'a-real-password', file, '.'], { cwd: source });

    const result = await extractText(file, 'docx', {});

    assert.equal(result.reason, 'unreadable');
    assert.equal(result.text, undefined);
  });

  it('reports a missing file as unreadable', NEEDS_ZIP, async () => {
    const result = await extractText(path.join(dir, 'none.docx'), 'docx', {});

    assert.equal(result.reason, 'unreadable');
  });

  it('keeps the output of unzip when it only finished with a warning', async () => {
    const unzipBin = writeScript('unzip', `printf '<w:p><w:r><w:t>금액(VAT포함) 7,000원</w:t></w:r></w:p>'\nexit 1`);

    const result = await extractText(path.join(dir, 'x.docx'), 'docx', { unzipBin });

    assert.equal(result.text, '금액(VAT포함) 7,000원\n');
  });

  it('reports a warning exit with no output as unreadable', async () => {
    const unzipBin = writeScript('unzip', 'exit 1');

    const result = await extractText(path.join(dir, 'x.docx'), 'docx', { unzipBin });

    assert.equal(result.reason, 'unreadable');
  });

  it('reports a failure exit of unzip as unreadable even when it printed something', async () => {
    const unzipBin = writeScript('unzip', `printf 'partial'\nexit 11`);

    const result = await extractText(path.join(dir, 'x.docx'), 'docx', { unzipBin });

    assert.equal(result.reason, 'unreadable');
  });

  it('passes the file path to the pdf text tool and returns what it prints', async () => {
    const pdftextBin = fakePdftext();
    const file = path.join(dir, 'receipt.pdf');

    const result = await extractText(file, 'pdf', { pdftextBin });

    assert.equal(result.text, '=== page 1\n금액(VAT포함) 12,345원\n');
    assert.equal(readFileSync(`${pdftextBin}.arg`, 'utf8').trim(), file);
  });

  it('never passes the file name through a shell', async () => {
    const pdftextBin = fakePdftext();
    const injected = path.join(dir, 'injected');
    const file = `${dir}/a b; touch ${injected} #.pdf`;

    const result = await extractText(file, 'pdf', { pdftextBin });

    assert.equal(result.reason, undefined);
    assert.equal(readFileSync(`${pdftextBin}.arg`, 'utf8').trim(), file);
    assert.equal(existsSync(injected), false);
  });

  it('reports a pdf as unreadable when the text tool fails', async () => {
    const pdftextBin = writeScript('pdftext', `echo OPEN_FAIL >&2\nexit 1`);

    const result = await extractText(path.join(dir, 'receipt.pdf'), 'pdf', { pdftextBin });

    assert.equal(result.reason, 'unreadable');
    assert.match(result.detail, /OPEN_FAIL/);
  });

  it('reports an encrypted pdf as unreadable and keeps the reason the tool gave', async () => {
    const pdftextBin = writeScript('pdftext', `echo LOCKED >&2\nexit 3`);

    const result = await extractText(path.join(dir, 'receipt.pdf'), 'pdf', { pdftextBin });

    assert.equal(result.reason, 'unreadable');
    assert.match(result.detail, /LOCKED/);
  });

  it('reports a pdf as unreadable when no text tool is given', async () => {
    const result = await extractText(path.join(dir, 'receipt.pdf'), 'pdf', {});

    assert.equal(result.reason, 'unreadable');
  });

  it('reports every other extension as unsupported without touching the file', async () => {
    for (const ext of ['png', 'jpg', 'hwp', 'doc', 'bin', '', undefined, null]) {
      const result = await extractText(path.join(dir, 'missing-file'), ext, {});

      assert.deepEqual(result, { reason: 'unsupported' }, String(ext));
    }
  });
});

describe('ensurePdftext', () => {
  const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');
  const RECENTLY = new Date('2026-06-01T00:00:00.000Z');

  function makeFiles({ binary, source }) {
    const bin = path.join(dir, 'pdftext-bin');
    const swift = path.join(dir, 'pdftext.swift');
    if (binary) {
      writeFileSync(bin, 'old build');
      utimesSync(bin, binary, binary);
    }
    if (source) {
      writeFileSync(swift, '// 소스');
      utimesSync(swift, source, source);
    }
    return { bin, swift };
  }

  const workingCompiler = () => writeScript('swiftc', `printf '%s\\n' "$*" >> "${dir}/compiler-calls"\nprintf 'new build' > "$3"\nchmod +x "$3"`);
  const calls = () => (existsSync(path.join(dir, 'compiler-calls')) ? readFileSync(path.join(dir, 'compiler-calls'), 'utf8').trim().split('\n') : []);

  it('does nothing when the binary is newer than the source', async () => {
    const { bin, swift } = makeFiles({ binary: RECENTLY, source: LONG_AGO });

    const result = await ensurePdftext(bin, swift, { compiler: workingCompiler() });

    assert.equal(result, bin);
    assert.equal(readFileSync(bin, 'utf8'), 'old build');
    assert.deepEqual(calls(), []);
  });

  it('does nothing when the binary and the source have the same time', async () => {
    const { bin, swift } = makeFiles({ binary: RECENTLY, source: RECENTLY });

    await ensurePdftext(bin, swift, { compiler: workingCompiler() });

    assert.deepEqual(calls(), []);
  });

  it('keeps an existing binary when the source cannot be found to compare with', async () => {
    const { bin, swift } = makeFiles({ binary: RECENTLY, source: null });

    const result = await ensurePdftext(bin, swift, { compiler: workingCompiler() });

    assert.equal(result, bin);
    assert.deepEqual(calls(), []);
  });

  it('builds it again when the source is newer than the binary', async () => {
    const { bin, swift } = makeFiles({ binary: LONG_AGO, source: RECENTLY });

    const result = await ensurePdftext(bin, swift, { compiler: workingCompiler() });

    assert.equal(result, bin);
    assert.equal(readFileSync(bin, 'utf8'), 'new build');
    assert.equal(calls().length, 1);
  });

  it('builds it when the binary is missing, creating the folder it lives in', async () => {
    const bin = path.join(dir, 'nested', 'app', 'pdftext-bin');
    const swift = path.join(dir, 'pdftext.swift');

    const result = await ensurePdftext(bin, swift, { compiler: workingCompiler() });

    assert.equal(result, bin);
    assert.equal(readFileSync(bin, 'utf8'), 'new build');
  });

  it('compiles with optimization into a temporary file beside the binary and moves it into place', async () => {
    const { bin, swift } = makeFiles({ binary: null, source: RECENTLY });

    await ensurePdftext(bin, swift, { compiler: workingCompiler() });

    const [flagO, flagOut, output, source] = calls()[0].split(' ');
    assert.deepEqual([flagO, flagOut, source], ['-O', '-o', swift]);
    assert.equal(path.dirname(output), path.dirname(bin));
    assert.notEqual(output, bin);
    assert.ok(path.basename(output).startsWith(`${path.basename(bin)}.`));
    assert.equal(existsSync(output), false);
    assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith('pdftext-bin')), ['pdftext-bin']);
  });

  it('leaves no half-written binary behind when the compiler fails after writing some output', async () => {
    const { bin, swift } = makeFiles({ binary: null, source: RECENTLY });
    const compiler = writeScript('swiftc', `printf '반쯤' > "$3"\necho 'no swift here' >&2\nexit 1`);

    await assert.rejects(ensurePdftext(bin, swift, { compiler }), (error) => error instanceof UserError && error.message.includes('swiftc'));

    assert.equal(existsSync(bin), false);
    assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith('pdftext-bin')), []);
  });

  it('leaves no half-written binary behind when the compiler is killed midway', async () => {
    const { bin, swift } = makeFiles({ binary: null, source: RECENTLY });
    const compiler = writeScript('swiftc', `printf '반쯤' > "$3"\nkill -KILL $$`);

    await assert.rejects(ensurePdftext(bin, swift, { compiler }), UserError);

    assert.equal(existsSync(bin), false);
    assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith('pdftext-bin')), []);
  });

  it('keeps the old binary when building the new one fails', async () => {
    const { bin, swift } = makeFiles({ binary: LONG_AGO, source: RECENTLY });
    const compiler = writeScript('swiftc', `printf '반쯤' > "$3"\nexit 1`);

    await assert.rejects(ensurePdftext(bin, swift, { compiler }), UserError);

    assert.equal(readFileSync(bin, 'utf8'), 'old build');
    assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith('pdftext-bin')), ['pdftext-bin']);
  });

  it('explains what is needed when compiling fails', async () => {
    const compiler = writeScript('swiftc', `echo 'no swift here' >&2\nexit 1`);

    await assert.rejects(
      ensurePdftext(path.join(dir, 'pdftext-bin'), path.join(dir, 'pdftext.swift'), { compiler }),
      (error) => error instanceof UserError && error.message.includes('swiftc') && error.message.includes('no swift here'),
    );
  });

  it('fails when the compiler exits normally but leaves no binary', async () => {
    const compiler = writeScript('swiftc', 'exit 0');

    await assert.rejects(
      ensurePdftext(path.join(dir, 'pdftext-bin'), path.join(dir, 'pdftext.swift'), { compiler }),
      (error) => error instanceof UserError && error.message.includes('pdftext-bin'),
    );
  });

  it('fails clearly when the compiler is not installed', async () => {
    await assert.rejects(
      ensurePdftext(path.join(dir, 'pdftext-bin'), path.join(dir, 'pdftext.swift'), { compiler: path.join(dir, 'no-such-compiler') }),
      UserError,
    );
  });

  it('fails clearly when it cannot even tell whether the binary exists', async () => {
    const blocker = path.join(dir, 'a-file-not-a-folder');
    writeFileSync(blocker, '폴더가 아니다');
    const bin = path.join(blocker, 'pdftext-bin');

    await assert.rejects(
      ensurePdftext(bin, path.join(dir, 'pdftext.swift'), { compiler: workingCompiler() }),
      (error) => error instanceof UserError && error.message.includes(bin),
    );

    assert.deepEqual(calls(), []);
  });

  it('fails clearly when the binary cannot be moved into place', async () => {
    const bin = path.join(dir, 'pdftext-bin');
    mkdirSync(path.join(bin, 'blocker'), { recursive: true });
    const swift = path.join(dir, 'pdftext.swift');
    writeFileSync(swift, '// 소스');
    utimesSync(bin, LONG_AGO, LONG_AGO);

    await assert.rejects(ensurePdftext(bin, swift, { compiler: workingCompiler() }), (error) => error instanceof UserError && error.message.includes(bin));

    assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith('pdftext-bin.')), []);
  });
});

describe('readDownload', () => {
  it('reads a docx, returns the parsed amounts and deletes the file', NEEDS_ZIP, async () => {
    const file = makeDocx('abc123_1', STATEMENT_XML);
    const item = download({ path: file });

    const result = await readDownload(item, { downloadDir: dir, now });

    assert.equal(result.status, 'read');
    assert.equal(result.key, 'abc123:1');
    assert.equal(result.name, '내역서.docx');
    assert.equal(result.persist, true);
    assert.deepEqual(result.entry, {
      parserVersion: PARSER_VERSION,
      total: 29500,
      reason: 'ok',
      amounts: [{ krw: 29500 }],
      readAt: '2026-09-30T09:00:00.000Z',
    });
    assert.equal(existsSync(file), false);
  });

  it('stamps the read time from the real clock when none is given', async () => {
    const file = path.join(dir, 'abc123_1.png');
    writeFileSync(file, '영수증 사진');
    const before = Date.now();

    const result = await readDownload(download({ ext: 'png', path: file }), { downloadDir: dir });

    const readAt = Date.parse(result.entry.readAt);
    assert.ok(readAt >= before && readAt <= Date.now());
  });

  it('reads a pdf through the text tool and deletes the file', async () => {
    const file = path.join(dir, 'abc123_1.pdf');
    writeFileSync(file, '%PDF-가짜');

    const result = await readDownload(download({ ext: 'pdf', path: file }), {
      downloadDir: dir,
      pdftextBin: fakePdftext(),
      now,
    });

    assert.equal(result.entry.total, 12345);
    assert.equal(result.entry.reason, 'ok');
    assert.equal(existsSync(file), false);
  });

  it('does not keep a file with more amount labels than a statement can have, and says why', async () => {
    const file = path.join(dir, 'abc123_1.pdf');
    writeFileSync(file, '%PDF-가짜');
    const text = Array.from({ length: 60 }, () => '금액(VAT포함) 1,000원').join('\n');

    const result = await readDownload(download({ ext: 'pdf', path: file }), {
      downloadDir: dir,
      pdftextBin: fakePdftext(text),
      now,
    });

    assert.equal(result.status, 'read');
    assert.equal(result.entry.reason, 'unreadable');
    assert.equal(result.entry.total, null);
    assert.equal(result.persist, false);
    assert.match(result.detail, /50/);
    assert.equal(existsSync(file), false);
  });

  it('records a file without an amount label as no_label', async () => {
    const file = path.join(dir, 'abc123_1.pdf');
    writeFileSync(file, '%PDF-가짜');

    const result = await readDownload(download({ ext: 'pdf', path: file }), {
      downloadDir: dir,
      pdftextBin: fakePdftext('=== page 1\nAmount paid $20.00\n'),
      now,
    });

    assert.equal(result.entry.reason, 'no_label');
    assert.equal(result.persist, true);
  });

  it('keeps an unsupported file result and deletes the file', async () => {
    const file = path.join(dir, 'abc123_1.png');
    writeFileSync(file, '영수증 사진');

    const result = await readDownload(download({ ext: 'png', path: file }), { downloadDir: dir, now });

    assert.deepEqual(result.entry, {
      parserVersion: PARSER_VERSION,
      total: null,
      reason: 'unsupported',
      amounts: [],
      readAt: '2026-09-30T09:00:00.000Z',
    });
    assert.equal(result.persist, true);
    assert.equal(existsSync(file), false);
  });

  it('does not keep an unreadable result so the next run tries again, and deletes the file', NEEDS_ZIP, async () => {
    const file = path.join(dir, 'abc123_1.docx');
    writeFileSync(file, '이건 zip이 아니다');

    const result = await readDownload(download({ path: file }), { downloadDir: dir, now });

    assert.equal(result.status, 'read');
    assert.equal(result.entry.reason, 'unreadable');
    assert.equal(result.persist, false);
    assert.equal(typeof result.detail, 'string');
    assert.equal(existsSync(file), false);
  });

  it('treats a download the browser reported as failed as failed and deletes what it left', async () => {
    const file = path.join(dir, 'abc123_1.docx');
    writeFileSync(file, '에러 화면');

    const result = await readDownload(download({ path: file, ok: false, status: 500 }), { downloadDir: dir, now });

    assert.equal(result.status, 'failed');
    assert.match(result.message, /500/);
    assert.equal(result.entry, undefined);
    assert.equal(existsSync(file), false);
  });

  it('names the browser error when the download itself threw and left no file', async () => {
    const file = path.join(dir, 'abc123_1.pdf');

    const result = await readDownload(download({ ext: 'pdf', path: file, ok: false, status: 0, error: 'timeout 60000ms exceeded' }), {
      downloadDir: dir,
      now,
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.message, '받기에 실패했습니다 (timeout 60000ms exceeded)');
    assert.equal(existsSync(file), false);
  });

  it('treats an HTML response as failed even when the browser said ok', async () => {
    const file = path.join(dir, 'abc123_1.docx');
    writeFileSync(file, '<html>로그인</html>');

    const result = await readDownload(download({ path: file, contentType: 'text/html; charset=UTF-8' }), { downloadDir: dir, now });

    assert.equal(result.status, 'failed');
    assert.match(result.message, /HTML/);
    assert.equal(existsSync(file), false);
  });

  it('refuses a path outside the download folder and leaves that file alone', async () => {
    const outside = path.join(workRoot, `outside-${counter}.docx`);
    writeFileSync(outside, '남의 파일');
    const downloadDir = path.join(dir, 'downloads');
    mkdirSync(downloadDir);

    const result = await readDownload(download({ path: outside }), { downloadDir, now });

    assert.equal(result.status, 'failed');
    assert.equal(readFileSync(outside, 'utf8'), '남의 파일');
  });

  it('refuses a path that climbs out of the download folder', async () => {
    const outside = path.join(workRoot, `climb-${counter}.docx`);
    writeFileSync(outside, '남의 파일');
    const downloadDir = path.join(dir, 'downloads');
    mkdirSync(downloadDir);
    const climbing = path.join(downloadDir, '..', '..', path.basename(outside));

    const result = await readDownload(download({ path: climbing }), { downloadDir, now });

    assert.equal(result.status, 'failed');
    assert.equal(existsSync(outside), true);
  });

  it('reads a file whose attachment id has hyphens', async () => {
    const file = path.join(dir, '00000000-0000-0000-0000-000000ab_1.png');
    writeFileSync(file, '영수증 사진');

    const result = await readDownload(download({ key: '00000000-0000-0000-0000-000000ab:1', ext: 'png', path: file }), {
      downloadDir: dir,
      now,
    });

    assert.equal(result.status, 'read');
    assert.equal(result.key, '00000000-0000-0000-0000-000000ab:1');
    assert.equal(existsSync(file), false);
  });

  it('refuses a key that could climb out of a path or break the key format', () => {
    const unsafeKeys = ['../x:1', 'a/b:1', 'a\\b:1', 'a.b:1', 'a b:1', ':1', 'a:b:1', 'abc:', 'abc:x'];

    return Promise.all(
      unsafeKeys.map(async (key) => {
        const result = await readDownload(download({ key }), { downloadDir: dir, now });

        assert.equal(result.status, 'failed', key);
      }),
    );
  });

  it('refuses a download record with a malformed key or without a path', async () => {
    for (const overrides of [{ key: '../x:1' }, { key: 'abc' }, { key: undefined }, { path: undefined }, { path: 5 }]) {
      const result = await readDownload(download(overrides), { downloadDir: dir, now });

      assert.equal(result.status, 'failed', JSON.stringify(overrides));
    }
  });

  it('refuses a record that is missing altogether', async () => {
    for (const record of [undefined, null]) {
      const result = await readDownload(record, { downloadDir: dir, now });

      assert.equal(result.status, 'failed');
      assert.equal(result.key, '');
      assert.equal(result.name, '');
    }
  });

  it('says the status is unknown when a failed download carries none', async () => {
    const file = path.join(dir, 'abc123_1.docx');
    writeFileSync(file, '에러');

    const result = await readDownload(download({ path: file, ok: false, status: undefined }), { downloadDir: dir, now });

    assert.equal(result.status, 'failed');
    assert.match(result.message, /알 수 없음/);
  });

  it('reads a file whose record has no content type and no name', async () => {
    const file = path.join(dir, 'abc123_1.png');
    writeFileSync(file, '영수증 사진');

    const result = await readDownload(download({ ext: 'png', path: file, contentType: undefined, name: undefined }), {
      downloadDir: dir,
      now,
    });

    assert.equal(result.status, 'read');
    assert.equal(result.name, '');
    assert.equal(result.entry.reason, 'unsupported');
  });

  it('deletes the file even when reading it throws unexpectedly', async () => {
    const file = path.join(dir, 'abc123_1.png');
    writeFileSync(file, '영수증 사진');

    await assert.rejects(
      readDownload(download({ ext: 'png', path: file }), {
        downloadDir: dir,
        now: () => {
          throw new Error('시계 고장');
        },
      }),
      /시계 고장/,
    );

    assert.equal(existsSync(file), false);
  });
});
