# Changelog

Notable changes to `@daski/pay` and `@daski/x402-scheme`. The two packages
share a version.

## Unreleased

### `@daski/pay`

- **`buy` carries the gateway's payment identifier.** 0.1.2 fixed
  `sign-payment` but left `buy` minting a fresh identifier after the
  challenge; its own mismatch check then refused every challenge with
  `DASKI_PAYMENT_IDENTIFIER_MISMATCH` before signing. The 0.1.2 changelog
  claimed `buy` proposed its identifier at challenge time and the gateway
  echoed it: the gateway never accepted a proposal, and `buy` never sent one.
  Neither published release could complete a purchase through `buy`; the
  harness proves the CLI through `sign-payment` only, which is why this was
  not caught (2026-09-04). Both commands now take the issued identifier as
  the ledger key, so the local record and `daski_list_my_orders` agree.
- **Reconciliation follows the gateway's `paymentMayHaveSettled` flag.** The
  ambiguous-code list (`PAYMENT_PENDING_RECONCILIATION`,
  `PAYMENT_OUTCOME_PENDING`) is now only the fallback for gateways without
  the flag. A `PAYMENT_IDENTIFIER_CONFLICT` flagged settled-maybe was recorded
  as `PENDING_RECONCILIATION` without reconciling, and `order status` on that
  intent told the operator to re-run `daski buy`, which an agent did against
  a gateway answer that said "do not re-sign" (2026-09-04). A refusal that
  says nothing settled (`paymentMayHaveSettled: false`, for example the
  gateway's new `PAYMENT_IDENTIFIER_UNKNOWN`) records the intent as
  `NOT_SETTLED`: it consumes no session budget and may be signed for again
  once the cause is fixed.
- **`order reconcile <handle|intentId>`.** The gateway's own answer for one
  payment identifier through `daski_list_my_orders` (filtered server-side,
  signing only the wallet-action read): the order's handle and state when it
  exists, `NOT_SETTLED` when the gateway lists nothing for the identifier,
  and "in flight" or "ambiguous" when the money is still moving. This is the
  remediation `order status` now names for an intent without a handle; the
  old text told the operator to re-run `daski buy`.
- **`doctor` blocks on an outdated release.** It reads the gateway's pinned
  buyer CLI from `/.well-known/mcp.json` (`buyerCli`, gateway 2026-09-04 and
  later) and reports `DASKI_CLI_OUTDATED` when this install is older; the
  report carries the pin under `gateway.pinnedCli`. A 0.1.0 install ran
  against a 0.1.2 pin unnoticed on 2026-09-04 because the pin lived only in
  the setup guide's prose. A gateway without the field reads as no pin.

### `@daski/x402-scheme`

- The `DASKI_POLICY_IDENTIFIER_ALREADY_ORDERED` remediation names
  `daski order reconcile <identifier>` instead of `order status <handle>`,
  which cannot run for an intent that never received a handle.

## 0.1.2 — 2026-09-03

### `@daski/pay`

- **`sign-payment` carries the gateway's payment identifier.** A challenge the
  caller obtained itself already has an identifier bound by the gateway
  (`payment-identifier.info.id`); 0.1.1 minted a fresh one, and the gateway,
  which looks a paid submission up by identifier, refused every such payment
  with `PAYMENT_IDENTIFIER_CONFLICT` before settlement. Found by the harness's
  published-CLI acceptance lane on its first live run against gateway v0.31.0
  (2026-09-03). The signed payload and the local order record now use the
  issued identifier; a fresh one is minted only for a challenge without one.
  A challenge bound to a different identifier than the one a purchase
  proposed is refused (`DASKI_PAYMENT_IDENTIFIER_MISMATCH`), never signed.
  *Correction (2026-09-04): this entry originally said `buy` was unaffected
  because it proposed its identifier at challenge time and the gateway echoed
  it. `buy` never sent a proposal and the gateway never accepted one, so
  0.1.2's `buy` refuses every gateway challenge with that mismatch before
  signing; see Unreleased.*

### `@daski/x402-scheme`

- Version bump only; `@daski/pay` pins it exactly.

## 0.1.1 — 2026-09-03

### `@daski/pay`

- **Reads gateway results from `structuredContent`.** Gateway v0.28.0
  (2026-09-01) moved every ordinary tool payload into MCP `structuredContent`
  and left a one-line summary in the text block; 0.1.0 read text only, so every
  gateway call parsed as empty and each site reported its own wrong diagnosis
  (`DASKI_OUTCOME_NOT_FOUND` for an outcome that existed, `DASKI_PURCHASE_FAILED`
  with `gateway: null`). `structuredContent` is now authoritative, with the JSON
  text block as the fallback, so the CLI reads gateways on either side of the
  change.
- **Reads the prepare tool's challenge.** `daski_get_payment_challenge` nests
  the x402 challenge under `paymentRequired` beside a `preflight`; 0.1.0
  expected a bare challenge and failed step one on every gateway that
  advertised the tool. The challenge is now read from `_meta`, the nested body,
  or a bare body, in that order, and `sign-payment` accepts the prepare tool's
  saved output as a challenge file.
- **Preflight is honoured.** A prepare result with `sufficient: false` stops
  with `DASKI_INSUFFICIENT_USDC` naming the payer, balance, network, and price
  before anything is signed; the gateway's one-sentence `approvalSummary` leads
  the approval prompt.
- **An unreadable success is never a refusal.** A result without an error and
  without a payload this CLI can read is `DASKI_GATEWAY_RESULT_UNREADABLE`, with
  the raw result attached and a remediation that depends on whether a signature
  has left the process. After a paid submit it routes into reconciliation
  instead of failing; `gateway: null` is gone from every error.
- **`doctor` proves the protocol.** One read-only MCP round trip
  (`daski_get_setup_guide`, else `daski_list_outcomes`) parsed with the CLI's
  own reader; `DASKI_GATEWAY_PROTOCOL_MISMATCH`, `DASKI_GATEWAY_MCP_UNREACHABLE`,
  and `DASKI_GATEWAY_TOOLS_MISSING` block. `/health/ready` alone had reported
  `ok: true` for a CLI that could not complete one call.
- **Key creation no longer advertises its bypass.** The non-TTY refusal tells
  the operator that a human must run `daski wallet create` in their own
  terminal; it no longer names `--yes-human-approved`, which an agent read as an
  instruction.
- **Windows:** the world-writable warning is skipped on `win32`, where Node's
  synthetic mode bits made it a permanent false positive.
- **Wire contract tests.** The gateway's wire fixtures are vendored under
  `test/fixtures/gateway-wire/` and every parser runs over them offline, so a
  gateway shape change fails a unit test here before it fails a purchase.

### `@daski/x402-scheme`

- **Sign-ready lifecycle challenges validate.** The gateway attaches the
  complete EIP-712 proposal as `signRequest` beside every wallet and
  order-action challenge; 0.1.0's closed-shape check refused that field as an
  open shape, so every order read, lifecycle action, and wallet query against
  the live gateway failed. The proposal is now set aside for the shape check and
  compared, field for field, with the typed data the validator recomputes;
  a difference is `DASKI_LIFECYCLE_SIGN_REQUEST_MISMATCH` and is refused. The
  bridge still signs only its own recomputation. `OrderActionExpectations`
  gains an optional `chainId` so the proposal's domain is checked too.

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
