# `@daski/pay`

The Daski buyer bridge. A CLI that buys outcomes, tracks orders across
processes, and refuses to sign anything it has not independently checked.

```bash
npx @daski/pay@latest doctor --json
```

> Server proposes; buyer bridge validates against its own expectations and
> recomputes; wallet signs; the gateway never sees the key.

## Commands

| Command | What it does |
|---|---|
| `daski doctor` | Readiness report; exits 0 only when nothing blocks. Every issue carries a remediation |
| `daski wallet create` | Generate a local EOA — interactive human confirmation required |
| `daski wallet address` / `balance` | The active payer address; native + USDC balances |
| `daski buy --provider <id> --outcome <id> --request <file.json>` | Challenge → approve → validate → sign → submit → record |
| `daski order status <handle>` | Read an order's state |
| `daski order artifact <handle>` | Write the result **to a file**, never to stdout |
| `daski order confirm/input/cancel <handle>` | Mutating lifecycle actions |
| `daski sign-payment --challenge <file.json>` | Validate, recompute, sign; print the exact `paymentPayload` |

All support `--json`. Global flags: `--profile`, `--signer`,
`--max-per-order`, `--session-cap`.

## Spend caps are yours, not the agent's

`maxPerOrderUsdc`, `sessionCapUsdc` and `requireApprovalAboveUsdc` live only
in `~/.daski/config.json`. **No flag and no environment variable can raise
them.** `--max-per-order` and `--session-cap` may lower a cap for a single
invocation; a value above the configured one is refused.

Above `requireApprovalAboveUsdc`, `daski buy` shows the approval summary and
waits for a human. In `--json` or non-TTY mode it does not quietly proceed —
it exits `2` and explains how a human can approve.

The running session total is read from `~/.daski/orders.json`, so the cap
holds across processes rather than resetting whenever an agent restarts.

## Orders survive the process that placed them

Every order is recorded in `~/.daski/orders.json` — handle, intent id,
provider/outcome, amount, state, read capability and expiry. `daski order
status` works from a cold start with nothing but the handle.

The intent is recorded **before** the signature goes out, which is what makes
an interrupted purchase recoverable.

## Interrupted purchases are reconciled, never re-signed

On a timeout, a `PAYMENT_PENDING_RECONCILIATION`, or a transport drop after
submit, the CLI replays the *identical* signed authorization — idempotent by
the gateway's own published retry policy — and corroborates against the
payer's own order history. Only when both agree no order exists does it report
the purchase as safely retryable.

A second signature over a fresh challenge is a second order, and a second
charge. See [reconciliation](../../docs/policy.md#reconciliation).

## Artifacts are written, not printed

`daski order artifact` writes the provider's bytes to a file and prints only
the envelope metadata. Provider results are validated but untrusted, and both
a terminal and an agent's context window are interpreters: dumping untrusted
content into one is how "here is your result" becomes "here are your
instructions".

## Keys

OS keychain by default, scrypt+AES-256-GCM file as a fallback,
`DASKI_PAYER_PRIVATE_KEY` for sandbox development (which `doctor` flags every
time). Keys never appear in logs, JSON output, or error messages.

See [key storage](../../docs/keys.md).

## Documentation

[Policy validator](../../docs/policy.md) ·
[Configuration](../../docs/config.md) ·
[Keys](../../docs/keys.md) ·
[Signers](../../docs/signers.md) ·
[Conformance](../../docs/conformance.md)

## License

MIT
