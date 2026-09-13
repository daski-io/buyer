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
grant-read → `status` → `artifact` → optionally `confirm`
(`--confirm`: a `Confirmed` review, waiting up to five minutes for the order's
on-chain reputation record; a plain wallet's review is sponsored and
submitted, a contract wallet's ends at the validated direct call, written to
the run directory as `direct-call.json` for the wallet's own tool). For a
contract wallet the run's PASS is preparation evidence only: `summary.json`
records `confirmation.evidence: "prepared-only"`, and complete conformance
additionally needs the wallet's submission recorded with `--tx` and a
`--check` that reports `observed`, kept with the release evidence. The intent
recorded before signing is the payment identifier the gateway pinned in the
challenge. A signer is *supported* once this suite has passed with it
against the sandbox and the run is recorded with the release; `local` is the
regression baseline, `circle-agent` is required before contract accounts are
enabled on mainnet, and `cdp` and `circle` remain candidates.

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

The budget is 6 daski calls: one challenge from `daski_get_payment_challenge`,
one paid `daski_buy_outcome` retry, one grant-read through
`daski_get_order_access` (a challenge and an authorized retry), and `status`
and `artifact` served by the capability. These are the only surfaces the CLI
uses; a gateway without one of them is refused as unsupported
(`DASKI_GATEWAY_UNSUPPORTED`) rather than run in a fallback tier.
`summary.json` records the budget as `callBudget`.

Run the suite against the live sandbox before every publication, after the
gateway release it targets is deployed, and record the gateway version from
`daski doctor --json` in the changelog entry. 0.1.0 shipped without that run,
one day after the gateway changed its result shape, and could not complete a
single call.

## Flags

| Flag | Effect |
|---|---|
| `--profile <name>` | Config profile (default `sandbox`) |
| `--signer <local\|circle-agent\|cdp\|circle>` | Override the profile's signer |
| `--cdp-account <name>` | CDP account for `--signer cdp` (or `DASKI_CDP_ACCOUNT`) |
| `--circle-wallet <id\|address>` | Circle wallet id for `--signer circle` (or `DASKI_CIRCLE_WALLET`); the agent wallet address to select for `--signer circle-agent` |
| `--provider` / `--outcome` | What to buy (default `8327` / `create-mailbox`) |
| `--confirm` | Also run the delivery-confirmation step |
| `--redact-signatures` | Blank signatures in the run log |
| `DASKI_CONFORMANCE_DIR` | Where run directories are written |
