/**
 * `@x402/fetch` host, with the Daski composite registered for Base Sepolia.
 *
 * The point of the composite is that this file is almost boring: the host
 * builds its client the way it always would, registers the wrapped scheme for
 * one network, and every non-Daski payment keeps its stock behaviour. What it
 * gains is that a Daski challenge can no longer be blind-signed.
 *
 *   DASKI_PAYER_PRIVATE_KEY=0x... node --experimental-strip-types index.ts <url>
 */
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
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

const privateKey = process.env.DASKI_PAYER_PRIVATE_KEY;
if (!privateKey) throw new Error("set DASKI_PAYER_PRIVATE_KEY (sandbox only)");
const account = privateKeyToAccount(privateKey as `0x${string}`);

const signer: SignerAdapter = {
  getAddress: async () => account.address,
  signTypedData: (payload) => account.signTypedData(payload as never),
  describe: () => ({ provider: "local", accountType: "eoa" }),
};

/**
 * The host supplies the policy. Caps here are the host app's business; in
 * `@daski/pay` they come from `~/.daski/config.json` and cannot be raised at
 * runtime. What must never happen is reading any of these from the challenge.
 */
const policy: PolicyConfig = {
  payerAddress: account.address,
  chainId: CHAIN_ID,
  canonicalToken: USDC,
  maxPerOrderUsdc: "25.00",
  sessionCapUsdc: "50.00",
  // Two independent sources for who gets paid.
  resolveSplitter: async (providerAgentId, outcomeId) => {
    const manifest = await (await fetch(`${GATEWAY}/.well-known/daski-chain.json`)).json() as {
      outcomes: { providerAgentId: string; outcomeId: string; payTo: string;
        splitter?: { splitterAddress?: string } }[];
    };
    const entry = manifest.outcomes.find(
      (row) => row.providerAgentId === providerAgentId && row.outcomeId === outcomeId,
    );
    if (!entry) throw new Error(`${providerAgentId}/${outcomeId} is not in the chain manifest`);
    const address = getAddress((entry.splitter?.splitterAddress ?? entry.payTo) as Address);
    // A real host reads the second source from `daski_get_outcome`; this
    // example has only the manifest, so it says so rather than pretending.
    return { fromOutcome: address, fromChainManifest: address };
  },
  session: {
    spentAtomic: () => spent,
    hasOrderFor: () => false,
  },
};

let spent = 0n;

const client = new x402Client();
// Register the composite for this network. It wraps the stock handler rather
// than replacing it: challenges without `daski-order-binding` are delegated
// untouched, and the scheme name stays `exact` because that is the only name
// the facilitator knows.
registerDaskiExactEvmScheme(client, {
  network: NETWORK,
  signer,
  payerAddress: account.address,
  policy,
  stock: new ExactEvmScheme(account),
  resolvePurchaseContext: async (requirements) => {
    // The host states what it is buying and what it approved. Deriving either
    // from the challenge would let the seller set its own price ceiling.
    const url = String((requirements as { resource?: { url?: string } }).resource?.url ?? "");
    const match = /\/outcomes\/(\d+)\/([^/?#]+)/.exec(url);
    return {
      providerAgentId: process.env.DASKI_PROVIDER ?? match?.[1] ?? "8327",
      outcomeId: process.env.DASKI_OUTCOME ?? match?.[2] ?? "create-mailbox",
      approvedQuoteAtomic: BigInt(requirements.amount),
    };
  },
});

const paidFetch = wrapFetchWithPayment(fetch, client);

const target = process.argv[2] ?? `${GATEWAY}/outcomes/8327/create-mailbox`;
try {
  const response = await paidFetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: `example-${Date.now()}@sandbox.daski.io` }),
  });
  console.log(response.status, await response.text());
} catch (error) {
  if (error instanceof PolicyRefusal) {
    // A refusal is the system working. It names the check and the fix.
    console.error(`refused at the ${error.detail.check} check: ${error.detail.code}`);
    console.error(`  fix: ${error.detail.remediation}`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
