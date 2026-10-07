# Signer conformance

A signer is *supported* once the conformance suite has passed with it against
the sandbox gateway and the run is recorded with the release; until then
`doctor` reports it as a candidate, and it can still buy. The suite spends real
sandbox USDC, so it refuses to start without `DASKI_CONFORMANCE_SPEND_OK=1`.

## What the owner does once for the Circle agent wallet

The sandbox profile is Base Sepolia, and Circle keeps that session and wallet
apart from its main ones, so every Circle step below carries `--testnet`.

1. Set the wallet up with Circle's skill
   (`curl -sL https://agents.circle.com/skills/setup.md`), in your own
   terminal. Check `circle wallet status` before any login: each `--init`
   sends a new code, and request ids expire after ten minutes.
2. Log in with `--testnet`, create the wallet with
   `circle wallet create --testnet --output json`, deploy it with a zero-value
   transfer to itself, and fund it from Circle's faucet as the skill describes.
3. Run both signers against the sandbox from this repository:

   ```bash
   DASKI_CONFORMANCE_SPEND_OK=1 npm run conformance -- --profile sandbox --signer local --confirm
   DASKI_KEY_BACKEND=circle-agent DASKI_CONFORMANCE_SPEND_OK=1 npm run conformance -- --profile sandbox --signer circle-agent --confirm
   ```

   For the contract signer the suite stops at the validated EAS call. Its
   review goes through this CLI's Circle adapter, never `circle wallet
   execute`, which cannot send the tuple argument as given; see
   [direct reviews](direct-reviews.md) and the qualification below.
4. Record both runs with the release evidence: the exact Circle CLI version
   (`circle --version`), the gateway version from `/.well-known/mcp.json`, and
   the facilitator responses.

## After the evidence exists

0.4.5 flips `circle-agent` to `conformance: verified` in the adapter's
`describe()`, on the owner's attestation that its run exists, which also ends
doctor's pending-conformance warning; the gateway's `signerClis.circle-agent`
moves to the version the run used, together with its pin on this package and
the harness pin. Base mainnet additionally requires
`CONFORMANCE_EVIDENCE_RECORDED=1` next to that evidence.

## Direct review execution qualification

Circle signing conformance does not qualify the new execution adapter. Keep
confirmation.directReview.circleExecute disabled until an explicitly authorized
live run records the shipped buyer and Circle entrypoint versions, estimation,
callHash-approved submit, timeout/read-only resume, replacement or revocation,
and intent-bound finalized EAS evidence. Use the [direct review workflow](direct-reviews.md).
If vendor history cannot expose an exact-call transaction ID or idempotency-key
mapping after a timeout, record that limitation and retain the unresolved journal;
do not manufacture a fresh key or claim execution conformance from estimation.

To generate that initial execution evidence while the normal capability is
disabled, an explicitly authorized Base Sepolia run can use the candidate lane
against an already prepared chosen review:

~~~bash
DASKI_CONFORMANCE_SPEND_OK=1 daski order confirm <handle> --submit --approve-call <callHash> --qualify-circle-execution --json
daski order confirm <handle> --resume --json
~~~

The flag requires explicit submit and the exact approved callHash, works only
on chain 84532, and records conformanceCandidate in the durable vendor journal.
It never bypasses mainnet qualification and does not create a new key on resume.
A recorded successful run can then qualify ordinary execution through the
gateway setting; a candidate submission alone is not a conformance result.
