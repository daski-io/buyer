# Conformance suite

The acceptance gate for the CLI and for every signer adapter. It runs against
the **live sandbox** with a funded key and **spends real testnet USDC**, so it
refuses to start without explicit consent:

```bash
DASKI_CONFORMANCE_SPEND_OK=1 \
DASKI_PAYER_PRIVATE_KEY=0x… \
npm run conformance -- --profile sandbox --signer local
```

Without `DASKI_CONFORMANCE_SPEND_OK=1` it exits `2` and explains why. A suite
that can be triggered by accident is a suite that drains a wallet by accident.

## What it runs

`doctor passes` → `prepare` → `policy-validate + recompute + sign` → `buy` →
grant-read (when available) → `status` → `artifact` → optionally `confirm`
(`--confirm`).

## Assertions

- **The first signed attempt is accepted.** A second attempt would mean the
  bridge signed something the gateway would not take.
- **Every request and response is byte-logged** to a run directory
  (`./conformance-runs/<timestamp>-<profile>-<signer>/`), as `calls.jsonl` plus
  a `summary.json`. Signature redaction is optional (`--redact-signatures`);
  **key redaction is unconditional**, because a run log is exactly the kind of
  artifact that gets pasted into an issue tracker.
- **Total daski calls stay within budget.**

## Call budget

The spec's budget of 6 assumes the spec-01 surfaces: `daski_get_payment_challenge`
for the challenge and `daski_get_order_access` for a read capability that
serves both `status` and `artifact`.

Today's sandbox exposes neither, so the CLI uses its documented fallbacks —
an unpaid `daski_buy_outcome` for the challenge, and per-action lifecycle
signing for each read, which costs a challenge plus an authorized retry.

The suite detects which tier it is running in and asserts the matching budget
(`6` for `spec-01`, `12` for `fallback`), reporting the tier in `summary.json`
rather than failing a budget that does not apply. When the spec-01 tools land
on sandbox, the tier flips automatically and the tighter budget applies.

## Flags

| Flag | Effect |
|---|---|
| `--profile <name>` | Config profile (default `sandbox`) |
| `--signer <local\|cdp\|circle>` | Override the profile's signer |
| `--cdp-account <name>` | CDP account for `--signer cdp` (or `DASKI_CDP_ACCOUNT`) |
| `--circle-wallet <id>` | Circle wallet id for `--signer circle` (or `DASKI_CIRCLE_WALLET`) |
| `--provider` / `--outcome` | What to buy (default `8327` / `create-mailbox`) |
| `--confirm` | Also run the delivery-confirmation step |
| `--redact-signatures` | Blank signatures in the run log |
| `DASKI_CONFORMANCE_DIR` | Where run directories are written |
