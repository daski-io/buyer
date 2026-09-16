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

   For the contract signer the suite stops at the validated EAS call; submit
   it through the circle CLI and record it with
   `daski order confirm <handle> --tx <hash>` followed by `--check`.
4. Record both runs with the release evidence: the exact Circle CLI version
   (`circle --version`), the gateway version from `/.well-known/mcp.json`, and
   the facilitator responses.

## After the evidence exists

One buyer release flips `circle-agent` to `conformance: verified` in the
adapter's `describe()`, which also ends doctor's pending-conformance warning;
the gateway's `signerClis.circle-agent` moves to the version the run used,
together with its pin on this package and the harness pin. Base mainnet
additionally requires `CONFORMANCE_EVIDENCE_RECORDED=1` next to that evidence.
