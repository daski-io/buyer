# Signer adapters

Every wallet backend implements one small interface:

```ts
interface SignerAdapter {
  getAddress(): Promise<Address>;
  signTypedData(payload: TypedDataRequest): Promise<Hex>;
  describe(): { provider: string; accountType: "eoa" | "contract" | "unknown";
                conformance?: "verified" | "candidate-pending-conformance" };
}
```

Deliberately tiny: an address, a typed-data signature, a self-description. No
raw message signing, no transaction signing, no key export. The CLI never
constructs a sending client; a test fails if any code path does.

The [conformance suite](../packages/pay/conformance/run.ts) is the acceptance
gate for every adapter. `describe()` reports conformance status so
`daski doctor` can say out loud what has and has not been established, rather
than implying a guarantee nobody has checked. A signer is *supported* once the
suite has passed with it against the sandbox and the run is recorded with the
release; until then it is a candidate.

The gateway states which account types it verifies under `payerAccounts.types`
in `/.well-known/mcp.json`. A contract signer is offered only when that list
includes `contract`; otherwise `doctor` and `buy` refuse with
`DASKI_GATEWAY_EOA_ONLY`. Counterfactual (ERC-6492) signatures are never
accepted anywhere: a contract wallet must be deployed before its first
purchase.

<a id="self-test"></a>
## The doctor self-test

`daski doctor` does not take an adapter's word for it either. Before it
reports a signer as usable it has the signer sign one fixed vector and checks
the result the way the gateway will.

For a plain wallet (`accountType: eoa`), without any RPC:

- the address recovered from the typed data equals the address the adapter
  reports — which also proves no field was rewritten before signing;
- `s` is at most `secp256k1n/2` (low-s), the only form the gateway's ECDSA
  recovery accepts;
- the signature is 65 bytes.

For a deployed contract account (`accountType: contract`):

- the signature is `0x` plus an even number of hex characters, at most 4,096
  bytes, and does not end in the ERC-6492 suffix;
- the wallet itself, asked through one read-only `isValidSignature` call
  against the profile RPC with a gas bound of 1,000,000 and a five-second
  deadline, returns exactly the ERC-1271 magic value `0x1626ba7e` for the
  EIP-712 hash the CLI computed. A revert or any other value fails; an RPC
  that cannot be reached fails with a reason that says so, never as invalid.

The vector has the shape of a purchase — the closed 6-field
`TransferWithAuthorization` type set — but can never be one: the domain is
`DaskiDoctor` with a zero verifying contract rather than any token's, the
value and recipient are zero, and the validity window is closed.

A failure is blocking, reported as `DASKI_SIGNER_SELF_TEST_FAILED` with the
reason, and the report carries the details under `signer.selfTest` together
with `signer.verifiedVia` (`recovery` or `erc1271`). It is a local check with
nothing at stake; the conformance suite remains the acceptance gate.

## `local` — implemented, verified

A viem account from the key store. Reports `eoa` / `verified`. Where the key
lives is a separate decision; see [key storage](./keys.md).

```bash
daski doctor --signer local --json
```

<a id="circle-agent"></a>
## `circle-agent` — implemented, candidate pending conformance

The Circle agent wallet: a deployed contract account operated through the
pinned [`@circle-fin/cli`](https://www.npmjs.com/package/@circle-fin/cli),
and the default signer on every host. The adapter shells out to
the `circle` command with an argument array, never a shell string:

- the address from `circle wallet list --chain <BASE|BASE-SEPOLIA> --type agent --output json`
  (the chain name follows the profile's chain id; only Base and Base Sepolia
  are supported);
- the signature from `circle wallet sign typed-data '<json>' --address <addr> --chain <chain> --quiet`,
  which receives the typed data the policy validator produced in the
  `eth_signTypedData_v4` form: `types` carries the `EIP712Domain` entry derived
  from the domain (`typedDataV4` in `@daski/x402-scheme`), which Circle
  requires and which leaves the hash unchanged.

Each command has a 30-second deadline and runs with this process's
environment minus every `DASKI_*` variable, so `DASKI_PAYER_PRIVATE_KEY` and
`DASKI_KEYSTORE_PASSPHRASE_FILE` never reach the vendor. Only the signature
is retained; the vendor's output is never logged and never repeated in an
error. A signature ending in the ERC-6492 suffix is refused on every use
(`DASKI_SIGNER_NOT_DEPLOYED`), not only in the self-test. `describe()`
reports `circle-agent` / `contract` / `candidate-pending-conformance`.

Install, terms acceptance, login, wallet creation, and funding are Circle's
own steps: the gateway's setup skill hands the agent Circle's skill
(`curl -sL https://agents.circle.com/skills/setup.md`), and this CLI never
performs them. The gateway publishes the vendor CLI version this adapter was
tested with under `signerClis.circle-agent` in `/.well-known/mcp.json`;
`doctor` reports it. Circle keeps its Base Sepolia session and wallet apart
from the main ones (`--testnet`); the adapter's remediations say so when that
is the profile's chain, so the setup skill does not.

**The wallet must be deployed.** `doctor` and `buy` read `getCode` and refuse
an undeployed wallet with `DASKI_SIGNER_NOT_DEPLOYED`; the remediation is a
zero-value transfer from the wallet to itself with the circle CLI, then
doctor again.

Delivery confirmations from a contract wallet are submitted directly: the
CLI validates and prints the EAS call, and the wallet's own tool sends it.
See the [CLI commands](../packages/pay/README.md).

```bash
export DASKI_KEY_BACKEND=circle-agent
daski doctor --json --signer circle-agent
DASKI_CONFORMANCE_SPEND_OK=1 npm run conformance -- --profile sandbox --signer circle-agent
```

| Setting | Purpose |
|---|---|
| `DASKI_KEY_BACKEND=circle-agent` | Declares that no local key exists on this host |
| `--circle-wallet <address>` | Selects one agent wallet when the CLI lists several |

Refusals, each with the command that fixes it: `DASKI_CIRCLE_CLI_MISSING`,
`DASKI_CIRCLE_CLI_FAILED`, `DASKI_CIRCLE_CLI_TIMEOUT`,
`DASKI_CIRCLE_CLI_OUTPUT_INVALID`, `DASKI_CIRCLE_AGENT_WALLET_MISSING`,
`DASKI_CIRCLE_AGENT_WALLET_AMBIGUOUS`, `DASKI_CIRCLE_AGENT_WALLET_NOT_FOUND`,
`DASKI_CIRCLE_AGENT_CHAIN_UNSUPPORTED`, `DASKI_SIGNER_NOT_DEPLOYED`,
`DASKI_GATEWAY_EOA_ONLY`.

The `circle` command is spawned directly from `PATH`. On Windows the npm
`.cmd` shim cannot be spawned without a shell, so the command must be
reachable as an executable named `circle`.

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

**Only the `EOA` account type is accepted** by this adapter. Circle can also
mint smart-contract accounts (`SCA`); those are the agent wallets the
`circle-agent` adapter serves through the vendor CLI. Selecting an SCA wallet
here fails with `DASKI_CIRCLE_SCA_UNSUPPORTED`.

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

1. Implement `SignerAdapter`; report `accountType: contract` for a contract
   account so doctor runs the ERC-1271 self-test and confirmations use direct
   mode.
2. Register it in `packages/pay/src/signers/index.ts`.
3. Report `candidate-pending-conformance` from `describe()`.
4. Pass `daski doctor`: the [self-test](#self-test) runs on every adapter.
5. Run the suite: `DASKI_CONFORMANCE_SPEND_OK=1 npm run conformance -- --signer <name>`.
6. Promote to `verified` only once it passes and the run is recorded.
