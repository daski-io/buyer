/**
 * Every refusal this package raises is structured: a stable machine code, the
 * §4 check that failed, and the remediation a human can act on. Nothing here
 * ever carries key material — see `redact.ts` for the outbound guard.
 */

/** The §4.1 checks, in spec order, plus the lifecycle and recompute tiers. */
export type PolicyCheck =
  | "chain-pinning"
  | "typed-data-shape"
  | "payer-match"
  | "splitter-allowlist"
  | "amount-and-caps"
  | "authorization-window"
  | "payment-identifier"
  | "lifecycle-binding"
  | "recipe-recompute"
  | "challenge-shape";

export interface PolicyRefusalDetail {
  /** Which §4.1 assertion refused. */
  check: PolicyCheck;
  /** Stable machine-readable code, e.g. `DASKI_POLICY_SPLITTER_NOT_ALLOWLISTED`. */
  code: string;
  /** What the bridge required. */
  expected?: string;
  /** What the server proposed. Never key material. */
  actual?: string;
  /** The exact command or doc URL that resolves this. */
  remediation: string;
}

/**
 * A refusal to sign. The bridge never "fixes and proceeds": a failed check
 * ends the attempt, and the caller is told which check and what to do.
 */
export class PolicyRefusal extends Error {
  override readonly name = "PolicyRefusal";
  readonly detail: PolicyRefusalDetail;

  constructor(detail: PolicyRefusalDetail) {
    super(`${detail.code}: ${refusalSentence(detail)}`);
    this.detail = detail;
  }

  toJSON(): PolicyRefusalDetail & { error: "policy_refusal"; message: string } {
    return { error: "policy_refusal", message: this.message, ...this.detail };
  }
}

function refusalSentence(detail: PolicyRefusalDetail): string {
  const parts = [`the ${detail.check} check refused this challenge`];
  if (detail.expected !== undefined) parts.push(`expected ${detail.expected}`);
  if (detail.actual !== undefined) parts.push(`server proposed ${detail.actual}`);
  return parts.join("; ");
}

export function refuse(detail: PolicyRefusalDetail): never {
  throw new PolicyRefusal(detail);
}
