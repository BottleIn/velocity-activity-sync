export const EXIT = Object.freeze({
  OK: 0,
  FAILURE: 1,
  NOT_LOGGED_IN: 2,
  INTERRUPTED: 130,
});

// 사용자에게 그대로 보여 줄 한국어 메시지를 든 오류다. 진입점은 이 오류의 메시지만 찍고,
// 그 밖의 오류(코드 결함)는 원인을 좇을 수 있게 스택까지 찍는다.
export class UserError extends Error {
  constructor(message, { exitCode = EXIT.FAILURE, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'UserError';
    this.exitCode = exitCode;
  }
}
