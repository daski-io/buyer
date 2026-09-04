import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalHash, type OrderBindingV2, type TypedDataRequest } from "@daski/x402-scheme";
import { runBuy, type BuyOptions } from "../src/commands/buy.js";
import { approvePurchase, nextPurchaseApproval, purchaseApproval } from "../src/commands/approval.js";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";
import { CliError } from "../src/cli/errors.js";
import type { CommandContext } from "../src/context.js";
import type { PaymentRequirement, PaymentSubmission } from "../src/gateway/client.js";
import { findByIntent, isUnspent, listOrders } from "../src/store/orders.js";

const payer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const profile = DEFAULT_CONFIG.profiles.sandbox!;
const splitter = "0x2222222222222222222222222222222222222222";
const intentId = "int_00000000-0000-4000-8000-000000000001";
const request = { country: "US", state: "WY", entityType: "LLC", companyName: "Example LLC" };
const resource = { url: `${profile.gatewayUrl}/outcomes/1/form-entity` };
const binding: OrderBindingV2 = { version: 2, profile: "recipe-bound-v2",
  runtimeCommitmentHash: canonicalHash("listing"), providerIntentHash: canonicalHash("terms"),
  quoteHash: canonicalHash("quote"), orderNonce: canonicalHash("nonce"),
  canonicalRequestHash: canonicalHash({ method: "POST", resource: resource.url, providerAgentId: "1", outcomeId: "form-entity", body: request }),
  expiresAt: Math.floor(Date.now() / 1000) + 280 };
const requirement: PaymentRequirement = { scheme: "exact", network: profile.network, asset: profile.usdcAddress,
  amount: "27100000", payTo: splitter, maxTimeoutSeconds: 280,
  extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" } };
const approvedTerms = { gatewayUrl: profile.gatewayUrl, payer: payer.address, providerAgentId: "1", outcomeId: "form-entity", requirement, binding };

async function withFixture(run: (args: { options: BuyOptions; context: CommandContext; signatures: TypedDataRequest[];
  submissions: PaymentSubmission[]; state: { sufficient: boolean; ambiguous: boolean; gatewayState: string } }) => Promise<void>) {
  const before = process.env.DASKI_HOME;
  const home = mkdtempSync(join(tmpdir(), "daski-buy-flow-"));
  process.env.DASKI_HOME = home;
  const signatures: TypedDataRequest[] = [];
  const submissions: PaymentSubmission[] = [];
  const state = { sufficient: true, ambiguous: false, gatewayState: "SETTLE_INVOKED" };
  const json = (body: Record<string, unknown>) => ({ content: [], structuredContent: body });
  const context = { loaded: loadConfig(), profileName: "sandbox", profile: { ...profile }, payerAddress: payer.address,
    client: { callCount: 0, hasTool: async () => true,
      callTool: async (name: string, _args: unknown, meta?: Record<string, unknown>) => {
        if (name === "daski_get_payment_challenge") return json({ paymentRequired: { x402Version: 2, resource, accepts: [requirement],
          extensions: { "daski-order-binding": binding, "payment-identifier": { info: { id: intentId } } } },
          preflight: { sufficient: state.sufficient, usdcBalance: "10000000", network: profile.network } });
        if (name === "daski_buy_outcome") {
          submissions.push(meta!["x402/payment"] as PaymentSubmission);
          return state.ambiguous ? { ...json({ code: "PAYMENT_PENDING_RECONCILIATION", paymentMayHaveSettled: true }), isError: true }
            : json({ orderHandle: "ord_fixture", status: "FULFILLED" });
        }
        if (name === "daski_list_my_orders") return json({ orders: [{ orderHandle: "ord_fixture", paymentIdentifier: intentId,
          state: state.gatewayState, providerAgentId: "1", outcomeId: "form-entity", grossAmount: requirement.amount, createdAt: new Date().toISOString() }] });
        throw new Error(`Unexpected tool ${name}`);
      } },
    catalog: { getOutcome: async () => ({ payTo: splitter, token: profile.usdcAddress, serviceName: "Entity formation",
      terms: { providerLegalName: "Fixture Provider", providerTermsUrl: "https://provider.example/terms" } }) },
    signer: { getAddress: async () => payer.address, describe: () => ({ provider: "fixture", accountType: "eoa" }),
      signTypedData: async (data: TypedDataRequest) => { signatures.push(data); return payer.signTypedData(data as never); } },
    policy: { payerAddress: payer.address, chainId: profile.chainId, canonicalToken: profile.usdcAddress,
      maxPerOrderUsdc: null, sessionCapUsdc: null,
      resolveSplitter: async () => ({ fromOutcome: splitter, fromChainManifest: splitter }),
      session: { spentAtomic: () => 0n, hasOrderFor: (id: string) => { const order = findByIntent(id); return order !== undefined && !isUnspent(order); } } },
    close: async () => {} } as unknown as CommandContext;
  const file = join(home, "request.json");
  writeFileSync(file, JSON.stringify(request));
  try { await run({ options: { providerAgentId: "1", outcomeId: "form-entity", requestFile: file, json: true }, context, signatures, submissions, state }); }
  finally { if (before === undefined) delete process.env.DASKI_HOME; else process.env.DASKI_HOME = before;
    rmSync(home, { recursive: true, force: true }); }
}

test("a 27.10 quote needs approval, then buys once with the existing signer and gateway identifier", async () => {
  await withFixture(async ({ options, context, signatures, submissions }) => {
    let approvalId = "";
    await assert.rejects(runBuy(options, async () => context), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "DASKI_HUMAN_APPROVAL_REQUIRED");
      approvalId = (error.details?.approval as { id: string }).id;
      assert.equal((error.details?.approvalSummary as { provider: string }).provider, "Fixture Provider");
      return true;
    });
    assert.equal(signatures.length, 0);
    assert.equal(listOrders().length, 0);
    const result = await runBuy({ ...options, approved: approvalId }, async () => context);
    assert.equal(result.purchased, true);
    assert.equal(result.intentId, intentId);
    assert.equal(result.price, "27.1 USDC");
    assert.equal(signatures.length, 1);
    assert.equal(submissions.length, 1);
    assert.deepEqual(submissions[0]!.extensions?.["payment-identifier"], { info: { id: intentId } });
    await assert.rejects(runBuy({ ...options, approved: approvalId }, async () => context));
    assert.equal(signatures.length, 1, "retrying a paid identifier never creates another payment signature");
    const next = nextPurchaseApproval(approvedTerms, "sandbox");
    assert.equal(next.purchaseNumber, 2);
    assert.notEqual(next.id, approvalId, "a second identical purchase needs its own approval");
  });
});

test("actual insufficient funds report a shortfall without signing", async () => {
  await withFixture(async ({ options, context, signatures, state }) => {
    state.sufficient = false;
    await assert.rejects(runBuy(options, async () => context), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "DASKI_INSUFFICIENT_USDC");
      assert.equal(error.details?.shortfallUsdc, "17.1 USDC"); return true;
    });
    assert.equal(signatures.length, 0);
  });
});

test("an explicitly configured budget still applies to an approved quote", async () => {
  await withFixture(async ({ options, context, signatures }) => {
    context.policy.maxPerOrderUsdc = "25.00";
    await assert.rejects(runBuy({ ...options, approved: purchaseApproval(approvedTerms).id }, async () => context),
      (error: unknown) => (error as { detail?: { code?: string } }).detail?.code === "DASKI_POLICY_PER_ORDER_CAP_EXCEEDED");
    assert.equal(signatures.length, 0);
  });
});

test("automatic recovery keeps an in-flight payment pending and does not replay or re-sign", async () => {
  await withFixture(async ({ options, context, signatures, submissions, state }) => {
    state.ambiguous = true;
    await assert.rejects(runBuy({ ...options, approved: purchaseApproval(approvedTerms).id }, async () => context),
      (error: unknown) => error instanceof CliError && error.code === "DASKI_PAYMENT_PENDING_RECONCILIATION");
    assert.equal(findByIntent(intentId)?.state, "PENDING_RECONCILIATION");
    assert.equal(submissions.length, 1);
    assert.equal(signatures.length, 1);
  });
});

test("approval survives expiry refresh but changes with every material purchase term", async () => {
  const approval = purchaseApproval(approvedTerms);
  assert.equal(purchaseApproval({ ...approvedTerms, binding: { ...binding, expiresAt: binding.expiresAt + 30,
    orderNonce: canonicalHash("new nonce"), quoteHash: canonicalHash("new quote") } }).id, approval.id);
  for (const changed of [ { ...approvedTerms, gatewayUrl: "https://other.example" },
    { ...approvedTerms, payer: splitter }, { ...approvedTerms, providerAgentId: "2" }, { ...approvedTerms, outcomeId: "other" },
    ...["amount", "network", "asset", "payTo"].map((key) => ({ ...approvedTerms, requirement: { ...requirement,
      [key]: key === "amount" ? "27100001" : key === "network" ? "eip155:1" : payer.address } })),
    ...["canonicalRequestHash", "runtimeCommitmentHash", "providerIntentHash"].map((key) => ({ ...approvedTerms,
      binding: { ...binding, [key]: canonicalHash("changed") } })) ]) {
    const next = purchaseApproval(changed);
    assert.notEqual(next.id, approval.id);
    await assert.rejects(approvePurchase({ approval: next, approved: approval.id, threshold: "0", json: true }),
      (error: unknown) => error instanceof CliError && error.code === "DASKI_QUOTE_CHANGED");
  }
});
