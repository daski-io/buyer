# The policy validator

> Server proposes; buyer bridge validates against its own expectations and
> recomputes; wallet signs; the gateway never sees the key.

Blind signing of server-provided material is prohibited in this codebase.
Every signature — purchases and lifecycle actions alike — passes through the
validator in `@daski/x402-scheme`. There is no generic typed-data signing
command, and adding one would defeat the point of the package.

A failed check produces a **structured refusal**, never a repaired payload.
The bridge does not "fix and proceed": if the deal it was shown is not the
deal it would be signing, the correct outcome is to stop and say which check
failed.

```jsonc
{
  "error": "policy_refusal",
  "check": "splitter-allowlist",
  "code": "DASKI_POLICY_SPLITTER_NOT_ALLOWLISTED",
  "expected": "to 0xE25b… for 8327/create-mailbox",
  "actual": "to 0x5555…",
  "remediation": "The challenge pays an address the catalog does not list for this outcome. Do not sign; see …"
}
```

## Independent expectations

Every expectation is config- or catalog-sourced. **None of it is read from the
challenge being validated** — that would be asking the counterparty to grade
its own homework.

<a id="chain-pinning"></a>
### 1. Chain pinning

`domain.chainId` and `domain.verifyingContract` must equal the active
profile's pinned values. For `sandbox` that is chain `84532` and USDC at
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`. The challenge's
`accepts[].asset` and `accepts[].network` are checked against the same pins.

<a id="typed-data-shape"></a>
### 2. A closed type set

`types` must be *exactly* the 6-field `TransferWithAuthorization`: same field
names, same types, same order, nothing extra at either level. `primaryType`
must match, and the message must carry exactly those six keys.

The bridge never signs a server-supplied `types` object. It signs its own
literal, after confirming the server asked for that one. An extra field is a
field nobody validated and nobody fed into the recipe recomputation.

<a id="payer"></a>
### 3. The payer is us

`message.from` must equal the configured payer address. Run
`daski doctor --json` to see which address that is.

<a id="splitter-allowlist"></a>
### 4. The splitter is allowlisted, twice

`message.to` must match the `splitterAddress`/`payTo` for this
provider + outcome as retrieved by a **separate `daski_get_outcome` call**,
*and* appear in `.well-known/daski-chain.json`. Both are cached with a
5-minute TTL.

Two sources, because one source that is also the counterparty is not
evidence. If they disagree, the bridge refuses and says so
(`DASKI_POLICY_SPLITTER_EVIDENCE_DISAGREES`) rather than picking a winner.

<a id="amount"></a>
### 5. The amount

`message.value` must equal the challenge's `accepts[].amount`, equal the quote
a human approved, and sit at or below `maxPerOrderUsdc`. The running session
total plus this payment must stay within `sessionCapUsdc`.

The running total is read from `~/.daski/orders.json`, so the cap survives the
process that placed the earlier orders.

<a id="window"></a>
### 6. A sane window

`validAfter ∈ {0} ∪ [now − 3600, now]`, and `validBefore − now` must be at
most 900 seconds and more than 15. An authorization may not outlive the
binding it commits to.

Long-lived authorizations are long-lived liabilities; ones that expire during
settlement fail in the most confusing way available.

<a id="reconciliation"></a>
### 7. The payment identifier

The `payment-identifier` id must be the one this purchase created, and no
stored order may already exist for it.

The dangerous moment in a buyer bridge is not the signature — it is the
silence after it. On a timeout, a `PAYMENT_PENDING_RECONCILIATION`, or a
transport drop after submit, the bridge **reconciles before any re-sign**:

1. **Replay the identical signed authorization.** The recipe nonce is
   deterministic, so the resubmission is byte-identical, and the gateway's
   published retry policy treats an identical signed authorization as
   `transport-retry-same-purchase`. This cannot create a second order.
2. **Corroborate against the payer's own order history**
   (`daski_list_my_orders`, itself wallet-authorized). Once the gateway echoes
   `paymentIdentifier` on a row, the filter is exact; until then the intent's
   other invariants are matched, and an empty result from a field that does not
   exist is *not* treated as evidence of absence.

Only when both agree no order exists does the CLI report the purchase as
provably unsettled and safe to retry. A second signature over a fresh
challenge is a second order, and a second charge.

<a id="lifecycle"></a>
### 8. Lifecycle actions

Order actions and wallet queries move authority rather than money, so they get
the same treatment: the family's closed type set, an `orderId`/handle that
matches the target order, a short expiry, and — crucially — **method and URI
hash inputs recomputed from what the CLI is about to call**.

The gateway attaches its sign-ready EIP-712 proposal as `signRequest` beside
each of these challenges. The bridge sets it aside for the closed-shape check,
recomputes the typed data from the challenge fields, and requires the proposal
to agree field for field (`DASKI_LIFECYCLE_SIGN_REQUEST_MISMATCH` otherwise).
It signs only its own recomputation. Any other extra field is still refused.

The gateway derives both deterministically:

```
absoluteResourceUri = {gateway}/orders/{encodeURIComponent(handle)}/actions/{action}
requestHash         = keccak256(canonicalJson(request))
```

So the bridge recomputes them instead of accepting them. A challenge that
hashes a different request, or points at a different order or host, is a
challenge for someone else's call.

Wallet challenges additionally assert the *unbound* variant: a read must not
smuggle a provider binding past it.

<a id="recipe"></a>
## Recipe recomputation

The nonce of a Daski EIP-3009 authorization is not random. It is a commitment
to the whole deal:

```
nonce = keccak256(abi.encode(
  keccak256(utf8("DaskiStandardExactOrderV2")),   // bytes32
  chainId,                                        // uint256
  canonicalToken, payer, splitter,                // address ×3
  grossAmount,                                    // uint256
  runtimeCommitmentHash, providerIntentHash,      // bytes32 ×2
  quoteHash, canonicalRequestHash, orderNonce))   // bytes32 ×3
```

`recipe-bound-v1` uses the identical layout with
`keccak256(utf8("DaskiStandardExactOrderV1"))` and the
`listingManifestHash`/`providerOfferHash` slots.

Recomputing this locally is what lets the bridge sign a server-proposed
authorization without trusting the server. If our nonce and theirs disagree,
the deal we were shown is not the deal we would be signing —
`DASKI_POLICY_RECIPE_NONCE_MISMATCH`, and the run stops.

This is not theoretical. Swap the recipient while leaving the deal document
intact and the recomputed nonce changes, because `splitter` is one of its
inputs. That case is covered by a test.

<a id="sign-request"></a>
## `daski-sign-request`

When the gateway ships a fully-formed typed-data proposal, the bridge treats
it as an *input*, not an authority: it parses it into a closed shape, runs the
same §4 checks, recomputes the nonce, and requires equality. A proposal that
survives all of that is signed; one that does not is reported.

`daski-sign-request` is never echoed back with the payment. Echoing it would
assert we agreed to a document we only used as an input.

<a id="daski-order-binding"></a>
## `daski-order-binding`

Parsed as a closed shape. An extra field is refused rather than trimmed,
because an unrecognized layout cannot be recomputed, and what cannot be
recomputed cannot be signed.

<a id="caps"></a>
## Caps are human-owned

`maxPerOrderUsdc`, `sessionCapUsdc` and `requireApprovalAboveUsdc` live only
in `~/.daski/config.json`.

**No CLI flag and no environment variable can raise them.** `--max-per-order`
and `--session-cap` may *lower* a cap for a single invocation; a value above
the configured one is refused (`DASKI_CAP_OVERRIDE_WOULD_RAISE`). Raising a
cap is a documented human action: edit the file.

The CLI warns when the config file or state directory is world-writable, since
either would let any local process rewrite the caps.
