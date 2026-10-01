import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UserError } from './errors.js';

const BIN_NAME = 'ego-browser';
const BIN_ARGS = ['nodejs'];

// ego-browser는 셸 환경 변수를 스크립트에 넘겨주지 않아서, 입력을 상수로 스크립트 앞에 붙인다(portal/read-portal.js 머리말).
// JSON.stringify는 개행을 이스케이프하므로 첫 줄에 한 줄로 들어간다.
export function buildBrowserScript(source, input) {
  return `const INPUT = ${JSON.stringify(input)};\n${source}`;
}

function isExecutableFile(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function resolveEgoBrowser({ env = process.env, home = os.homedir(), isExecutable = isExecutableFile } = {}) {
  const fromPath = (env.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => entry !== '')
    .map((entry) => path.join(entry, BIN_NAME));
  const fallback = path.join(home, '.local', 'bin', BIN_NAME);
  const found = [...fromPath, fallback].find((candidate) => isExecutable(candidate));
  if (found === undefined) {
    throw new UserError(`ego-browser를 찾지 못했습니다. PATH 또는 ${fallback}에 설치되어 있어야 합니다.`);
  }
  return found;
}

function armTimeout(child, timeoutMs, onTimeout) {
  if (!(timeoutMs > 0)) return undefined;
  return setTimeout(() => {
    onTimeout();
    child.kill('SIGKILL');
  }, timeoutMs);
}

export function runBrowser(scriptText, { timeoutMs, signal, bin } = {}) {
  const command = bin ?? resolveEgoBrowser();
  return new Promise((resolve, reject) => {
    const child = spawn(command, BIN_ARGS, { stdio: ['pipe', 'pipe', 'pipe'], signal });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const timer = armTimeout(child, timeoutMs, () => {
      timedOut = true;
    });

    const settle = (finish, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish(value);
    };

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    // 자식이 입력을 다 읽기 전에 끝나면 EPIPE가 난다. 실패 원인은 종료 코드와 stderr에 담겨 오므로 여기서는 무시한다.
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      if (error.name === 'AbortError') {
        aborted = true;
        return;
      }
      settle(reject, new UserError(`ego-browser를 실행하지 못했습니다 (${command}): ${error.message}`, { cause: error }));
    });
    child.on('close', (code, exitSignal) => {
      settle(resolve, {
        code,
        signal: exitSignal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        aborted,
      });
    });
    child.stdin.end(scriptText);
  });
}
