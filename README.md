# daski-buyer

The buyer side of Daski: a CLI for purchasing service outcomes and the x402 client plugin underneath it.

| Package | Purpose |
|---|---|
| [@daski/pay](./packages/pay) | Buyer CLI: setup, quote approval, payment, and order tracking |
| [@daski/x402-scheme](./packages/x402-scheme) | Composite Exact-EVM client for the modular x402 v2 SDK |

## Quick start

Install the release pinned by your gateway, then diagnose the existing configuration before creating a wallet:

```bash
npm install -g @daski/pay@0.3.0
daski doctor --json
```

Reuse a healthy signer. If doctor reports no signer, run `daski wallet create` interactively, or `daski wallet create --yes-human-approved` after the user authorizes wallet setup. Doctor reports `stateDirectory` and `configFile`; these use the CLI's native home directory or `DASKI_HOME`, which can differ from the shell's home.

Use the gateway's discovery tools and `daski_get_outcome_requirements` to complete the request from the user's supplied facts. Then obtain the actual quote:

```bash
daski buy --provider <id> --outcome <id> --request ./request.json --json
```

New profiles require approval of every paid quote and have no additional default budget. After the user approves the returned quote, repeat the command with `--approve <approval.id>`. Interactive use prompts directly. The approval identifier binds the request, provider, outcome, payer, gateway, network, token, recipient, amount, and published terms; it survives a quote refresh only when those terms match.

```bash
daski order status <handle> --json
daski order artifact <handle> --output ./result.json --json
daski order reconcile <intentId> --json
```

Quotation sends the request for provider pricing and creates or reuses a draft. The paid retry advances the purchase. Funding requirements come from that quote and preflight.

## Spending settings

Existing wallet keys and budgets survive upgrades. View or explicitly change spending settings with `daski budget`:

```bash
daski budget --json
daski budget --per-order 30 --total 100 --approval-above 0 --json
daski budget --per-order none --total none --json
```

The total covers recorded authorizations across runs. Temporary `--max-per-order` and `--session-cap` limits fit within any configured budget. See [configuration](./docs/config.md).

Node 20 or newer is required. Sandbox uses Base Sepolia; mainnet is disabled until the user chooses to enable it. The local signer is verified; CDP and Circle adapters are candidates pending conformance. See [signer adapters](./docs/signers.md).

## Payment validation and recovery

The bridge validates the profile's chain and token, payer, closed typed-data schema, catalog recipient, approved amount, optional budgets, and validity window. It recomputes the recipe nonce and preserves the payment identifier issued by the gateway.

After an uncertain payment, automatic recovery and `daski order reconcile` query the gateway for that exact identifier. In-flight and ambiguous states remain pending. A definitive no-settlement response permits another purchase after resolving the refusal's cause.

## Using the scheme directly

```ts
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { registerDaskiExactEvmScheme } from "@daski/x402-scheme";

const client = new x402Client();
registerDaskiExactEvmScheme(client, {
  network: "eip155:84532",
  signer, payerAddress, policy,
  stock: new ExactEvmScheme(account),
  resolvePurchaseContext,
});
```

The composite wraps the stock handler under scheme `exact`. Challenges without a Daski binding delegate to the stock handler. Runnable examples: [fetch](./examples/fetch) and [MCP](./examples/mcp).

## Documentation and development

- [CLI commands](./packages/pay/README.md)
- [Policy validator](./docs/policy.md)
- [Configuration](./docs/config.md)
- [Key storage](./docs/keys.md)
- [Signer adapters](./docs/signers.md)
- [Conformance](./docs/conformance.md)

```bash
npm ci
npm run build
npm test
npm run typecheck
```

Unit tests use isolated temporary state and fixture signers. Live conformance uses sandbox USDC and requires explicit spending authorization; see the conformance guide.

## License

MIT
