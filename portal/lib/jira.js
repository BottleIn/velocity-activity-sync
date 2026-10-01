/**
 * Jira REST 입출력. 인증은 ~/.netrc의 사이트 항목을 읽어 Basic 인증으로 한다.
 * 토큰을 설정 파일이나 저장소에 두지 않으려는 것이다(시트는 Apps Script 속성의 토큰을 따로 쓴다).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UserError } from './errors.js';
import { PROPERTY_KEY } from './jira-plan.js';

export const RUN_PROPERTY_KEY = 'velocity.portalSync';
const OPTION_FIELDS = new Set(['status', 'item', 'method', 'evidence']);

export function parseNetrc(text, host) {
  const tokens = String(text ?? '').split(/\s+/).filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== 'machine' || tokens[index + 1] !== host) continue;
    const entry = {};
    for (let next = index + 2; next < tokens.length && tokens[next] !== 'machine'; next += 2) {
      entry[tokens[next]] = tokens[next + 1];
    }
    if (entry.login && entry.password) return { login: entry.login, password: entry.password };
  }
  return null;
}

export function readCredentials(site, home = os.homedir()) {
  let text;
  try {
    text = fs.readFileSync(path.join(home, '.netrc'), 'utf8');
  } catch (error) {
    throw new UserError(`~/.netrc를 읽지 못했습니다: ${error.message}`, { cause: error });
  }
  const credentials = parseNetrc(text, site);
  if (credentials === null) throw new UserError(`~/.netrc에 ${site} 항목(login, password)이 없습니다.`);
  return credentials;
}

export function createJiraClient({ site, credentials, fetchImpl = fetch }) {
  const auth = `Basic ${Buffer.from(`${credentials.login}:${credentials.password}`).toString('base64')}`;
  return async function request(method, apiPath, body) {
    const response = await fetchImpl(`https://${site}/rest/api/3${apiPath}`, {
      method,
      headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (response.status === 404 && method === 'GET' && apiPath.includes('/properties/')) return null;
    if (!response.ok) {
      throw new UserError(`Jira ${method} ${apiPath} 실패 (${response.status}): ${text.slice(0, 300)}`);
    }
    return text === '' ? null : JSON.parse(text);
  };
}

function readValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object' && 'value' in raw) return raw.value;
  return raw;
}

export async function fetchActivityIssues(request, jira) {
  const fieldIds = Object.values(jira.fields);
  const issues = [];
  let nextPageToken;
  do {
    const page = await request('POST', '/search/jql', {
      jql: `project = ${jira.projectKey} AND issuetype = ${jira.issueTypeId} ORDER BY created ASC`,
      fields: ['summary', 'assignee', ...fieldIds],
      maxResults: 100,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
    issues.push(...page.issues);
    nextPageToken = page.nextPageToken;
  } while (nextPageToken);
  const result = [];
  for (const issue of issues) {
    const property = await request('GET', `/issue/${issue.key}/properties/${PROPERTY_KEY}`);
    const values = Object.fromEntries(Object.entries(jira.fields).map(([name, id]) => [name, readValue(issue.fields[id])]));
    result.push({ key: issue.key, summary: issue.fields.summary, portalKey: property?.value?.key ?? null, values });
  }
  return result;
}

function toJiraValue(name, value) {
  if (value === null) return null;
  return OPTION_FIELDS.has(name) ? { value } : value;
}

export function changeFields(jira, changes) {
  return Object.fromEntries(changes.map(({ name, to }) => [jira.fields[name], toJiraValue(name, to)]));
}

function description(ticket, baseUrl) {
  const view = `${baseUrl}/mypage/projectSpt/view.do?foundId=${ticket.foundId}&menuNo=200054`;
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: `포털 신청 ${ticket.portalKey}을 활동비 동기화 스크립트가 만든 티켓입니다. ` },
          { type: 'text', text: '금액과 상태는 포털을 따라 바뀌니 포털에서 고칩니다. ' },
          { type: 'text', text: '포털 상세 화면', marks: [{ type: 'link', attrs: { href: view } }] },
        ],
      },
    ],
  };
}

export function createFields({ jira, ticket, baseUrl }) {
  const fields = {
    project: { key: jira.projectKey },
    issuetype: { id: jira.issueTypeId },
    parent: { key: jira.epicKey },
    summary: ticket.createOnly.summary,
    description: description(ticket, baseUrl),
  };
  const accountId = jira.authors[ticket.author];
  if (accountId) fields.assignee = { accountId };
  if (ticket.labels?.length > 0) fields.labels = ticket.labels;
  const values = { ...ticket.createOnly, ...ticket.owned, status: ticket.status };
  for (const [name, value] of Object.entries(values)) {
    if (!Object.hasOwn(jira.fields, name) || value === undefined || value === null) continue;
    fields[jira.fields[name]] = toJiraValue(name, value);
  }
  return fields;
}

// VEL 프로젝트 워크플로의 '완료' 전환 id다. 티켓은 증빙완료된 신청으로만 만들어서 만들 때 바로 완료로 옮긴다.
// 예전부터 사람이 만든 활동비 티켓도 결제가 끝나면 완료에 두었다.
export const DONE_TRANSITION_ID = '41';

// 만든 티켓은 다시 읽어 요약이 그대로인지 본다. 한글이 조용히 바뀌어 저장된 적이 있다.
export async function applyPlan(request, { jira, plan, baseUrl }) {
  const created = [];
  for (const ticket of plan.creates) {
    const fields = createFields({ jira, ticket, baseUrl });
    const { key } = await request('POST', '/issue', { fields });
    await request('PUT', `/issue/${key}/properties/${PROPERTY_KEY}`, { key: ticket.portalKey });
    await request('POST', `/issue/${key}/transitions`, { transition: { id: DONE_TRANSITION_ID } });
    const saved = await request('GET', `/issue/${key}?fields=summary`);
    if (saved.fields.summary !== fields.summary) throw new UserError(`${key}의 요약이 다르게 저장됐습니다: ${saved.fields.summary}`);
    created.push({ key, portalKey: ticket.portalKey });
  }
  for (const { key, portalKey } of plan.properties) {
    await request('PUT', `/issue/${key}/properties/${PROPERTY_KEY}`, { key: portalKey });
  }
  for (const update of plan.updates) {
    await request('PUT', `/issue/${update.key}`, { fields: changeFields(jira, update.changes) });
  }
  return created;
}

export async function writeRunRecord(request, jira, record) {
  await request('PUT', `/issue/${jira.epicKey}/properties/${RUN_PROPERTY_KEY}`, record);
}
