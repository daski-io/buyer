# Configuration

State lives in `~/.daski/` (override with `DASKI_HOME`):

| File | Contents |
|---|---|
| `config.json` | Profiles: gateway, chain, canonical token, RPC, caps, signer |
| `orders.json` | One record per order — what makes multi-day orders survive the agent that placed them |
| `keystore.json` | Encrypted key fallback, only when no OS keychain is available |
| `cache.json` | TTL-cached catalog evidence |

The directory is created with mode `700` and the files with `600`.

## Profiles

Sandbox and mainnet are **fully separated**: distinct profile blocks, distinct
keychain entries (`payer:sandbox` vs `payer:mainnet`), distinct order records.
A misconfigured profile cannot reach across and spend real money.

```jsonc
{
  "version": 1,
  "defaultProfile": "sandbox",
  "profiles": {
    "sandbox": {
      "gatewayUrl": "https://sandbox-gateway.daski.io",
      "network": "eip155:84532",
      "chainId": 84532,
      "usdcAddress": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "rpcUrl": "https://sepolia.base.org",
      "maxPerOrderUsdc": "25.00",
      "sessionCapUsdc": "100.00",
      "requireApprovalAboveUsdc": "1.00",
      "signer": "local",
      "enabled": true
    },
    "mainnet": { "…": "scaffolded, enabled: false, caps at 0.00" }
  }
}
```

Select one with `--profile <name>` or `DASKI_PROFILE`. Neither can change what
a profile *contains* — only which human-owned block applies.

**Mainnet ships disabled**, with zeroed caps. Enabling it means editing
`enabled` to `true` and setting real caps by hand. That is deliberate: an
agent should not be able to reach mainnet through a flag.

The procedure is identical on every network: select the profile, put a key
behind it, fund its address with USDC on that network. Only the profile's
values differ — gateway, chain, token, RPC, caps.

<a id="caps"></a>
## Caps

| Key | Meaning |
|---|---|
| `maxPerOrderUsdc` | Hard ceiling for a single authorization |
| `sessionCapUsdc` | Ceiling for the running total across stored orders |
| `requireApprovalAboveUsdc` | Above this, a purchase needs an interactive human |

These are human-owned. Flags may lower them for one invocation; nothing at
runtime may raise them. See [policy.md#caps](./policy.md#caps).

Above `requireApprovalAboveUsdc`, `daski buy` shows the approval summary and
waits for a yes. In `--json` or non-TTY mode it does not silently proceed — it
exits `2` with `DASKI_HUMAN_APPROVAL_REQUIRED` and tells the human how to
approve.

## Environment

| Variable | Purpose |
|---|---|
| `DASKI_HOME` | Override `~/.daski` |
| `DASKI_PROFILE` | Default profile |
| `DASKI_PAYER_PRIVATE_KEY` | **Developer/sandbox only.** See [keys.md](./keys.md) |
| `DASKI_DISABLE_KEYCHAIN` | Force the encrypted-file keystore |
| `DASKI_CDP_ACCOUNT` | CDP account name or address for `--signer cdp`; `--cdp-account` overrides it |
| `CIRCLE_API_KEY` | Circle API key for `--signer circle`. Environment only, never a flag. See [signers.md](./signers.md#circle) |
| `CIRCLE_ENTITY_SECRET` | Circle entity secret for `--signer circle`. Environment only, never a flag |
| `DASKI_CIRCLE_WALLET` | Id of the Circle EOA wallet for `--signer circle`; `--circle-wallet` overrides it |
| `DASKI_CONFORMANCE_SPEND_OK` | Required to run the conformance suite |
