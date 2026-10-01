// portal/read-portal.js가 포털에 아무것도 쓰지 않는다는 약속을 글자로 잠근다.
// 증빙 화면(evidence.do)은 파일을 고치는 양식이라, 버튼 하나만 잘못 눌러도 사무국에 낸 증빙이 바뀐다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const SOURCE = readFileSync(new URL('../portal/read-portal.js', import.meta.url), 'utf8');

const FORBIDDEN = [
  {
    name: 'a page or element interaction call',
    pattern: /\.(click|dblclick|fill|press|type|hover|focus|tap|check|uncheck|dragAndDrop|selectOption|setInputFiles|acceptDialog|waitForFileChooser|submit|requestSubmit|dispatchEvent)\s*\(/,
    violation: "await page.click('#save');",
  },
  { name: 'keyboard access', pattern: /\b(keyboard|mouse)\s*\./, violation: "await page.keyboard.press('Enter');" },
  { name: 'mouse access', pattern: /\b(keyboard|mouse)\s*\./, violation: 'await page.mouse.click(1, 2);' },
  { name: 'an explicit request method', pattern: /\bmethod\s*:/, violation: "await page.fetch(url, { method: 'PUT' });" },
  { name: 'a POST string', pattern: /['"`]POST['"`]/i, violation: 'const verb = "post";' },
  { name: 'raw devtools protocol access', pattern: /\.cdp\s*\(/, violation: "await page.cdp('Page.navigate', {});" },
];

const ALLOWED_ENDPOINTS = ['main.do', 'list.do', 'view.do', 'evidence.do', 'fileDown.do'];
const ENDPOINT = /\b([A-Za-z0-9_]+\.do)\b/g;

describe('portal/read-portal.js only reads', () => {
  for (const { name, pattern } of FORBIDDEN) {
    it(`contains no ${name}`, () => {
      const match = pattern.exec(SOURCE);

      assert.equal(match, null, match ? `found ${match[0]}` : undefined);
    });
  }

  it('never mentions accepting a dialog', () => {
    assert.ok(!SOURCE.includes('acceptDialog'));
  });

  it('only visits the five known portal pages', () => {
    const names = new Set([...SOURCE.matchAll(ENDPOINT)].map((match) => match[1]));

    assert.ok(names.size > 0, 'no portal page name found, so this check would prove nothing');
    for (const name of names) {
      assert.ok(ALLOWED_ENDPOINTS.includes(name), `${name} is not an allowed portal page`);
    }
  });

  it('cannot reach the page that saves evidence changes', () => {
    assert.ok(!SOURCE.includes('updateEvd.do'));
  });

  it('still uses each page it is meant to read', () => {
    for (const name of ALLOWED_ENDPOINTS) {
      assert.ok(SOURCE.includes(name), `${name} is no longer referenced`);
    }
  });
});

describe('the safety checks themselves', () => {
  for (const { name, pattern, violation } of FORBIDDEN) {
    it(`would catch ${name}`, () => {
      assert.match(violation, pattern);
    });
  }

  it('would catch an unknown portal page name', () => {
    const names = [...'await page.goto(`${BASE}/mypage/projectSpt/updateEvd.do`);'.matchAll(ENDPOINT)].map((match) => match[1]);

    assert.deepEqual(names, ['updateEvd.do']);
    assert.ok(!ALLOWED_ENDPOINTS.includes(names[0]));
  });

  it('does not flag the plain reading calls the script really uses', () => {
    const harmless = ["await page.goto(url, { waitUntil: 'domcontentloaded' });", 'const info = await page.info();', 'await page.dismissDialog();', "page.evaluate(extractPage);"];

    for (const line of harmless) {
      for (const { pattern } of FORBIDDEN) {
        assert.doesNotMatch(line, pattern);
      }
    }
  });
});
