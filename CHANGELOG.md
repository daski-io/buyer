# Changelog

Notable changes to `@daski/pay` and `@daski/x402-scheme`. The two packages
share a version.

## 0.4.0 — unreleased

Both packages move together with the gateway's buyer CLI pin; there is no compatibility with earlier gateways or request shapes.

### `@daski/pay`

- **Key durability.** A local key is written only to a store whose persistence is known by construction: the OS keychain on macOS and Windows, or the encrypted file. On Linux the keyring wrapper is never loaded; `keychain` is refused there (`DASKI_KEYCHAIN_UNSUPPORTED_ON_LINUX`) and the file backend is named. `DASKI_KEY_BACKEND` (`keychain|file|circle-agent|cdp|none`) replaces `DASKI_DISABLE_KEYCHAIN`, which is removed. `DASKI_HOST_CLASS` (`durable|ephemeral`) declares where the CLI runs; no local key is created on an ephemeral host (`DASKI_LOCAL_KEY_REFUSED_ON_HOST`), and `wallet create` runs only for the `local` signer (`DASKI_WALLET_CREATE_LOCAL_ONLY`).
- **Encrypted file store.** A missing file is an empty store; an unreadable, malformed, or permission-denied one is `DASKI_KEYSTORE_UNREADABLE` and refuses creation and use. Updates hold an exclusive lock file, write an owner-only temporary file, flush, rename atomically, flush the directory, and read the new entry back to the expected address before reporting success. The passphrase comes from a terminal or `DASKI_KEYSTORE_PASSPHRASE_FILE` (regular, owner-only, never argv). scrypt now sets its memory ceiling from its parameters: the previous store never did, so Node's 32 MiB default refused the N=2^17 KDF on every file-backend use.
- **Session-keyring detection.** On Linux, `doctor` detects a key an earlier release left in the kernel session keyring (`/proc/keys`, a detector only), reports key durability `session-memory`, and blocks with `DASKI_KEY_NOT_DURABLE`; `buy` and `sign-payment` refuse the same way. There is no override and no migration; create a new wallet with the file backend.
- **Doctor facts.** The report states host class, key backend, key durability, signer kind, account type, `verifiedVia` (`recovery` or `erc1271`), deployment, and conformance separately, plus the gateway's `payerAccounts`, `confirmation`, `confirmationSigning`, and `signerClis`.
- **Contract-account signers.** New `circle-agent` adapter for the Circle agent wallet through the pinned `@circle-fin/cli` (argument arrays, 30-second deadline, only the signature retained, nothing logged); `accountType: contract`, candidate pending conformance. Contract signers must be deployed at `doctor` and `buy` (`DASKI_SIGNER_NOT_DEPLOYED`) and are offered only when the gateway lists `contract` under `payerAccounts.types` (`DASKI_GATEWAY_EOA_ONLY`); their self-test verifies the DaskiDoctor vector through a bounded `isValidSignature` call against the profile RPC. Any signature the CLI validates is `0x` plus even hex of at most 4,096 bytes; ERC-6492 wrappers are refused.
- **Delivery confirmation modes.** Requests carry `submission: sponsored|direct`. Plain wallets keep the sponsored flow with the new semantics (`submissionsUsed`, `revocationAvailable`, `finalAttestation`; `transitionsUsed` is gone): three attestations per order, the third final, revocation of the current one always available. Contract wallets (or `--submission direct`) receive a prepared EAS `attest`/`revoke` call that the CLI validates against chain facts and the profile's pinned EAS, re-encodes, and prints; it never sends a transaction. `--tx <hash>` records a submission immediately as unverified; `--check` advances it to `observed` only on a successful receipt with the matching EAS event, a binding `getAttestation`, and the gateway's finalized read; `--abandon` clears local tracking when nothing can execute. Gateway refusals `CONFIRMATION_SPONSORED_REQUIRES_EOA`, `CONFIRMATION_SPONSORSHIP_LIMIT`, `SIGNATURE_COUNTERFACTUAL_REJECTED`, and `SIGNATURE_VERIFICATION_UNAVAILABLE` (retryable) carry CLI remediations.
- **Direct-mode journal hardening.** `--check` marks a submission observed only when the gateway's finalized block is at or past the receipt's block, so a finalized read from before the transaction (which for a revocation carries a different uid) is never taken as evidence. Evidence is bound to one finalized view: the profile RPC's finalized height is read first, the receipt's block is compared with the RPC's canonical block at its height only once that height is final there (`receipt: "reorganized"` when it differs, "not finalized yet" before), attestations are read pinned to that finalized height, and the gateway's finalized block must be canonical at its height, so the receipt's block is a finalized ancestor of the anchor. A revert can be abandoned only once its block is finalized and canonical; before that the transaction may be re-included. Every matching event in a batched receipt is tried and the one whose attestation binds is taken, so another order's event first in a smart-wallet batch neither blocks verification nor lets the receipt be abandoned as unrelated. Whether an attestation is the final one is decided from chain facts in both modes; a gateway response whose count or `finalAttestation` flag disagrees is refused (`DASKI_CONFIRMATION_MISMATCH`). A hash recorded by mistake can be corrected: `--tx` replaces it and `--abandon` clears it once the recorded transaction is finalized and carries no matching EAS event (`DASKI_CONFIRMATION_TX_UNFINALIZED` until then); missing, pending, and matching receipts keep the record. One order's confirmation record is updated under a per-order lock file (`DASKI_ORDER_LOCKED` after ten seconds), so concurrent preparations cannot overwrite each other's tracking, and every write to `orders.json` runs under a store-wide lock (`DASKI_ORDER_STORE_LOCKED`), so commands for different orders cannot discard each other's updates. Locks are created atomically and already populated (a staging file hard-linked into place), record their owner process, and are reclaimed only when it is gone, never by age (a live command may be waiting on a passphrase); reclamation is serialized through a reclaim lock so two waiters cannot both unlink, and a reclaim left by a dead process is reported for manual removal rather than recovered; a lock is released only by its owner; the signer is resolved before the order lock so no prompt runs inside it. A sponsored submission refused before the gateway reserves anything (`CONFIRMATION_SPONSORSHIP_LIMIT`, `CONFIRMATION_SIGNATURE_INVALID`, `CONFIRMATION_SPONSORED_REQUIRES_EOA`, `CONFIRMATION_REQUEST_INVALID`, `CONFIRMATION_PREPARATION_STALE`) no longer blocks a direct preparation. The confirmation requests the CLI sends are proved offline against the gateway's vendored `confirmation-request-shapes.json`.
- **Conformance suite.** Records the payment identifier the gateway pinned in the challenge as the intent, submits a `Confirmed` review with `--confirm` (waiting for the order's reputation record), and stops at the validated call for a contract signer.
- **Profiles pin `easAddress`** (default `0x4200000000000000000000000000000000000021` on Base and Base Sepolia); the gateway's `confirmationSigning.eas` must equal it (`DASKI_EAS_ADDRESS_MISMATCH`).
- **Lazy signer on the read path.** Order commands build the signer only for a signature, so a stored, unexpired read capability serves reads without opening the key store; the signer must match the order's recorded payer. `daski order import --json` rehydrates `orders.json` from `daski_list_my_orders`.

### `@daski/x402-scheme`

- `SignerDescription.accountType` is `eoa | contract | unknown` (`smart-contract` is gone).

## 0.3.0 — unreleased

- New profiles approve each paid quote without default per-order or cumulative budgets. Existing settings survive upgrades; `daski budget` can explicitly change or remove them.
- `buy` and `sign-payment` share an approval identifier bound to the request, provider, payer, network, token, recipient, amount, and published terms. Use `--approve <approval.id>` after approval; unchanged terms can survive quote refresh. This replaces `buy --yes`.
- Purchase preflight reports the actual funding shortfall and terms. The full `buy` regression path signs and submits the gateway-issued payment identifier.
- Automatic reconciliation uses the exact identifier and preserves in-flight or ambiguous states. Similar price/time rows no longer establish settlement or absence.
- Order reads use the gateway's `grant-read` action and `readCapability` field. Delivery reviews now support explicit labels, final-transition acknowledgment, revocation, and resuming the same signed submission.
- Setup and command documentation use native doctor paths, reuse existing signers, and describe authorized setup and recoverable errors directly.

Release coordination: publish both buyer packages before deploying the gateway's 0.3.0 pin. Deploy provider intake support before the gateway workflow and refresh the entity service registration so its schema and descriptions stay aligned. A develop push does not perform these release steps.

## 0.2.0 — 2026-09-04

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
