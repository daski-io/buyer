# `@daski/x402-scheme`

A composite Exact-EVM client plugin for the modular x402 v2 SDK, and the
policy validator that decides whether a challenge may be signed at all.

```bash
npm install @daski/x402-scheme @x402/core @x402/evm
```

## It wraps, it does not replace

```ts
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { registerDaskiExactEvmScheme } from "@daski/x402-scheme";

const client = new x402Client();
registerDaskiExactEvmScheme(client, {
  network: "eip155:84532",
  signer,                              // your SignerAdapter
  payerAddress,
  policy,                              // PolicyConfig — no config, no signing
  stock: new ExactEvmScheme(account),  // wrapped, not discarded
  resolvePurchaseContext,              // what you're buying, what you approved
});
```

On `PaymentRequired`:

- **`extensions["daski-order-binding"]` present** → the Daski path: validate,
  recompute, sign.
- **absent** → the wrapped stock handler, called with the same requirements and
  context objects, by reference, untouched.

The scheme name stays `"exact"`, because that is the only name the facilitator
knows — inventing a second one would make the payments unverifiable.
`findDefaultAsset` and `schemeHooks` are forwarded, so registering the
composite does not quietly disable the host's spend controls.

## The policy validator

`PolicyConfig` is required. No config, no signing.

Every expectation is config- or catalog-sourced; nothing is read from the
challenge being validated. Before any purchase authorization is signed:

1. Chain and verifying contract equal the pinned profile values
2. `types` is exactly the closed 6-field `TransferWithAuthorization`
3. `message.from` is the configured payer
4. `message.to` is corroborated by **two** independent catalog sources
5. The amount matches the challenge, the approved quote, and the caps
6. The validity window is sane, and does not outlive the binding
7. The payment identifier is unused
8. (Lifecycle) the action URI and request hash are **recomputed**, not accepted

Failures raise `PolicyRefusal`, carrying the failed check, a stable code, and
a remediation. The validator never repairs a payload and proceeds.

## Recipe recomputation

```ts
import { recipeNonceV2 } from "@daski/x402-scheme";
```

The authorization nonce is a commitment to the whole deal — chain, token,
payer, splitter, amount, and the five deal hashes. Recomputing it locally is
what lets you sign a server-proposed authorization without trusting the
server. When the gateway supplies `daski-sign-request`, its proposal is
treated as an input: recomputed, compared, and refused on mismatch.

Both `recipeNonce` (v1) and `recipeNonceV2` are implemented and pinned by
tests against a vector produced independently by the reference client behind
43 settled sandbox orders.

## Examples

[`examples/fetch`](../../examples/fetch) · [`examples/mcp`](../../examples/mcp)

## License

MIT
