import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { buildBrowserScript, resolveEgoBrowser, runBrowser } from '../portal/lib/browser.js';
import { UserError } from '../portal/lib/errors.js';

const workRoot = mkdtempSync(path.join(os.tmpdir(), 'vas-browser-'));
after(() => rmSync(workRoot, { recursive: true, force: true }));

const PREFIX = 'const INPUT = ';
const READ_PORTAL = new URL('../portal/read-portal.js', import.meta.url);

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

describe('buildBrowserScript', () => {
  const input = {
    baseUrl: 'https://portal.example.test/busan/sw',
    menuNo: '200054',
    knownFiles: ['abc:1', 'abc:2'],
    maxListPages: 20,
    spaceName: '활동비 "포털" 동기화\n두 줄',
  };

  it('starts with the INPUT constant and keeps the source after the first line', () => {
    const source = "console.log('본문');\n";

    const script = buildBrowserScript(source, input);

    assert.ok(script.startsWith(PREFIX));
    assert.ok(script.endsWith(`;\n${source}`));
    assert.equal(script.split('\n')[1], "console.log('본문');");
  });

  it('writes the input as JSON that reads back unchanged', () => {
    const script = buildBrowserScript('x', input);

    const firstLine = script.split('\n')[0];
    const parsed = JSON.parse(firstLine.slice(PREFIX.length, -1));

    assert.deepEqual(parsed, input);
  });

  it('keeps the input on one line whatever characters it holds', () => {
    const tricky = { text: 'a\nb\r\nc \u2028 \u2029 </script> "따옴표" \\ 역슬래시' };

    const script = buildBrowserScript('x', tricky);

    const firstLine = script.split('\n')[0];
    assert.deepEqual(JSON.parse(firstLine.slice(PREFIX.length, -1)), tricky);
  });

  it('does not modify the input', () => {
    const frozen = Object.freeze({ ...input, knownFiles: Object.freeze([...input.knownFiles]) });

    const script = buildBrowserScript('x', frozen);

    assert.ok(script.includes('abc:1'));
  });

  it('turns the real read-portal source into a script that is valid module code', () => {
    const source = readFileSync(READ_PORTAL, 'utf8');
    const file = path.join(dir, 'combined.mjs');
    writeFileSync(file, buildBrowserScript(source, input));

    const run = () => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });

    assert.doesNotThrow(run);
  });
});

describe('resolveEgoBrowser', () => {
  const home = '/home/tester';
  const fallback = '/home/tester/.local/bin/ego-browser';

  it('takes the first PATH entry that holds an executable ego-browser', () => {
    const isExecutable = (file) => file === '/opt/a/ego-browser' || file === '/opt/b/ego-browser';

    const found = resolveEgoBrowser({ env: { PATH: '/usr/bin:/opt/a:/opt/b' }, home, isExecutable });

    assert.equal(found, '/opt/a/ego-browser');
  });

  it('falls back to the local bin folder in the home directory', () => {
    const isExecutable = (file) => file === fallback;

    const found = resolveEgoBrowser({ env: { PATH: '/usr/bin:/opt/a' }, home, isExecutable });

    assert.equal(found, fallback);
  });

  it('works when PATH is missing or has empty entries', () => {
    const isExecutable = (file) => file === fallback;

    assert.equal(resolveEgoBrowser({ env: {}, home, isExecutable }), fallback);
    assert.equal(resolveEgoBrowser({ env: { PATH: '::/usr/bin:' }, home, isExecutable }), fallback);
  });

  it('prefers PATH over the fallback', () => {
    const isExecutable = () => true;

    const found = resolveEgoBrowser({ env: { PATH: '/opt/a' }, home, isExecutable });

    assert.equal(found, '/opt/a/ego-browser');
  });

  it('fails with a message that names the fallback location when it finds nothing', () => {
    assert.throws(
      () => resolveEgoBrowser({ env: { PATH: '/usr/bin' }, home, isExecutable: () => false }),
      (error) => error instanceof UserError && error.message.includes(fallback),
    );
  });

  it('checks the real file system by default', () => {
    const bin = writeScript('ego-browser', 'exit 0');

    const found = resolveEgoBrowser({ env: { PATH: dir }, home: path.join(dir, 'no-home') });

    assert.equal(found, bin);
  });

  it('does not accept a file that is not executable', () => {
    writeFileSync(path.join(dir, 'ego-browser'), 'not executable');

    assert.throws(() => resolveEgoBrowser({ env: { PATH: dir }, home: path.join(dir, 'no-home') }), UserError);
  });
});

describe('runBrowser', () => {
  it('feeds the script on standard input, passes nodejs as the only argument and returns the results', async () => {
    const bin = writeScript('ego', `cat > "$0.stdin"\nprintf '%s' "$*" > "$0.args"\necho 결과\necho 경고 >&2\nexit 3`);
    const script = 'const INPUT = {"메모":"한글"};\nconsole.log(1);\n';

    const result = await runBrowser(script, { bin, timeoutMs: 10_000 });

    assert.equal(result.code, 3);
    assert.equal(result.stdout, '결과\n');
    assert.equal(result.stderr, '경고\n');
    assert.equal(result.timedOut, false);
    assert.equal(result.aborted, false);
    assert.equal(readFileSync(`${bin}.stdin`, 'utf8'), script);
    assert.equal(readFileSync(`${bin}.args`, 'utf8'), 'nodejs');
  });

  it('reports a clean exit', async () => {
    const bin = writeScript('ego', 'cat > /dev/null\nexit 0');

    const result = await runBrowser('x', { bin });

    assert.equal(result.code, 0);
  });

  it('delivers a large script without stalling', async () => {
    const bin = writeScript('ego', `cat > "$0.stdin"\nexit 0`);
    const script = `${'가나다라마바사'.repeat(300_000)}\n`;

    const result = await runBrowser(script, { bin, timeoutMs: 20_000 });

    assert.equal(result.code, 0);
    assert.equal(readFileSync(`${bin}.stdin`, 'utf8').length, script.length);
  });

  it('returns the exit code of a child that quit without reading its input', async () => {
    const bin = writeScript('ego', 'exit 5');
    const script = `${'가'.repeat(2_000_000)}\n`;

    const result = await runBrowser(script, { bin, timeoutMs: 20_000 });

    assert.equal(result.code, 5);
  });

  it('stops a child that runs past the time limit and says so', async () => {
    const bin = writeScript('ego', 'exec sleep 30');
    const startedAt = Date.now();

    const result = await runBrowser('x', { bin, timeoutMs: 200 });

    assert.equal(result.timedOut, true);
    assert.equal(result.code, null);
    assert.ok(Date.now() - startedAt < 10_000);
  });

  it('stops a child when the caller aborts and says so', async () => {
    const bin = writeScript('ego', 'exec sleep 30');
    const controller = new AbortController();
    const startedAt = Date.now();

    const pending = runBrowser('x', { bin, signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    const result = await pending;

    assert.equal(result.aborted, true);
    assert.equal(result.timedOut, false);
    assert.ok(Date.now() - startedAt < 10_000);
  });

  it('does not hang when the signal was already aborted', async () => {
    const bin = writeScript('ego', 'exec sleep 30');
    const controller = new AbortController();
    controller.abort();

    const result = await runBrowser('x', { bin, signal: controller.signal, timeoutMs: 10_000 });

    assert.equal(result.aborted, true);
  });

  it('fails with the path when the program cannot be started', async () => {
    const bin = path.join(dir, 'no-such-browser');

    await assert.rejects(
      runBrowser('x', { bin }),
      (error) => error instanceof UserError && error.message.includes(bin),
    );
  });
});
