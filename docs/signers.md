# Signer adapters

Every wallet backend implements one small interface:

```ts
interface SignerAdapter {
  getAddress(): Promise<Address>;
  signTypedData(payload: TypedDataRequest): Promise<Hex>;
  describe(): { provider: string; accountType: "eoa" | "smart-contract" | "unknown";
                conformance?: "verified" | "candidate-pending-conformance" };
}
```

Deliberately tiny: an address, a typed-data signature, a self-description. No
raw message signing, no transaction signing, no key export.

The [conformance suite](../packages/pay/conformance/run.ts) is the acceptance
gate for every adapter. `describe()` reports conformance status so
`daski doctor` can say out loud what has and has not been established, rather
than implying a guarantee nobody has checked.

<a id="self-test"></a>
## The doctor self-test

`daski doctor` does not take an adapter's word for it either. Before it
reports a signer as usable it has the signer sign one fixed vector and checks
the result the way the gateway will:

- the address recovered from the typed data equals the address the adapter
  reports — which also proves no field was rewritten before signing;
- `s` is at most `secp256k1n/2` (low-s), the only form the gateway's ECDSA
  recovery accepts;
- the signature is 65 bytes.

The vector has the shape of a purchase — the closed 6-field
`TransferWithAuthorization` type set — but can never be one: the domain is
`DaskiDoctor` with a zero verifying contract rather than any token's, the
value and recipient are zero, and the validity window is closed.

A failure is blocking, reported as `DASKI_SIGNER_SELF_TEST_FAILED` with the
reason (recovered-address mismatch, high-s, malformed, or the error the signer
threw), and the report carries the details under `signer.selfTest`. It is a
local check with nothing at stake; the conformance suite remains the
acceptance gate.

## `local` — implemented, verified

A viem account from the key store. Reports `eoa` / `verified`.

```bash
daski doctor --signer local --json
```

<a id="cdp"></a>
## `cdp` — scaffolded, candidate pending conformance

CDP Server Wallets v2 through `@coinbase/cdp-sdk`, which exposes a
viem-compatible account, so the adapter is thin: resolve an account, forward
typed-data signing.

What is **not** yet established is whether that account's signatures satisfy
the gateway's plain low-s ECDSA recovery across every account type CDP can
mint. Until a conformance run answers that, `describe()` reports
`candidate-pending-conformance` and `doctor` raises a warning.

`@coinbase/cdp-sdk` is not a dependency of `@daski/pay` — installing it is
your choice, and the local signer should not carry its weight.

```bash
npm install @coinbase/cdp-sdk
export DASKI_CDP_ACCOUNT=my-account
DASKI_CONFORMANCE_SPEND_OK=1 npm run conformance -- --profile sandbox --signer cdp
```

<a id="circle"></a>
## `circle` — implemented for EOA wallets, candidate pending conformance

Circle Developer-Controlled Wallets through
`@circle-fin/developer-controlled-wallets`. The adapter resolves the wallet,
refuses anything that is not an externally owned account, and forwards the
validated typed data — domain, types, primaryType, message, exactly as the
policy validator produced it — to Circle's `signTypedData`. Nothing is added
and nothing is rewritten; the doctor self-test checks that by recovering the
signer from the same data.

**Only the `EOA` account type is accepted.** Circle can also mint
smart-contract accounts (`SCA`), which sign through ERC-1271: the contract
decides what a valid signature is. The gateway verifies purchase
authorizations by plain low-s ECDSA recovery of an EOA, which cannot verify an
ERC-1271 signature, and no amount of adapter code changes that. Selecting an
SCA wallet fails with `DASKI_CIRCLE_SCA_UNSUPPORTED` rather than producing
signatures the facilitator cannot verify.

What is not yet established is that Circle's EOA signatures settle on the
live gateway end to end. Until this passes, `describe()` reports
`candidate-pending-conformance` and `doctor` raises a warning:

```bash
npm install @circle-fin/developer-controlled-wallets
export CIRCLE_API_KEY=…
export CIRCLE_ENTITY_SECRET=…
export DASKI_CIRCLE_WALLET=<wallet id>
DASKI_CONFORMANCE_SPEND_OK=1 npm run conformance -- --profile sandbox --signer circle
```

| Variable | Purpose |
|---|---|
| `CIRCLE_API_KEY` | Circle API key. Environment only — never a flag, so it never reaches a process list or a shell history |
| `CIRCLE_ENTITY_SECRET` | The entity secret registered with Circle. Environment only, for the same reason |
| `DASKI_CIRCLE_WALLET` | Id of the Circle wallet to sign with; `--circle-wallet <id>` overrides it for one invocation |

Credentials are never printed, never logged, and never sent to the gateway.
The SDK is not a dependency of `@daski/pay` — installing it is your choice —
and it requires Node 22 or later. The wallet must be an EVM wallet whose funds
sit on the profile's chain (`BASE-SEPOLIA` or `EVM-TESTNET` for the sandbox).

Refusals, each with the command that fixes it: `DASKI_CIRCLE_CREDENTIALS_UNSET`,
`DASKI_CIRCLE_WALLET_UNSET`, `DASKI_CIRCLE_SDK_MISSING`,
`DASKI_CIRCLE_SCA_UNSUPPORTED`, `DASKI_CIRCLE_WALLET_NOT_EVM`.

## Adding an adapter

1. Implement `SignerAdapter`.
2. Register it in `packages/pay/src/signers/index.ts`.
3. Report `candidate-pending-conformance` from `describe()`.
4. Pass `daski doctor`: the [self-test](#self-test) runs on every adapter.
5. Run the suite: `DASKI_CONFORMANCE_SPEND_OK=1 npm run conformance -- --signer <name>`.
6. Promote to `verified` only once it passes.
