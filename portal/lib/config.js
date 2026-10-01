import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UserError } from './errors.js';

export const APP_NAME = 'velocity-activity-sync';
export const CONFIG_FILE = 'config.json';
const HOME_ENV = 'VELOCITY_SYNC_HOME';
// 앞에 0이 붙은 달("07")은 받지 않는다. 숫자 7로 이 표를 찾으면 키 "7"만 맞고 "07"은 맞지 않아, 적어 둔 달이 매핑에서 빠진다.
const MONTH_KEY = /^(?:[1-9]|1[0-2])$/;

// 12월은 일부러 뺐다. 12월 증빙은 차수를 정하지 못한 결제로 경고에 올라온다.
const MONTH_TO_ROUND = Object.freeze({ 7: 1, 8: 2, 9: 3, 10: 4, 11: 5 });

export const DEFAULT_CONFIG = Object.freeze({
  baseUrl: 'https://www.swmaestro.ai/busan/sw',
  menuNo: '200054',
  spaceName: '활동비 포털 동기화',
  limit: 12000000,
  monthToRound: MONTH_TO_ROUND,
  maxListPages: 20,
  navTimeoutMs: 30000,
  fileTimeoutMs: 60000,
});

export function roundsOf(monthToRound) {
  return [...new Set(Object.values(monthToRound))].sort((a, b) => a - b);
}

export const DEFAULT_ROUNDS = Object.freeze(roundsOf(MONTH_TO_ROUND));

export function appDir(env = process.env, home = os.homedir()) {
  return env[HOME_ENV] || path.join(home, 'Library', 'Application Support', APP_NAME);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

// 로그인된 브라우저가 요청을 보내는 주소이므로 암호화되지 않은 http는 받지 않는다.
function isHttpsUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isMonthToRound(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  const rounds = entries.map(([, round]) => round);
  const isValidEntry = ([month, round]) => MONTH_KEY.test(month) && isPositiveInteger(round);
  return entries.length > 0 && entries.every(isValidEntry) && new Set(rounds).size === rounds.length;
}

const JIRA_KEYS = ['site', 'projectKey', 'issueTypeId', 'epicKey', 'fields', 'authors', 'links'];
const JIRA_FIELD_NAMES = ['actual', 'requested', 'paidDate', 'status', 'item', 'method', 'appliedDate', 'evidence'];

// Jira 사이트, 필드 id, 팀원 accountId는 공개 저장소에 두지 않으려고 이 Mac의 설정 파일에만 둔다.
function isJiraConfig(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!JIRA_KEYS.every((key) => Object.hasOwn(value, key))) return false;
  const fields = value.fields;
  return (
    fields !== null &&
    typeof fields === 'object' &&
    JIRA_FIELD_NAMES.every((name) => typeof fields[name] === 'string' && fields[name].startsWith('customfield_')) &&
    typeof value.authors === 'object' &&
    typeof value.links === 'object'
  );
}

const RULES = {
  jira: { isValid: isJiraConfig, expected: `${JIRA_KEYS.join(', ')}를 담은 객체(fields에는 ${JIRA_FIELD_NAMES.join(', ')})` },
  baseUrl: { isValid: isHttpsUrl, expected: 'https 주소' },
  menuNo: { isValid: (value) => typeof value === 'string' && /^\d+$/.test(value), expected: '숫자로만 된 문자열' },
  spaceName: { isValid: (value) => typeof value === 'string' && value.trim() !== '', expected: '비어 있지 않은 문자열' },
  limit: { isValid: isPositiveInteger, expected: '양의 정수(원)' },
  monthToRound: {
    isValid: isMonthToRound,
    expected: '{ "월": 차수 } 형태(월은 1~12, 차수는 서로 다른 양의 정수)',
  },
  maxListPages: { isValid: isPositiveInteger, expected: '양의 정수' },
  navTimeoutMs: { isValid: isPositiveInteger, expected: '양의 정수(밀리초)' },
  fileTimeoutMs: { isValid: isPositiveInteger, expected: '양의 정수(밀리초)' },
};

function readOverrides(file) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new UserError(`설정 파일을 읽지 못했습니다 (${file}): ${error.message}`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new UserError(`설정 파일이 올바른 JSON이 아닙니다 (${file}): ${error.message}`, { cause: error });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UserError(`설정 파일은 { "항목": 값 } 형태의 객체여야 합니다 (${file}).`);
  }
  return parsed;
}

// 오타가 난 항목을 조용히 무시하면 한도 같은 값이 기본값으로 남아 금액이 틀리게 나오므로 모르는 항목은 거절한다.
function validateOverrides(overrides, file) {
  const unknown = Object.keys(overrides).filter((key) => !Object.hasOwn(RULES, key));
  if (unknown.length > 0) {
    throw new UserError(
      `설정 파일에 알 수 없는 항목이 있습니다 (${file}): ${unknown.join(', ')}. 쓸 수 있는 항목: ${Object.keys(RULES).join(', ')}`,
    );
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!RULES[key].isValid(value)) {
      throw new UserError(`설정 파일의 '${key}' 값이 올바르지 않습니다 (${file}). 기대하는 형식: ${RULES[key].expected}`);
    }
  }
}

// monthToRound는 병합하지 않고 통째로 바꾼다. 일부 달만 적어도 나머지 기본값이 남으면, 달을 뺄 방법이 없어진다.
export function loadConfig(dir) {
  const file = path.join(dir, CONFIG_FILE);
  const overrides = readOverrides(file);
  validateOverrides(overrides, file);
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    monthToRound: { ...(overrides.monthToRound ?? DEFAULT_CONFIG.monthToRound) },
  };
}
