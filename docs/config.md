# Configuration

Doctor reports the resolved `stateDirectory` and `configFile`. The default is `.daski` beneath Node's native `os.homedir()`, overridden by `DASKI_HOME`. On Windows this may differ from a Bash shell's `~`.

| File | Contents |
|---|---|
| config.json | Profiles: gateway, chain, canonical token, RPC, spending settings, signer |
| orders.json | Durable intents, handles, states, and read capabilities |
| keystore.json | Encrypted fallback when the OS keychain is unavailable |
| cache.json | Catalog evidence with an expiry |

POSIX directories use mode 700 and files use 600. Windows uses native ACLs.

## Profiles

```json
{
  "version": 2,
  "defaultProfile": "sandbox",
  "profiles": {
    "sandbox": {
      "gatewayUrl": "https://sandbox-gateway.daski.io",
      "network": "eip155:84532",
      "chainId": 84532,
      "usdcAddress": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "rpcUrl": "https://sepolia.base.org",
      "maxPerOrderUsdc": null,
      "sessionCapUsdc": null,
      "requireApprovalAboveUsdc": "0.00",
      "signer": "local",
      "enabled": true
    }
  }
}
```

The generated file also includes a disabled mainnet profile. Enable it when the user selects that network. Profiles use separate keychain entries and order records. Select a profile with `--profile` or `DASKI_PROFILE`.

Version 1 configuration remains readable. Upgrades preserve its values, including old default budgets, because existing files do not record whether the user selected those values. The explicit budget command writes version 2 when changing settings.

<a id="caps"></a>
## Budgets

| Setting | Meaning |
|---|---|
| maxPerOrderUsdc | Optional per-purchase budget; null means no additional budget |
| sessionCapUsdc | Optional total across recorded authorizations for the profile |
| requireApprovalAboveUsdc | A user-selected allowance; amounts above it require quote approval |

New profiles use null budgets and an allowance of zero. Both `buy` and `sign-payment` enforce quote approval. JSON and non-interactive use returns `DASKI_HUMAN_APPROVAL_REQUIRED` with `approval.id`; after approval, repeat with `--approve <approval.id>`.

```bash
daski budget --json
daski budget --per-order 30 --total 100 --approval-above 0 --json
daski budget --per-order none --total none --json
```

Use settings changes when the user requests them. `--max-per-order` and `--session-cap` are temporary limits and cannot exceed an existing budget. The total includes authorized and unresolved payments across CLI runs, excluding unsigned intents and definitive no-settlement responses.

## Environment

| Variable | Purpose |
|---|---|
| DASKI_HOME | Override the native state directory |
| DASKI_PROFILE | Default profile |
| DASKI_PAYER_PRIVATE_KEY | Sandbox development signer; see [keys](./keys.md) |
| DASKI_DISABLE_KEYCHAIN | Use the encrypted file store |
| DASKI_CDP_ACCOUNT | CDP account for the CDP signer |
| CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET | Circle credentials supplied through the protected environment |
| DASKI_CIRCLE_WALLET | Circle EOA wallet identifier |
| DASKI_CONFORMANCE_SPEND_OK | Explicit opt-in to the live spending test suite |
