import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXIT, UserError } from '../portal/lib/errors.js';

describe('UserError', () => {
  it('carries the message and defaults to the failure exit code', () => {
    const error = new UserError('설정 파일을 읽지 못했습니다.');

    assert.equal(error.message, '설정 파일을 읽지 못했습니다.');
    assert.equal(error.exitCode, EXIT.FAILURE);
    assert.equal(error.name, 'UserError');
    assert.ok(error instanceof Error);
  });

  it('accepts a custom exit code and a cause', () => {
    const cause = new Error('원인');

    const error = new UserError('로그인이 필요합니다.', { exitCode: EXIT.NOT_LOGGED_IN, cause });

    assert.equal(error.exitCode, 2);
    assert.equal(error.cause, cause);
  });

  it('keeps the exit codes the entry point documents', () => {
    assert.deepEqual(EXIT, { OK: 0, FAILURE: 1, NOT_LOGGED_IN: 2, INTERRUPTED: 130 });
  });
});
