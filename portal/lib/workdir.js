import fs from 'node:fs/promises';
import path from 'node:path';

// 실행마다 임시 폴더를 이 접두사로 만든다. 증빙 파일(카드 영수증)이 이 폴더에 내려받아진다.
export const TEMP_PREFIX = 'velocity-sync-';

function isOwnedBy(info, uid) {
  return uid === undefined || info.uid === uid;
}

async function removeOne(folder, log) {
  try {
    await fs.rm(folder, { recursive: true, force: true });
    return true;
  } catch (error) {
    log(`이전 실행이 남긴 임시 폴더를 지우지 못했습니다 (${folder}): ${error.message}`);
    return false;
  }
}

async function listEntries(tmpDir) {
  try {
    return await fs.readdir(tmpDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

// 강제로 끝난 실행은 finally를 거치지 못해 영수증이 든 임시 폴더를 남긴다. 다음 실행이 잠금을 잡은 뒤 치운다.
// 잠금이 있으므로 지금 이 폴더들을 쓰는 다른 실행은 없다. 링크는 따라가지 않고, 남의 폴더는 건드리지 않는다.
export async function removeLeftoverWorkDirs(tmpDir, { log = () => {}, uid = process.getuid?.() } = {}) {
  const entries = await listEntries(tmpDir);
  const candidates = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(TEMP_PREFIX));
  const removed = [];
  for (const entry of candidates) {
    const folder = path.join(tmpDir, entry.name);
    if (!isOwnedBy(await fs.lstat(folder), uid)) continue;
    if (await removeOne(folder, log)) removed.push(entry.name);
  }
  if (removed.length > 0) log(`이전 실행이 남긴 임시 폴더 ${removed.length}개를 지웠습니다.`);
  return removed;
}
