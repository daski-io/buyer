# daski-buyer

The buyer side of Daski: a CLI that pays for outcomes, and the x402 client
plugin underneath it.

| Package | What it is |
|---|---|
| [`@daski/pay`](./packages/pay) | The buyer bridge CLI (`daski`) |
| [`@daski/x402-scheme`](./packages/x402-scheme) | Composite Exact-EVM client plugin for the modular x402 v2 SDK |

## The one rule

> **Server proposes; buyer bridge validates against its own expectations and
> recomputes; wallet signs; the gateway never sees the key.**

Blind signing of server-provided material is prohibited in this codebase.
Every signature goes through the [policy validator](./docs/policy.md), and
there is no generic typed-data signing command — not as a convenience, not
behind a flag.

Concretely, before any purchase authorization is signed the bridge asserts the
chain and token are the profile's pinned values, the typed-data type set is
the closed 6-field `TransferWithAuthorization` and nothing else, the payer is
us, the recipient is corroborated by **two** independent catalog sources, the
amount matches both the challenge and the quote a human approved and fits
inside human-owned caps, the validity window is sane, and — the load-bearing
one — the authorization nonce **recomputed locally from the deal document**
equals the one proposed.

That last check is what makes the rest meaningful. The nonce is a commitment
to the whole deal, so swapping the recipient while leaving the deal document
intact changes it. A bridge that skipped the recomputation would sign that
swap happily.

## Quick start

```bash
npx @daski/pay@0.2.0 doctor --json
```

```bash
daski wallet create                     # interactive; a human must confirm
daski doctor --json                     # exit 0: signer, funds, gateway, and its MCP results check out
daski buy --provider 8327 --outcome create-mailbox --request ./request.json
daski order status <handle>
daski order artifact <handle> --output ./result.json
daski order reconcile <handle|intentId>  # the gateway's answer to "did that payment settle?"
```

`doctor` compares this release with the one the gateway pins in its
`/.well-known/mcp.json` and blocks (`DASKI_CLI_OUTDATED`) when the install is
older: releases before the pin have known payment defects.

Every command supports `--json`. Every failure exits non-zero with a stable
code and a remediation that is a command or a URL.

## Install

```bash
npm install -g @daski/pay
```

Node ≥ 20. Sandbox is Base Sepolia (`eip155:84532`); the mainnet profile is
scaffolded and **disabled by default**.

Signers: `local` (the default, verified by the conformance suite), and `cdp`
and `circle` (implemented, candidates pending conformance). Choose one per
profile or with `--signer <local|cdp|circle>`; see
[Signer adapters](./docs/signers.md).

## Using the scheme directly

If you have your own x402 host, register the composite instead of the CLI:

```ts
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { registerDaskiExactEvmScheme } from "@daski/x402-scheme";

const client = new x402Client();
registerDaskiExactEvmScheme(client, {
  network: "eip155:84532",
  signer, payerAddress, policy,
  stock: new ExactEvmScheme(account),   // the composite wraps it
  resolvePurchaseContext,
});
```

It **wraps** the stock handler rather than replacing it: the scheme name stays
`exact` (the only name the facilitator knows), and a challenge without
`daski-order-binding` is delegated to the stock handler untouched.

Runnable examples: [`examples/fetch`](./examples/fetch) and
[`examples/mcp`](./examples/mcp).

## Documentation

- [The policy validator](./docs/policy.md) — every check, and why
- [Configuration and caps](./docs/config.md)
- [Key storage](./docs/keys.md)
- [Signer adapters](./docs/signers.md)
- [Conformance suite](./docs/conformance.md)

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
```

The conformance suite runs against the live sandbox and spends real testnet
USDC, so it refuses to start without `DASKI_CONFORMANCE_SPEND_OK=1`:

```bash
DASKI_CONFORMANCE_SPEND_OK=1 DASKI_PAYER_PRIVATE_KEY=0x… \
  npm run conformance -- --profile sandbox --signer local
```

## Gateway feature staging

Some spec-01 gateway surfaces (`daski_get_payment_challenge`,
`daski-sign-request`, the `grant-read` capability flow, published recipe test
vectors) are not on the sandbox yet. The CLI implements and *keeps* the
fallbacks — an unpaid `daski_buy_outcome` for the challenge, local recipe
recomputation, per-action lifecycle signing — because those fallbacks are also
the verify-and-sign tier. They are not a lesser path; they are the path that
does not require trusting the server's arithmetic.

## Non-goals

No faucet or funding command. No sweep, recovery, or key rotation. No generic
`sign`. No policy administration commands — humans edit the config file. No
mainnet enabled by default. No MCP server of its own.

## License

MIT
