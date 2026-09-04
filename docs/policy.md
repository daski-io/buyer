# Payment and lifecycle validation

The bridge builds typed data from the purchase's expected values and validates it before invoking the configured signer. A failed check returns a structured code, expected and actual values, and a recovery action.

## Independent expectations

<a id="chain-pinning"></a>
### 1. Chain and token

The domain chain and verifying contract, challenge network, and challenge asset match the active profile's pins.

<a id="typed-data-shape"></a>
### 2. Typed-data shape

A purchase uses the closed six-field `TransferWithAuthorization` type, with the expected field names, types, and order. The bridge signs its own type definition.

<a id="payer"></a>
### 3. Payer

The transfer's `from` address matches the configured signer.

<a id="splitter-allowlist"></a>
### 4. Recipient

The transfer's `to` address matches the outcome catalog's splitter and the gateway's chain manifest. Both catalog reads have a five-minute cache lifetime. Disagreement returns `DASKI_POLICY_SPLITTER_EVIDENCE_DISAGREES`.

<a id="amount"></a>
### 5. Amount and approval

The signed amount matches the challenge and approved quote. Both CLI purchase entry points require approval above the profile's explicit allowance, which defaults to zero.

An approval identifier binds the gateway, payer, provider, outcome, request hash, chain/network, token, recipient, amount, listing commitment, and provider terms commitment. Quote expiry, order nonce, and quote hash are excluded so a fresh quote with unchanged material terms can reuse approval. A changed material term returns `DASKI_QUOTE_CHANGED` with the new quote for review.

The identifier also distinguishes successive purchases using the durable ledger. A second identical purchase needs a new approval. An authorized or pending purchase with matching terms is reconciled first.

Optional per-order and cumulative budgets apply when configured. The cumulative amount comes from the profile's durable order ledger.

<a id="window"></a>
### 6. Validity window

`validAfter` is zero or between now minus 3,600 seconds and now. `validBefore` is more than 15 and at most 900 seconds ahead, and stays within the binding's expiry.

<a id="reconciliation"></a>
### 7. Payment identifier and reconciliation

Both `buy` and `sign-payment` use the identifier issued in `payment-identifier.info.id` as the submission identifier and ledger key. An existing authorized or paid identifier is reconciled before another signature.

Automatic recovery and `daski order reconcile <intentId>` use a payer-authorized gateway lookup filtered by that exact identifier. A settled state recovers the order handle. In-flight, ambiguous, unknown, or unidentified legacy rows stay unresolved. Recovery uses no additional payment signature.

A definitive no-settlement response records `NOT_SETTLED`, which consumes no budget. Resolve the original refusal's cause before another purchase. Gateway order state establishes settlement; balances and local handles do not establish absence.

<a id="lifecycle"></a>
### 8. Lifecycle actions

Order actions and wallet queries use their own closed EIP-712 families. The bridge verifies the intended action, gateway, request hash, chain, and expiry, then recomputes the message. A server `signRequest`, when present, must agree with that recomputation.

```
absoluteResourceUri = {gateway}/orders/{encodeURIComponent(handle)}/actions/{action}
requestHash = keccak256(canonicalJson(request))
```

Read access uses the `grant-read` action. The returned `readCapability` permits status and artifact reads until expiry or revocation. Mutations use fresh action authorization. Payer history uses the wallet's `list-orders` action.

Delivery reviews use the closed EAS Attest or Revoke type. The CLI reads deployment pins separately from the preparation, verifies the payer and provider against the onchain order, and rebuilds the message from the selected label, order key, schema, recipient, current review UID, and EAS nonce. The message transfers zero value, expires within 330 seconds, and needs explicit final-transition acknowledgment when two transitions have already been used. Pending submissions retain the same EAS signature for retries.

<a id="recipe"></a>
## Nonce recipe

```
nonce = keccak256(abi.encode(
  keccak256(utf8("DaskiStandardExactOrderV2")),
  chainId, canonicalToken, payer, splitter, grossAmount,
  runtimeCommitmentHash, providerIntentHash,
  quoteHash, canonicalRequestHash, orderNonce))
```

Version 1 uses `DaskiStandardExactOrderV1` and the corresponding `listingManifestHash` and `providerOfferHash` slots.

<a id="sign-request"></a>
## Sign requests and binding extensions

The bridge recomputes the payment proposal from the challenge binding, validates it against profile and catalog expectations, and signs the resulting authorization. It returns the payment extensions while excluding the instructional `daski-sign-request`.

<a id="daski-order-binding"></a>
The `daski-order-binding` parser accepts the supported closed version 1 and version 2 shapes. Unsupported fields or profiles return a schema error.

<a id="caps"></a>
## Optional budgets

New profiles have no additional default budgets. Existing configurations retain their selected values during upgrades. `daski budget` provides an explicit way to view, change, or remove stored budgets. Temporary limits fit within any existing budget. See [configuration](./config.md#budgets).
