/**
 * A CLI failure the operator can act on: a stable code, a sentence, and the
 * exact next step. Anything that reaches the user without a remediation is a
 * bug in this file's callers, not a UX preference.
 */
export interface CliErrorOptions {
  code: string;
  message: string;
  remediation: string;
  /** Extra machine-readable context. Never key material. */
  details?: Record<string, unknown>;
  /** Process exit code; defaults to 1. */
  exitCode?: number;
}

export class CliError extends Error {
  override readonly name = "CliError";
  readonly code: string;
  readonly remediation: string;
  readonly details: Record<string, unknown>;
  readonly exitCode: number;

  constructor(options: CliErrorOptions) {
    super(options.message);
    this.code = options.code;
    this.remediation = options.remediation;
    this.details = options.details ?? {};
    this.exitCode = options.exitCode ?? 1;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      remediation: this.remediation,
      ...this.details,
    };
  }
}
