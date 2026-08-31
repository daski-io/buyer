/**
 * `@x402/mcp` host, buying one outcome from the sandbox gateway.
 *
 * The same composite as the fetch example, on a different transport. On MCP
 * the signed payload rides in `_meta["x402/payment"]`, which the host wrapper
 * handles; the composite's job is unchanged — validate, recompute, sign.
 *
 * This spends real testnet USDC, so it refuses to run without
 * DASKI_EXAMPLE_SPEND_OK=1.
 *
 *   DASKI_EXAMPLE_SPEND_OK=1 DASKI_PAYER_PRIVATE_KEY=0x... \
 *   node --experimental-strip-types index.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapMCPClientWithPayment } from "@x402/mcp";
import { getAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  registerDaskiExactEvmScheme,
  PolicyRefusal,
  type PolicyConfig,
  type SignerAdapter,
} from "@daski/x402-scheme";

const NETWORK = "eip155:84532";
const CHAIN_ID = 84532;
const USDC = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
const GATEWAY = process.env.DASKI_GATEWAY ?? "https://sandbox-gateway.daski.io";
const PROVIDER = process.env.DASKI_PROVIDER ?? "8327";
const OUTCOME = process.env.DASKI_OUTCOME ?? "create-mailbox";

if (process.env.DASKI_EXAMPLE_SPEND_OK !== "1") {
  console.error(
    "refusing to run: this example buys a real outcome with testnet USDC.\n" +
    "Set DASKI_EXAMPLE_SPEND_OK=1 to proceed.",
  );
  process.exit(2);
}
const privateKey = process.env.DASKI_PAYER_PRIVATE_KEY;
if (!privateKey) throw new Error("set DASKI_PAYER_PRIVATE_KEY (sandbox only)");
const account = privateKeyToAccount(privateKey as `0x${string}`);

const signer: SignerAdapter = {
  getAddress: async () => account.address,
  signTypedData: (payload) => account.signTypedData(payload as never),
  describe: () => ({ provider: "local", accountType: "eoa" }),
};

const remote = new Client({ name: "daski-x402-mcp-example", version: "0.1.0" });
await remote.connect(new StreamableHTTPClientTransport(new URL(`${GATEWAY}/mcp`)) as never);

const callJson = async (name: string, args: Record<string, unknown>) => {
  const result = await remote.callTool({ name, arguments: args }) as {
    content: { type: string; text?: string }[];
  };
  const text = result.content.find((item) => item.type === "text")?.text;
  return text ? JSON.parse(text) as Record<string, unknown> : undefined;
};

/** Both splitter sources, read before anything is signed. */
async function splitterEvidence(providerAgentId: string, outcomeId: string) {
  const [outcome, manifest] = await Promise.all([
    callJson("daski_get_outcome", { providerAgentId, outcomeId }),
    fetch(`${GATEWAY}/.well-known/daski-chain.json`).then((r) => r.json() as Promise<{
      outcomes: { providerAgentId: string; outcomeId: string; payTo: string;
        splitter?: { splitterAddress?: string } }[];
    }>),
  ]);
  const listed = manifest.outcomes.find(
    (row) => row.providerAgentId === providerAgentId && row.outcomeId === outcomeId,
  );
  if (!outcome || !listed) throw new Error("the outcome is not corroborated by both sources");
  const fromOutcome = (outcome.splitter as { splitterAddress?: string } | undefined)?.splitterAddress
    ?? outcome.payTo;
  return {
    fromOutcome: getAddress(String(fromOutcome) as Address),
    fromChainManifest: getAddress(String(listed.splitter?.splitterAddress ?? listed.payTo) as Address),
  };
}

let spent = 0n;
const policy: PolicyConfig = {
  payerAddress: account.address,
  chainId: CHAIN_ID,
  canonicalToken: USDC,
  maxPerOrderUsdc: process.env.DASKI_MAX_PER_ORDER ?? "25.00",
  sessionCapUsdc: process.env.DASKI_SESSION_CAP ?? "25.00",
  resolveSplitter: splitterEvidence,
  session: { spentAtomic: () => spent, hasOrderFor: () => false },
};

const client = new x402Client();
registerDaskiExactEvmScheme(client, {
  network: NETWORK,
  signer,
  payerAddress: account.address,
  policy,
  stock: new ExactEvmScheme(account),
  resolvePurchaseContext: async (requirements) => ({
    providerAgentId: PROVIDER,
    outcomeId: OUTCOME,
    // The host approved this price; the challenge does not get to set it.
    approvedQuoteAtomic: BigInt(requirements.amount),
  }),
});

const paid = wrapMCPClientWithPayment(remote as never, client);

try {
  const result = await paid.callTool("daski_buy_outcome", {
    providerAgentId: PROVIDER,
    outcomeId: OUTCOME,
    request: { address: `example-${Date.now()}@sandbox.daski.io` },
  }) as { content: { type: string; text?: string }[]; isError?: boolean };
  const text = result.content.find((item) => item.type === "text")?.text ?? "";
  console.log(result.isError ? "rejected:" : "purchased:", text);
} catch (error) {
  if (error instanceof PolicyRefusal) {
    console.error(`refused at the ${error.detail.check} check: ${error.detail.code}`);
    console.error(`  fix: ${error.detail.remediation}`);
    process.exitCode = 2;
  } else {
    throw error;
  }
} finally {
  await remote.close();
}
