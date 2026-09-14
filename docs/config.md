# Configuration

Doctor reports the resolved `stateDirectory` and `configFile`. The default is `.daski` beneath Node's native `os.homedir()`, overridden by `DASKI_HOME`. On Windows this may differ from a Bash shell's `~`.

| File | Contents |
|---|---|
| config.json | Profiles: gateway, chain, canonical token, EAS address, RPC, spending settings, signer |
| orders.json | Durable intents, handles, states, read capabilities, pending sponsored reviews, and direct-mode confirmation records |
| keystore.json | The encrypted file key store (`DASKI_KEY_BACKEND=file`); `keystore.json.lock` exists only during an update |
| cache.json | Catalog evidence with an expiry |

POSIX directories use mode 700 and files use 600. Windows uses native ACLs.

`orders.json` is replaced atomically: a flushed temporary file renamed into place, then the directory flushed. A missing file is an empty ledger; one that exists but cannot be read, parsed, or trusted refuses every command that needs it (`DASKI_ORDER_STORE_UNREADABLE`) and is never overwritten. Repair it, or move it aside and rebuild it with `daski order import --json`.

Lock files beside it (`orders.json.lock`, per-order `.lock` files, `keystore.json.lock`) record their owner's process identity: on Linux the kernel boot id, the pid namespace, and the process start time; elsewhere the hostname. A lock is reclaimed only when that identity is verifiable from the waiting process and shows the owner gone. A lock from another boot, pid namespace, or host (a container mount, or Windows and WSL sharing `DASKI_HOME`), or one whose owner cannot be checked, is left in place and the command reports it for manual removal once no daski process is running.

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
      "easAddress": "0x4200000000000000000000000000000000000021",
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

The generated file also includes a disabled mainnet profile. Enable it when the user selects that network. Profiles use separate key entries and order records. Select a profile with `--profile` or `DASKI_PROFILE`.

`signer` is one of `local`, `circle-agent`, `cdp`, `circle`; see [signers](./signers.md).

`easAddress` pins the EAS contract delivery confirmations are attested through. On Base and Base Sepolia it defaults to the canonical predeploy `0x4200000000000000000000000000000000000021`; on any other chain it must be set. The gateway's `confirmationSigning.eas` must equal it: `doctor` blocks with `DASKI_EAS_ADDRESS_MISMATCH` and no confirmation is prepared or signed while they disagree.

`rpcUrl` is used for reads only: balances, contract code, receipts, attestations, and the ERC-1271 self-test. The CLI never sends a transaction through it.

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
| DASKI_HOST_CLASS | `durable` on the user's own machine, `ephemeral` on an agent-managed, shared, or resettable host; no local key is created on an ephemeral host. Unset reads as `undeclared` |
| DASKI_KEY_BACKEND | `keychain` (macOS, Windows), `file`, `circle-agent`, `cdp`, or `none`; see [keys](./keys.md) |
| DASKI_KEYSTORE_PASSPHRASE_FILE | A regular, owner-only file holding the encrypted file store's passphrase, for sessions without a terminal |
| DASKI_PAYER_PRIVATE_KEY | Sandbox development signer; see [keys](./keys.md) |
| DASKI_CDP_ACCOUNT | CDP account for the CDP signer |
| CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET | Circle developer-controlled wallet credentials supplied through the protected environment |
| DASKI_CIRCLE_WALLET | Circle developer-controlled EOA wallet identifier |
| DASKI_CONFORMANCE_SPEND_OK | Explicit opt-in to the live spending test suite |
