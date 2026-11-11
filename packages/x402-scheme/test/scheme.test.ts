/**
 * The composite's contract (§3): a non-Daski challenge must reach the stock
 * handler byte-identically, and a Daski challenge must never reach it at all.
 * Everything else about the wrap is negotiable; those two are not.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/** The gateway's envelope around a typed-data proposal (daski-sign-request). */
function gatewaySignRequest(eip712: Record<string, unknown>, version = 2) {
  return {
    version,
    signaturePurpose: "daski-standard-purchase",
    expiresAt: BINDING.expiresAt,
    eip712,
    submitAs: version === 1
      ? { how: "Sign eip712 into payload.signature; resend this paymentPayload.", paymentPayload: { x402Version: 2 } }
      : { how: "Sign eip712; echo resource, accepts[0] and echoExtensions.", echoExtensions: ["daski-order-binding"] },
  };
}

/** A server proposal that agrees with what we would have computed ourselves. */
function validSignRequest(version = 2) {
  return gatewaySignRequest(validTypedData(), version);
}

function validTypedData() {
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
      extensions: { "daski-order-binding": BINDING, "daski-sign-request": gatewaySignRequest(forged) },
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

test("a version 1 sign-request, which also carried a payload copy, is still read", async () => {
  const signer = stubSigner();
  const composite = new DaskiExactEvmScheme({
    signer, payerAddress: PAYER, policy: policy(), stock: stubStock(), now: () => NOW,
    resolvePurchaseContext: async () => ({
      providerAgentId: "8327", outcomeId: "create-mailbox", approvedQuoteAtomic: BigInt(AMOUNT),
    }),
  });
  await composite.createPaymentPayload(2, REQUIREMENTS, {
    extensions: { "daski-order-binding": BINDING, "daski-sign-request": validSignRequest(1) },
  });
  assert.equal(signer.signed.length, 1);
});

test("the flat typed-data layout without the gateway envelope is refused as an open shape", async () => {
  await assert.rejects(
    () => scheme(stubStock()).createPaymentPayload(2, REQUIREMENTS, {
      extensions: { "daski-order-binding": BINDING, "daski-sign-request": validTypedData() },
    }),
    (error: unknown) => error instanceof PolicyRefusal &&
      error.detail.code === "DASKI_SIGN_REQUEST_OPEN_SHAPE",
  );
});

test("an unknown sign-request version or purpose is refused before anything is signed", async () => {
  for (const [patch, code] of [
    [{ version: 3 }, "DASKI_SIGN_REQUEST_VERSION_UNSUPPORTED"],
    [{ signaturePurpose: "daski-order-action" }, "DASKI_SIGN_REQUEST_PURPOSE_UNSUPPORTED"],
    [{ eip712: { ...validTypedData(), extra: 1 } }, "DASKI_SIGN_REQUEST_OPEN_EIP712"],
  ] as const) {
    const signer = stubSigner();
    await assert.rejects(
      () => new DaskiExactEvmScheme({
        signer, payerAddress: PAYER, policy: policy(), stock: stubStock(), now: () => NOW,
        resolvePurchaseContext: async () => ({
          providerAgentId: "8327", outcomeId: "create-mailbox", approvedQuoteAtomic: BigInt(AMOUNT),
        }),
      }).createPaymentPayload(2, REQUIREMENTS, {
        extensions: { "daski-order-binding": BINDING, "daski-sign-request": { ...validSignRequest(), ...patch } },
      }),
      (error: unknown) => error instanceof PolicyRefusal && error.detail.code === code,
    );
    assert.equal(signer.signed.length, 0);
  }
});

/** The gateway's wire fixtures, vendored at the repository root (or overridden for a pair run). */
function wireFixture<T>(name: string): T {
  let directory = process.env.DASKI_GATEWAY_WIRE_FIXTURES;
  for (let up = dirname(fileURLToPath(import.meta.url)), depth = 0; !directory && depth < 8; depth += 1) {
    const candidate = join(up, "test", "fixtures", "gateway-wire");
    if (existsSync(join(candidate, name))) directory = candidate;
    up = dirname(up);
  }
  if (!directory) throw new Error(`gateway wire fixture ${name} is not vendored`);
  return JSON.parse(readFileSync(join(directory, name), "utf8")) as T;
}

test("payment-required-sign-ready: the gateway's sign-ready challenge is parsed, validated and signed", async () => {
  const challenge = wireFixture<{
    accepts: PaymentRequirementsLike[];
    extensions: Record<string, unknown> & {
      "daski-sign-request": { eip712: { message: { nonce: string; from: string } }; submitAs: { echoExtensions: string[] } };
    };
  }>("payment-required-sign-ready.json");
  const requirements = challenge.accepts[0]!;
  const proposal = challenge.extensions["daski-sign-request"];
  const payer = getAddress(proposal.eip712.message.from);
  const signed: unknown[] = [];
  const composite = new DaskiExactEvmScheme({
    signer: {
      getAddress: async () => payer,
      async signTypedData(payload) { signed.push(payload); return `0x${"11".repeat(65)}` as Hex; },
      describe: () => ({ provider: "stub", accountType: "eoa" as const }),
    },
    payerAddress: payer,
    policy: policy({
      payerAddress: payer,
      resolveSplitter: async () => ({
        fromOutcome: getAddress(requirements.payTo), fromChainManifest: getAddress(requirements.payTo),
      }),
    }),
    stock: stubStock(),
    // The fixture was issued at this second.
    now: () => 1_756_769_000,
    resolvePurchaseContext: async () => ({
      providerAgentId: "8327", outcomeId: "register-domain",
      approvedQuoteAtomic: BigInt(requirements.amount),
    }),
  });
  const result = await composite.createPaymentPayload(2, requirements, { extensions: challenge.extensions });
  assert.equal(signed.length, 1);
  const payload = result.payload as { authorization: { nonce: string } };
  assert.equal(payload.authorization.nonce, proposal.eip712.message.nonce);
  assert.deepEqual(
    Object.keys(result.extensions ?? {}).sort(),
    [...proposal.submitAs.echoExtensions].sort(),
    "the bridge echoes exactly the extensions the gateway names",
  );
});
