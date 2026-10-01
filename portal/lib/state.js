import fs from 'node:fs';
import path from 'node:path';

import { UserError } from './errors.js';

export const STATE_FILE = 'state.json';
export const LOCK_DIR = 'lock';
export const LOCK_OWNER_FILE = 'pid';
const PROCESS_ID = /^[1-9]\d{0,9}$/;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const RESET_HINT = '이 파일을 지우면 증빙 파일을 처음부터 다시 받아 읽습니다.';

function emptyState() {
  return { files: {}, lastReadAt: null };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// 저장된 결과가 깨졌을 때 조용히 비우고 다시 받지 않는다. 원인을 모른 채 넘어가지 않고 사람이 확인하게 한다.
export function loadState(dir) {
  const file = path.join(dir, STATE_FILE);
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw new UserError(`저장된 상태 파일을 읽지 못했습니다 (${file}): ${error.message}`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new UserError(`상태 파일이 올바른 JSON이 아닙니다 (${file}). ${RESET_HINT} ${error.message}`, { cause: error });
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.files)) {
    throw new UserError(`상태 파일의 형식이 올바르지 않습니다 (${file}). ${RESET_HINT}`);
  }
  return { ...emptyState(), ...parsed };
}

// 임시 파일에 쓴 뒤 rename으로 바꿔서, 쓰다가 멈춰도 state.json이 반쯤 쓰인 채로 남지 않게 한다.
export function saveState(dir, state) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const target = path.join(dir, STATE_FILE);
  const temp = path.join(dir, `${STATE_FILE}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: FILE_MODE });
    fs.chmodSync(temp, FILE_MODE);
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw new UserError(`상태 파일을 저장하지 못했습니다 (${target}): ${error.message}`, { cause: error });
  }
}

export function currentFiles(state, parserVersion) {
  return Object.fromEntries(
    Object.entries(state.files).filter(([, entry]) => entry !== null && entry?.parserVersion === parserVersion),
  );
}

// 없으면 만들고 있으면 실패하는 mkdir를 잠금으로 쓴다. 두 실행이 동시에 잠금을 잡는 일이 없다.
// 잠금 폴더 안에 주인의 프로세스 번호를 적어 둔다. 프로세스가 강제로 끝나 폴더가 남아도, 그 번호의 프로세스가
// 더는 없으면 낡은 잠금으로 보고 치운 뒤 이어서 잡는다. 번호를 알 수 없거나 아직 살아 있으면 지우지 않는다.
// 두 실행이 동시에 같은 낡은 잠금을 치우는 경우는 다루지 않는다.

// signal 0은 신호를 보내지 않고 프로세스가 있는지만 확인한다. 없다는 답(ESRCH)만 "죽었다"로 본다.
// 권한이 없다는 답(EPERM)은 프로세스가 있다는 뜻이고, 그 밖의 실패는 확실하지 않으므로 살아 있는 것으로 둔다.
export function isProcessAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function ownerOf(lockPath) {
  const file = path.join(lockPath, LOCK_OWNER_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new UserError(`잠금 폴더의 주인 정보를 읽지 못했습니다 (${file}): ${error.message}. 실행 중인 것이 없다면 잠금 폴더를 지운 뒤 다시 실행하세요.`, {
      cause: error,
    });
  }
  return PROCESS_ID.test(text) ? Number(text) : null;
}

function busyError(lockPath, pid) {
  const owner = pid === null ? '' : `프로세스 ${pid}, `;
  return new UserError(
    `이미 다른 동기화가 실행 중입니다 (${owner}잠금 폴더: ${lockPath}). 실행 중인 것이 없다면 이 폴더를 지운 뒤 다시 실행하세요.`,
  );
}

function tryMkdir(lockPath) {
  try {
    fs.mkdirSync(lockPath);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

// 첫 시도가 막히면 주인을 살펴보고, 죽은 주인의 잠금만 치운 뒤 한 번 더 시도한다.
// 두 번째도 막히면 주인이 살아 있거나 그 사이 다른 실행이 잡은 것이므로 실행 중인 것으로 알린다.
function acquire(lockPath, isAlive) {
  if (tryMkdir(lockPath)) return;
  const pid = ownerOf(lockPath);
  if (pid !== null && !isAlive(pid)) fs.rmSync(lockPath, { recursive: true, force: true });
  if (!tryMkdir(lockPath)) throw busyError(lockPath, ownerOf(lockPath));
}

export async function withLock(dir, task, { isAlive = isProcessAlive } = {}) {
  const lockPath = path.join(dir, LOCK_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  acquire(lockPath, isAlive);
  try {
    // 주인을 적는 데 실패해도 finally가 잠금을 치우도록 try 안에서 쓴다.
    fs.writeFileSync(path.join(lockPath, LOCK_OWNER_FILE), String(process.pid));
    return await task();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}
