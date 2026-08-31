/**
 * The composite's contract (§3): a non-Daski challenge must reach the stock
 * handler byte-identically, and a Daski challenge must never reach it at all.
 * Everything else about the wrap is negotiable; those two are not.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import { DaskiExactEvmScheme, type PaymentRequirementsLike, type SchemeNetworkClientLike } from "../src/scheme.js";
import type { PolicyConfig } from "../src/policy.js";
import type { SignerAdapter } from "../src/signer.js";
import type { OrderBindingV2 } from "../src/binding.js";
import { deriveBindingNonce } from "../src/recipe.js";
import { PolicyRefusal } from "../src/errors.js";

const USDC = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
const PAYER = getAddress("0x1111111111111111111111111111111111111111");
const SPLITTER = getAddress("0xE25be9CAAa546a55b2a2e8aF812E8Db51E3eDfd1");
const NOW = 1_788_200_000;
const AMOUNT = "9990000";

const BINDING: OrderBindingV2 = {
  version: 2,
  profile: "recipe-bound-v2",
  runtimeCommitmentHash: "0xc88b484c75bcc3df77278434824f84ac6a5d9a317c6261d12a61b34cd38be41c",
  providerIntentHash: "0x4cb5b871bba078060c24d5bc905538f5cd9e5775bc66401b886f5f4d0bf8faeb",
  quoteHash: "0x71ef5567e186cd50e882941dfbb4b81260e30d29c3edaa5ffd10292a2dc52662",
  canonicalRequestHash: "0xb6b24dbe4fea483e3b207aeef4a00a345850ca1fb5f4380eb59c37d9c28f3e44",
  orderNonce: "0xcc7ec5d4c2f8b742f1321cd491a33cddf718c47174230a2010ed0cab67ab2266",
  expiresAt: NOW + 280,
};

const REQUIREMENTS: PaymentRequirementsLike = {
  scheme: "exact",
  network: "eip155:84532",
  asset: USDC,
  amount: AMOUNT,
  payTo: SPLITTER,
  maxTimeoutSeconds: 299,
  extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
};

function stubStock(): SchemeNetworkClientLike & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    scheme: "exact",
    findDefaultAsset: "stock-default-asset-fn",
    schemeHooks: "stock-hooks",
    calls,
    async createPaymentPayload(version, requirements, context) {
      calls.push({ version, requirements, context });
      return { x402Version: version, payload: { stock: true }, extensions: { echoed: true } };
    },
  };
}

function stubSigner(): SignerAdapter & { signed: unknown[] } {
  const signed: unknown[] = [];
  return {
    signed,
    getAddress: async () => PAYER,
    async signTypedData(payload) {
      signed.push(payload);
      return `0x${"11".repeat(65)}` as Hex;
    },
    describe: () => ({ provider: "stub", accountType: "eoa" as const }),
  };
}

function policy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    payerAddress: PAYER,
    chainId: 84532,
    canonicalToken: USDC,
    maxPerOrderUsdc: "25.00",
    sessionCapUsdc: "100.00",
    resolveSplitter: async () => ({ fromOutcome: SPLITTER, fromChainManifest: SPLITTER }),
    session: { spentAtomic: () => 0n, hasOrderFor: () => false },
    ...overrides,
  };
}

function scheme(stock: SchemeNetworkClientLike, overrides: Partial<PolicyConfig> = {}) {
  return new DaskiExactEvmScheme({
    signer: stubSigner(),
    payerAddress: PAYER,
    policy: policy(overrides),
    stock,
    now: () => NOW,
    resolvePurchaseContext: async () => ({
      providerAgentId: "8327",
      outcomeId: "create-mailbox",
      approvedQuoteAtomic: BigInt(AMOUNT),
    }),
  });
}

/** A server proposal that agrees with what we would have computed ourselves. */
function validSignRequest() {
  return {
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC },
    primaryType: "TransferWithAuthorization",
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" },
        { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ],
    },
    message: {
      from: PAYER, to: SPLITTER, value: AMOUNT,
      validAfter: String(NOW - 30), validBefore: String(NOW + 280),
      nonce: deriveBindingNonce(BINDING, {
        chainId: 84532, canonicalToken: USDC, payer: PAYER,
        splitter: SPLITTER, grossAmount: BigInt(AMOUNT),
      }),
    },
  };
}

test("the composite keeps the scheme name the facilitator knows", () => {
  assert.equal(scheme(stubStock()).scheme, "exact");
});

test("a challenge without a Daski binding is delegated untouched", async () => {
  const stock = stubStock();
  const context = { extensions: { "payment-identifier": { info: { required: false } } } };
  const result = await scheme(stock).createPaymentPayload(2, REQUIREMENTS, context);

  assert.equal(stock.calls.length, 1, "the stock handler must be called exactly once");
  const call = stock.calls[0] as { version: number; requirements: unknown; context: unknown };
  assert.equal(call.version, 2);
  assert.equal(call.requirements, REQUIREMENTS, "requirements pass by reference, unmodified");
  assert.equal(call.context, context, "context passes by reference, unmodified");
  assert.deepEqual(result, { x402Version: 2, payload: { stock: true }, extensions: { echoed: true } });
});

test("delegation also covers versions the Daski path would reject", async () => {
  const stock = stubStock();
  await scheme(stock).createPaymentPayload(1, REQUIREMENTS, { extensions: {} });
  assert.equal(stock.calls.length, 1, "v1 stock payments stay the stock handler's business");
});

test("a Daski challenge never reaches the stock handler", async () => {
  const stock = stubStock();
  const result = await scheme(stock).createPaymentPayload(2, REQUIREMENTS, {
    extensions: { "daski-order-binding": BINDING },
  });
  assert.equal(stock.calls.length, 0);
  const payload = result.payload as { authorization: { nonce: string; to: string } };
  assert.equal(payload.authorization.to, SPLITTER);
  assert.equal(
    payload.authorization.nonce,
    deriveBindingNonce(BINDING, {
      chainId: 84532, canonicalToken: USDC, payer: PAYER,
      splitter: SPLITTER, grossAmount: BigInt(AMOUNT),
    }),
  );
});

test("the stock handler's default-asset and hooks stay reachable", () => {
  const stock = stubStock();
  const composite = scheme(stock);
  assert.equal(composite.findDefaultAsset, "stock-default-asset-fn");
  assert.equal(composite.schemeHooks, "stock-hooks");
});

test("bazaar and daski-sign-request are dropped from the echoed extensions", async () => {
  const result = await scheme(stubStock()).createPaymentPayload(2, REQUIREMENTS, {
    extensions: {
      "daski-order-binding": BINDING,
      "daski-rail-profile": { hash: `0x${"aa".repeat(32)}` },
      "daski-sign-request": validSignRequest(),
      bazaar: { info: { input: { huge: true } } },
    },
  });
  const echoed = Object.keys(result.extensions ?? {}).sort();
  assert.deepEqual(echoed, ["daski-order-binding", "daski-rail-profile"]);
});

test("a Daski challenge paying an unlisted splitter is refused, not delegated", async () => {
  const stock = stubStock();
  const rogue = getAddress("0x8888888888888888888888888888888888888888");
  await assert.rejects(
    () => scheme(stock).createPaymentPayload(2, { ...REQUIREMENTS, payTo: rogue }, {
      extensions: { "daski-order-binding": BINDING },
    }),
    (error: unknown) => error instanceof PolicyRefusal &&
      error.detail.check === "splitter-allowlist",
  );
  assert.equal(stock.calls.length, 0, "a refusal never falls through to the stock handler");
});

test("a server-proposed sign-request is validated, not trusted", async () => {
  // The proposal is well-formed but its nonce commits to a different deal.
  const forged = {
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC },
    primaryType: "TransferWithAuthorization",
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" },
        { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ],
    },
    message: {
      from: PAYER, to: SPLITTER, value: AMOUNT,
      validAfter: String(NOW - 30), validBefore: String(NOW + 280),
      nonce: `0x${"ff".repeat(32)}`,
    },
  };
  await assert.rejects(
    () => scheme(stubStock()).createPaymentPayload(2, REQUIREMENTS, {
      extensions: { "daski-order-binding": BINDING, "daski-sign-request": forged },
    }),
    (error: unknown) => error instanceof PolicyRefusal &&
      error.detail.code === "DASKI_POLICY_RECIPE_NONCE_MISMATCH",
  );
});

test("an open-shaped binding is refused rather than trimmed", async () => {
  await assert.rejects(
    () => scheme(stubStock()).createPaymentPayload(2, REQUIREMENTS, {
      extensions: { "daski-order-binding": { ...BINDING, surprise: 1 } as never },
    }),
    (error: unknown) => error instanceof PolicyRefusal &&
      error.detail.code === "DASKI_BINDING_OPEN_SHAPE",
  );
});

test("the signed typed data is the one the validator returned", async () => {
  const signer = stubSigner();
  const composite = new DaskiExactEvmScheme({
    signer,
    payerAddress: PAYER,
    policy: policy(),
    stock: stubStock(),
    now: () => NOW,
    resolvePurchaseContext: async () => ({
      providerAgentId: "8327", outcomeId: "create-mailbox",
      approvedQuoteAtomic: BigInt(AMOUNT),
    }),
  });
  await composite.createPaymentPayload(2, REQUIREMENTS, {
    extensions: { "daski-order-binding": BINDING },
  });
  assert.equal(signer.signed.length, 1);
  const signed = signer.signed[0] as { primaryType: string; domain: { verifyingContract: Address } };
  assert.equal(signed.primaryType, "TransferWithAuthorization");
  assert.equal(signed.domain.verifyingContract, USDC);
});

test("a valid server proposal is accepted after recomputation agrees", async () => {
  const signer = stubSigner();
  const composite = new DaskiExactEvmScheme({
    signer,
    payerAddress: PAYER,
    policy: policy(),
    stock: stubStock(),
    now: () => NOW,
    resolvePurchaseContext: async () => ({
      providerAgentId: "8327", outcomeId: "create-mailbox",
      approvedQuoteAtomic: BigInt(AMOUNT),
    }),
  });
  const result = await composite.createPaymentPayload(2, REQUIREMENTS, {
    extensions: { "daski-order-binding": BINDING, "daski-sign-request": validSignRequest() },
  });
  const payload = result.payload as { authorization: { nonce: string } };
  assert.equal(
    payload.authorization.nonce,
    deriveBindingNonce(BINDING, {
      chainId: 84532, canonicalToken: USDC, payer: PAYER,
      splitter: SPLITTER, grossAmount: BigInt(AMOUNT),
    }),
    "an accepted proposal still carries the nonce we recomputed",
  );
  assert.equal(signer.signed.length, 1);
});
