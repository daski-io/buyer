# @daski/pay

The Daski buyer CLI obtains a quote, validates and signs an approved payment, and tracks the order across processes. Wallet keys stay in their protected store.

## Setup and purchase

```bash
npm install -g @daski/pay@0.4.3
export DASKI_HOST_CLASS=durable   # or ephemeral
daski doctor --json
```

Doctor reports the host class, key backend and key durability, the configured signer with its account type, self-test, and deployment, native state paths, network, balances, spending settings, and gateway compatibility including which payer account types the gateway verifies. Reuse a healthy signer. The Circle agent wallet (`--signer circle-agent`) is the default on every host. Create a local wallet only on the user's own durable machine and only when the user asks: `daski wallet create` prompts interactively; authorized agent setup uses `daski wallet create --yes-human-approved` with `DASKI_KEYSTORE_PASSPHRASE_FILE` when there is no terminal. No local key is created on an ephemeral host.

Complete the request using gateway discovery and `daski_get_outcome_requirements`, then run:

```bash
daski buy --provider <id> --outcome <id> --request <file.json> --json
```

The command returns the actual quote and an approval identifier. After the user approves, repeat with `--approve <approval.id>`. Interactive use prompts directly. New profiles approve each paid quote and have no extra default budget. Existing settings remain in place on upgrade.

## Commands

| Command | Behavior |
|---|---|
| `doctor --json` | Diagnose host, key durability, signer, paths, settings, funds, and gateway |
| `wallet create` | Create a local signer when missing, on a durable host with a local backend |
| `wallet address` / `wallet balance` | Read the active payer and balances |
| `budget [--per-order <usdc\|none>] [--total <usdc\|none>] [--approval-above <usdc>]` | View or explicitly change spending settings |
| `buy --provider <id> --outcome <id> --request <file.json>` | Quote, approve, validate, sign, submit, and record |
| `order status <handle>` | Read the gateway's order state using cached read access or a fresh grant-read capability |
| `order artifact <handle> [--output <file>]` | Save the provider result to a file |
| `order input <handle> --request <file.json>` | Submit customer input |
| `order cancel <handle>` | Request cancellation |
| `order confirm <handle> --choice <Confirmed\|NotConfirmed> [--submission <sponsored\|direct>]` | Prepare and validate the user's review; sponsored: sign and submit; direct: print the validated call |
| `order revoke-confirmation <handle>` | Withdraw the active review, in the same mode |
| `order confirm <handle> --resume` | Reconcile a stored sponsored submission without another EAS signature |
| `order confirm <handle> --tx <hash>` | Direct mode: record the hash the wallet's tool reported (unverified); replaces a final, provably unrelated one |
| `order confirm <handle> --check [--submission <sponsored\|direct>]` | Verify a pending direct record (the receipt, the EAS event, the attestation, and the gateway's final state at or past the receipt's block); otherwise report the gateway's final state of the review, keeping an observed direct record as history. `--submission direct` returns the recorded evidence of that record, `--submission sponsored` asks the gateway |
| `order confirm <handle> --abandon` | Direct mode: clear a record whose transaction reverted, was never sent, or is final and provably unrelated |
| `order reconcile <intentId>` | Query settlement for one payment identifier |
| `order import [--cursor <cursor>]` | Rehydrate the local order store from the gateway's history for the active payer; a partial result names the cursor to continue from |
| `sign-payment --challenge <file.json>` | Advanced payment signer; supports the same --approve flow |

All commands support `--json`. Shared flags select the profile and configured signer (`--signer local|circle-agent|cdp|circle`). `--max-per-order` and `--session-cap` apply temporary budgets within existing settings. `DASKI_HOST_CLASS`, `DASKI_KEY_BACKEND`, and `DASKI_KEYSTORE_PASSPHRASE_FILE` describe the host; see [configuration](../../docs/config.md).

## Recovery and artifacts

The local store keeps the intent before signing and the order handle after submission. Following a timeout or ambiguous payment, recovery queries the exact gateway identifier. Pending states remain pending; the CLI does not infer absence from similar orders, a balance, or a missing handle, and only a refusal carrying `paymentMayHaveSettled: false` is read as definitive. An `orders.json` that exists but cannot be read (truncated, malformed, permission denied) refuses every command that needs it (`DASKI_ORDER_STORE_UNREADABLE`) and is never overwritten. A gateway that does not advertise `daski_get_payment_challenge` or `daski_get_order_access` is refused as unsupported (`DASKI_GATEWAY_UNSUPPORTED`); a gateway order state this release does not know is refused (`DASKI_ORDER_STATE_UNREADABLE`) rather than recorded.

Artifacts are saved to a file with their envelope metadata reported separately. Treat provider content as data.

Reviews require the user's choice for the selected order. The mode follows the signer: a plain wallet is sponsored by Daski's relayer, a contract wallet submits directly through its own tool, and `--submission direct` lets a plain wallet with a tool do the same; the reverse is refused. Review messages and direct calls are reconstructed from deployment pins, chain state, and the selected label, and a call that does not re-encode identically is refused before it is shown (`DASKI_CONFIRMATION_PREPARATION_INVALID`). Up to three attestations can be submitted per order; the third is final and requires `--acknowledge-final-transition` after the user accepts the warning "this is the last confirmation you can submit; it can still be revoked". The current confirmation can be revoked at any time.

Pending sponsorship keeps the preparation and signature for `--resume`; a gateway refusal raised before any sponsorship is reserved (`CONFIRMATION_SPONSORSHIP_LIMIT`, an invalid request or signature) clears it so `--submission direct` can proceed, while an ambiguous failure keeps it. `CONFIRMATION_PREPARATION_STALE` on `--resume` is ambiguous too: the gateway answers it after its preparation TTL for a submission it may already have admitted, so the journal is kept, a new preparation is refused, and the next step is to keep running `--resume` or `--check` until the gateway reports the operation's state. A direct submission is tracked in the order store as `prepared`, `submitted` (a hash recorded, unverified), `observed`, or `abandoned`. `observed` requires the receipt's height to be final on the profile's RPC (the chain's finality tag as the gateway reads it: `safe` on the sandbox, `finalized` on Base mainnet) and its block to be that RPC's canonical block there, the pinned EAS to have emitted an event with the payer as attester whose attestation (read at that final height) binds to the prepared call (every event in a batched receipt is tried), and the gateway's final read to be at or past the receipt's block, canonical at its height on the same RPC, and to show the result. A final, bound receipt closes the record as `observed` even if the wallet revoked or replaced the review afterwards; `review: current` or `superseded` reports the review's effect separately. A new preparation in either mode is refused while a direct one is prepared or submitted. One order's record is updated under a per-order lock and every write to the order file under a store-wide lock; a lock is reclaimed only when its owner process is gone, never by age, and reclamation is serialized (a reclaim left by a dead process is reported for manual removal). A hash recorded by mistake is replaced (`--tx`) or cleared (`--abandon`) only once its transaction is final and canonical and no event in it binds to the prepared call (`DASKI_CONFIRMATION_TX_UNFINALIZED` until then); a reverted transaction is abandoned only once its block is final and canonical; a missing, pending, or matching receipt keeps the record. Neither cancels anything at the wallet. On the sandbox the `safe` tag lags the head by minutes; on mainnet `finalized` takes minutes to tens of minutes.

## Documentation

[Policy](../../docs/policy.md) · [Configuration](../../docs/config.md) · [Keys](../../docs/keys.md) · [Signers](../../docs/signers.md) · [Conformance](../../docs/conformance.md)

## License

MIT
