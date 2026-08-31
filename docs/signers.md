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

## `local` — implemented

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
## `circle` — documented, not implemented

The intended path is `circle wallet sign typed-data`.

**Open question:** Circle signs from a smart-contract account, and
smart-contract-account signatures (ERC-1271) may not satisfy the gateway's
plain low-s ECDSA recovery. If they do not, no amount of adapter code helps —
the gateway would have to accept ERC-1271 verification.

Selecting `--signer circle` fails with that explanation rather than producing
signatures that might be unverifiable. Shipping a stub that looks like it
works would be worse than saying so. The conformance suite is what decides.

## Adding an adapter

1. Implement `SignerAdapter`.
2. Register it in `packages/pay/src/signers/index.ts`.
3. Report `candidate-pending-conformance` from `describe()`.
4. Run the suite: `DASKI_CONFORMANCE_SPEND_OK=1 npm run conformance -- --signer <name>`.
5. Promote to `verified` only once it passes.
