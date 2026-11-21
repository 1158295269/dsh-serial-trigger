/**
 * One error type shared by store, service and tools.
 * Extra fields are written for the model: why it failed, what else to try, and
 * whether a retry can help.
 */
export class SerialError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'SerialError';
    this.code = code;
    this.hint = extra.hint || '';
    this.fix = extra.fix || [];
    this.retryable = extra.retryable ?? false;
  }
}
