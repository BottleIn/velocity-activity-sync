// portal/sync.js를 진짜 프로그램으로 띄우고 실행 도중에 신호를 보낸다. 터미널을 닫거나(SIGHUP) Ctrl-C(SIGINT)를 누르거나
// kill(SIGTERM)해도 영수증이 든 임시 폴더와 잠금 폴더가 남지 않아야 한다.
// ego-browser 자리에는 파일을 만들어 시작을 알린 뒤 멈춰 있는 가짜를 둔다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXIT } from '../portal/lib/errors.js';
import { LOCK_DIR } from '../portal/lib/state.js';
import { writeScript } from './helpers/sync-harness.js';

const SYNC_SCRIPT = fileURLToPath(new URL('../portal/sync.js', import.meta.url));
const START_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 20_000;
const POLL_MS = 20;
// 신호가 제대로 처리되지 않아 가짜 브라우저가 고아로 남아도 스스로 끝나도록 짧게 잡는다.
const HANG_SECONDS = 60;

const workRoot = mkdtempSync(path.join(os.tmpdir(), 'vas-signals-'));
after(() => rmSync(workRoot, { recursive: true, force: true }));

let root;
let counter = 0;
beforeEach(() => {
  counter += 1;
  root = path.join(workRoot, `case-${counter}`);
  mkdirSync(root, { recursive: true });
});

async function waitUntil(condition, timeoutMs, describeFailure) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`시간 안에 조건이 채워지지 않았습니다: ${describeFailure()}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function startProgram() {
  const binDir = path.join(root, 'bin');
  const tmp = path.join(root, 'tmp');
  const appHome = path.join(root, 'home');
  const marker = path.join(root, 'browser-started');
  mkdirSync(tmp, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeScript(binDir, 'ego-browser', `cat > /dev/null\n: > "${marker}"\nexec sleep ${HANG_SECONDS}`);
  const child = spawn(process.execPath, [SYNC_SCRIPT], {
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, VELOCITY_SYNC_HOME: appHome, TMPDIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => (output.stdout += chunk));
  child.stderr.on('data', (chunk) => (output.stderr += chunk));
  const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  return { child, closed, output, tmp, appHome, marker };
}

// 시간 안에 끝나지 않으면 실패로 만든다. 타이머는 끝나면 반드시 치워서, 시험이 끝난 뒤에도 프로세스를 붙잡지 않게 한다.
async function within(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message())), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopWith(signal) {
  const program = startProgram();
  try {
    await waitUntil(() => existsSync(program.marker), START_TIMEOUT_MS, () => program.output.stderr);
    program.child.kill(signal);
    const exit = await within(program.closed, EXIT_TIMEOUT_MS, () => `${signal} 뒤에도 끝나지 않았습니다: ${program.output.stderr}`);
    return { ...program, exit };
  } finally {
    program.child.kill('SIGKILL');
  }
}

describe('portal/sync.js stopped by a signal while the browser is running', () => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    it(`exits with the interrupted code on ${signal} and leaves no working folder or lock`, async () => {
      const { exit, output, tmp, appHome } = await stopWith(signal);

      assert.deepEqual(exit, { code: EXIT.INTERRUPTED, signal: null }, output.stderr);
      assert.match(output.stderr, /중단되었습니다/);
      assert.equal(output.stdout, '');
      assert.deepEqual(readdirSync(tmp), []);
      assert.equal(existsSync(path.join(appHome, LOCK_DIR)), false);
    });
  }
});
