# Changelog

Notable changes to `@daski/pay` and `@daski/x402-scheme`. The two packages
share a version.

## 0.1.0 — 2026-09-02

Initial release.

### `@daski/x402-scheme`

- Composite Exact-EVM client plugin for the modular x402 v2 SDK. It wraps the
  stock handler rather than replacing it, keeps the `exact` scheme name, and
  delegates any challenge without `daski-order-binding` untouched.
- The policy validator: chain pinning, the closed 6-field
  `TransferWithAuthorization` type set, payer match, a splitter corroborated by
  two catalog sources, amount and human-owned caps, a sane window, an unused
  payment identifier, and lifecycle URIs and request hashes recomputed rather
  than accepted. Every failure is a structured `PolicyRefusal`, never a
  repaired payload.
- Recipe nonce recomputation (`recipe-bound-v1`, `recipe-bound-v2`), pinned by
  tests against an independently produced vector.

### `@daski/pay`

- The `daski` CLI: `doctor`, `wallet create|address|balance`, `buy`,
  `order status|artifact|confirm|input|cancel`, `sign-payment`. `--json`
  everywhere; every failure carries a stable code and a remediation.
- Caps that live only in `~/.daski/config.json` and that no flag or
  environment variable can raise; interrupted purchases reconciled, never
  re-signed; orders that survive the process that placed them.
- Key storage: OS keychain first, an scrypt + AES-256-GCM file as the
  fallback, and a sandbox-only environment variable that `doctor` flags.
- Signer adapters: `local`, verified by the conformance suite; `cdp` and
  `circle` as candidates pending conformance. The Circle adapter accepts EOA
  wallets only and refuses smart-contract accounts, whose ERC-1271 signatures
  the gateway's plain ECDSA recovery cannot verify.
- A `doctor` self-test for every signer: it signs a fixed, unsettleable
  vector, and the signature must recover to the adapter's own address with a
  low-s value before the signer is reported usable.
- A network-agnostic funding message from `doctor`: one sentence on every
  chain, naming only the address and the network.
- The conformance suite (`npm run conformance`), which spends testnet USDC and
  therefore refuses to start without `DASKI_CONFORMANCE_SPEND_OK=1`.
