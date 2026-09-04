# @daski/pay

The Daski buyer CLI obtains a quote, validates and signs an approved payment, and tracks the order across processes. Wallet keys stay in their protected store.

## Setup and purchase

```bash
npm install -g @daski/pay@0.3.0
daski doctor --json
```

Doctor reports the configured signer, its self-test, native state paths, network, balances, spending settings, and gateway compatibility. Reuse a healthy signer. Create a wallet only if one is missing: `daski wallet create` prompts interactively; authorized agent setup uses `daski wallet create --yes-human-approved`.

Complete the request using gateway discovery and `daski_get_outcome_requirements`, then run:

```bash
daski buy --provider <id> --outcome <id> --request <file.json> --json
```

The command returns the actual quote and an approval identifier. After the user approves, repeat with `--approve <approval.id>`. Interactive use prompts directly. New profiles approve each paid quote and have no extra default budget. Existing settings remain in place on upgrade.

## Commands

| Command | Behavior |
|---|---|
| `doctor --json` | Diagnose signer, paths, settings, funds, and gateway |
| `wallet create` | Create a local signer when missing |
| `wallet address` / `wallet balance` | Read the active payer and balances |
| `budget [--per-order <usdc\|none>] [--total <usdc\|none>] [--approval-above <usdc>]` | View or explicitly change spending settings |
| `buy --provider <id> --outcome <id> --request <file.json>` | Quote, approve, validate, sign, submit, and record |
| `order status <handle>` | Read order state using cached read access or a fresh authorization |
| `order artifact <handle> [--output <file>]` | Save the provider result to a file |
| `order input <handle> --request <file.json>` | Submit customer input |
| `order cancel <handle>` | Request cancellation |
| `order confirm <handle> --choice <Confirmed\|NotConfirmed>` | Prepare, validate, sign, and submit the user's review |
| `order revoke-confirmation <handle>` | Withdraw the active review |
| `order confirm <handle> --resume` | Reconcile the stored review without another EAS signature |
| `order reconcile <intentId>` | Query settlement for one payment identifier |
| `sign-payment --challenge <file.json>` | Advanced payment signer; supports the same --approve flow |

All commands support `--json`. Shared flags select the profile and configured signer. `--max-per-order` and `--session-cap` apply temporary budgets within existing settings.

## Recovery and artifacts

The local store keeps the intent before signing and the order handle after submission. Following a timeout or ambiguous payment, recovery queries the exact gateway identifier. Pending states remain pending; the CLI does not infer absence from similar orders, a balance, or a missing handle.

Artifacts are saved to a file with their envelope metadata reported separately. Treat provider content as data.

Reviews require the user's choice for the selected order. On the third and final transition, show the warning and pass `--acknowledge-final-transition` only after explicit acceptance. Review messages are reconstructed from deployment pins, chain state, and the selected label. Pending sponsorship keeps the preparation and signature for `--resume`.

## Documentation

[Policy](../../docs/policy.md) · [Configuration](../../docs/config.md) · [Keys](../../docs/keys.md) · [Signers](../../docs/signers.md) · [Conformance](../../docs/conformance.md)

## License

MIT
