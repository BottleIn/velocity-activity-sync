import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { APP_NAME, CONFIG_FILE, DEFAULT_CONFIG, DEFAULT_ROUNDS, appDir, loadConfig, roundsOf } from '../portal/lib/config.js';
import { UserError } from '../portal/lib/errors.js';

const workRoot = mkdtempSync(path.join(os.tmpdir(), 'vas-config-'));
after(() => rmSync(workRoot, { recursive: true, force: true }));

let dir;
let counter = 0;
beforeEach(() => {
  counter += 1;
  dir = path.join(workRoot, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
});

function writeConfig(content) {
  writeFileSync(path.join(dir, CONFIG_FILE), typeof content === 'string' ? content : JSON.stringify(content));
}

describe('DEFAULT_CONFIG', () => {
  it('holds the documented defaults', () => {
    assert.deepEqual(DEFAULT_CONFIG, {
      baseUrl: 'https://www.swmaestro.ai/busan/sw',
      menuNo: '200054',
      spaceName: '활동비 포털 동기화',
      limit: 12000000,
      monthToRound: { 7: 1, 8: 2, 9: 3, 10: 4, 11: 5 },
      maxListPages: 20,
      navTimeoutMs: 30000,
      fileTimeoutMs: 60000,
    });
  });

  it('leaves December unmapped on purpose', () => {
    assert.equal(DEFAULT_CONFIG.monthToRound[12], undefined);
  });

  it('cannot be changed by accident, including the nested month map', () => {
    assert.throws(() => {
      DEFAULT_CONFIG.limit = 1;
    }, TypeError);
    assert.throws(() => {
      DEFAULT_CONFIG.monthToRound[12] = 6;
    }, TypeError);
  });

  it('lists rounds one to five', () => {
    assert.deepEqual(DEFAULT_ROUNDS, [1, 2, 3, 4, 5]);
  });
});

describe('roundsOf', () => {
  it('returns the distinct rounds in ascending order', () => {
    assert.deepEqual(roundsOf({ 9: 3, 7: 1, 8: 2 }), [1, 2, 3]);
    assert.deepEqual(roundsOf({ 7: 2, 8: 2 }), [2]);
    assert.deepEqual(roundsOf({}), []);
  });
});

describe('appDir', () => {
  it('lives under Application Support by default', () => {
    const result = appDir({}, '/home/tester');

    assert.equal(result, path.join('/home/tester', 'Library', 'Application Support', APP_NAME));
  });

  it('can be moved with VELOCITY_SYNC_HOME', () => {
    const result = appDir({ VELOCITY_SYNC_HOME: '/somewhere/else' }, '/home/tester');

    assert.equal(result, '/somewhere/else');
  });

  it('ignores an empty VELOCITY_SYNC_HOME', () => {
    const result = appDir({ VELOCITY_SYNC_HOME: '' }, '/home/tester');

    assert.ok(result.endsWith(APP_NAME));
  });

  it('reads the current environment and home directory when called without arguments', () => {
    assert.equal(typeof appDir(), 'string');
  });
});

describe('loadConfig', () => {
  it('returns the defaults when there is no config file', () => {
    const config = loadConfig(dir);

    assert.deepEqual(config, DEFAULT_CONFIG);
  });

  it('returns a copy that the caller may change', () => {
    const config = loadConfig(dir);

    config.monthToRound[12] = 6;
    config.limit = 1;

    assert.equal(DEFAULT_CONFIG.monthToRound[12], undefined);
    assert.equal(DEFAULT_CONFIG.limit, 12000000);
  });

  it('overrides only the keys the file sets', () => {
    writeConfig({ limit: 10000000, maxListPages: 5 });

    const config = loadConfig(dir);

    assert.equal(config.limit, 10000000);
    assert.equal(config.maxListPages, 5);
    assert.equal(config.baseUrl, DEFAULT_CONFIG.baseUrl);
    assert.deepEqual(config.monthToRound, DEFAULT_CONFIG.monthToRound);
  });

  it('replaces the month map as a whole', () => {
    writeConfig({ monthToRound: { 7: 1, 12: 2 } });

    const config = loadConfig(dir);

    assert.deepEqual(config.monthToRound, { 7: 1, 12: 2 });
  });

  it('accepts every documented key at once', () => {
    writeConfig({
      baseUrl: 'https://portal.example.test/busan/sw',
      menuNo: '123',
      spaceName: '다른 이름',
      limit: 5000000,
      monthToRound: { 8: 1 },
      maxListPages: 3,
      navTimeoutMs: 1000,
      fileTimeoutMs: 2000,
    });

    const config = loadConfig(dir);

    assert.equal(config.spaceName, '다른 이름');
    assert.equal(config.fileTimeoutMs, 2000);
  });

  it('accepts every month key from 1 to 12 written without a leading zero', () => {
    const months = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [String(index + 1), index + 1]));
    writeConfig({ monthToRound: months });

    const config = loadConfig(dir);

    assert.deepEqual(config.monthToRound, months);
  });

  it('accepts an https address', () => {
    writeConfig({ baseUrl: 'https://portal.example.test/busan/sw' });

    assert.equal(loadConfig(dir).baseUrl, 'https://portal.example.test/busan/sw');
  });

  it('fails with the file path when the JSON is broken', () => {
    writeConfig('{ 깨진 JSON');

    assert.throws(
      () => loadConfig(dir),
      (error) => error instanceof UserError && error.message.includes(CONFIG_FILE),
    );
  });

  it('fails clearly when the config path cannot be read as a file', () => {
    mkdirSync(path.join(dir, CONFIG_FILE));

    assert.throws(
      () => loadConfig(dir),
      (error) => error instanceof UserError && error.message.includes(CONFIG_FILE),
    );
  });

  it('fails when the file holds something other than an object', () => {
    for (const content of ['[]', '"문자열"', 'null', '3']) {
      writeConfig(content);

      assert.throws(() => loadConfig(dir), UserError, content);
    }
  });

  it('fails on a key it does not know so a typo cannot pass silently', () => {
    writeConfig({ limt: 1000 });

    assert.throws(
      () => loadConfig(dir),
      (error) => error instanceof UserError && error.message.includes('limt'),
    );
  });

  const invalidValues = [
    ['baseUrl', 'not a url'],
    ['baseUrl', 'ftp://portal.example.test'],
    ['baseUrl', 'http://portal.example.test/busan/sw'],
    ['baseUrl', 'javascript:alert(1)'],
    ['baseUrl', 5],
    ['menuNo', 200054],
    ['menuNo', '12ab'],
    ['spaceName', ''],
    ['spaceName', 3],
    ['limit', 0],
    ['limit', -5],
    ['limit', 1.5],
    ['limit', '12000000'],
    ['maxListPages', 0],
    ['navTimeoutMs', -1],
    ['fileTimeoutMs', 'soon'],
    ['monthToRound', []],
    ['monthToRound', 'x'],
    ['monthToRound', { 13: 1 }],
    ['monthToRound', { 0: 1 }],
    ['monthToRound', { '07': 1 }],
    ['monthToRound', { '012': 1 }],
    ['monthToRound', { '00': 1 }],
    ['monthToRound', { '1.0': 1 }],
    ['monthToRound', { ' 7': 1 }],
    ['monthToRound', { seven: 1 }],
    ['monthToRound', { 7: 0 }],
    ['monthToRound', { 7: 1.5 }],
    ['monthToRound', { 7: 1, 8: 1 }],
  ];
  for (const [key, value] of invalidValues) {
    it(`rejects ${key} = ${JSON.stringify(value)}`, () => {
      writeConfig({ [key]: value });

      assert.throws(
        () => loadConfig(dir),
        (error) => error instanceof UserError && error.message.includes(key),
      );
    });
  }
});
