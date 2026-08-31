/**
 * The policy validator is the only thing standing between a hostile challenge
 * and the wallet. Each test here is one §4.1 assertion, driven by mutating a
 * known-good proposal: if a mutation ever stops being refused, a real attack
 * has become possible.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, type Address } from "viem";
import { PolicyRefusal } from "../src/errors.js";
import { transferWithAuthorizationTypedData, type TypedDataRequest } from "../src/eip712.js";
import {
  validatePurchaseAuthorization,
  type PolicyConfig,
  type PurchaseExpectations,
} from "../src/policy.js";
import { deriveBindingNonce } from "../src/recipe.js";
import type { OrderBindingV2 } from "../src/binding.js";

const USDC = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
const PAYER = getAddress("0x1111111111111111111111111111111111111111");
const SPLITTER = getAddress("0xE25be9CAAa546a55b2a2e8aF812E8Db51E3eDfd1");
const NOW = 1_788_200_000;
const AMOUNT = 9_990_000n;

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

function config(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
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

function expectations(overrides: Partial<PurchaseExpectations> = {}): PurchaseExpectations {
  return {
    providerAgentId: "8327",
    outcomeId: "create-mailbox",
    challengeAmountAtomic: AMOUNT,
    challengeAsset: USDC,
    challengePayTo: SPLITTER,
    challengeNetwork: "eip155:84532",
    approvedQuoteAtomic: AMOUNT,
    binding: BINDING,
    nowSeconds: NOW,
    ...overrides,
  };
}

function proposal(): TypedDataRequest {
  const nonce = deriveBindingNonce(BINDING, {
    chainId: 84532, canonicalToken: USDC, payer: PAYER,
    splitter: SPLITTER, grossAmount: AMOUNT,
  });
  return transferWithAuthorizationTypedData(
    { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC },
    {
      from: PAYER, to: SPLITTER, value: AMOUNT.toString(),
      validAfter: String(NOW - 30), validBefore: String(NOW + 280), nonce,
    },
  );
}

async function refusalCode(
  run: () => Promise<unknown>,
): Promise<string> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof PolicyRefusal, `expected a PolicyRefusal, got ${String(error)}`);
    assert.ok(error.detail.remediation.length > 0, "every refusal names a remediation");
    return error.detail.code;
  }
  return assert.fail("expected a refusal");
}

test("a well-formed proposal validates and returns the recomputed nonce", async () => {
  const result = await validatePurchaseAuthorization(config(), proposal(), expectations());
  assert.equal(result.amountAtomic, AMOUNT);
  assert.equal(result.recomputedNonce, result.authorization.nonce);
  assert.equal(result.authorization.from, PAYER);
  assert.equal(result.authorization.to, SPLITTER);
});

test("§4.1.1 refuses a foreign chain", async () => {
  const bad = proposal();
  bad.domain.chainId = 1;
  assert.equal(
    await refusalCode(() => validatePurchaseAuthorization(config(), bad, expectations())),
    "DASKI_POLICY_CHAIN_MISMATCH",
  );
});

test("§4.1.1 refuses a non-canonical verifying contract", async () => {
  const bad = proposal();
  bad.domain.verifyingContract = "0x9999999999999999999999999999999999999999" as Address;
  assert.equal(
    await refusalCode(() => validatePurchaseAuthorization(config(), bad, expectations())),
    "DASKI_POLICY_TOKEN_NOT_CANONICAL",
  );
});

test("§4.1.2 refuses an extra field smuggled into the type set", async () => {
  const bad = proposal();
  bad.types = {
    TransferWithAuthorization: [
      ...bad.types.TransferWithAuthorization!,
      { name: "extra", type: "uint256" },
    ],
  };
  assert.equal(
    await refusalCode(() => validatePurchaseAuthorization(config(), bad, expectations())),
    "DASKI_POLICY_TYPES_NOT_CLOSED",
  );
});

test("§4.1.2 refuses a reordered type set", async () => {
  const bad = proposal();
  const fields = [...bad.types.TransferWithAuthorization!];
  bad.types = { TransferWithAuthorization: [fields[1]!, fields[0]!, ...fields.slice(2)] };
  assert.equal(
    await refusalCode(() => validatePurchaseAuthorization(config(), bad, expectations())),
    "DASKI_POLICY_TYPES_NOT_CLOSED",
  );
});

test("§4.1.2 refuses an extra message field", async () => {
  const bad = proposal();
  bad.message.memo = "hello";
  assert.equal(
    await refusalCode(() => validatePurchaseAuthorization(config(), bad, expectations())),
    "DASKI_POLICY_MESSAGE_OPEN_SHAPE",
  );
});

test("§4.1.3 refuses paying from an address we do not control", async () => {
  const bad = proposal();
  bad.message.from = "0x2222222222222222222222222222222222222222";
  assert.equal(
    await refusalCode(() => validatePurchaseAuthorization(config(), bad, expectations())),
    "DASKI_POLICY_PAYER_MISMATCH",
  );
});

test("§4.1.4 refuses a splitter the catalog does not list", async () => {
  const rogue = getAddress("0x5555555555555555555555555555555555555555");
  const bad = proposal();
  bad.message.to = rogue;
  assert.equal(
    await refusalCode(() => validatePurchaseAuthorization(
      config(), bad, expectations({ challengePayTo: rogue }),
    )),
    "DASKI_POLICY_SPLITTER_NOT_ALLOWLISTED",
  );
});

test("§4.1.4 refuses when the two independent splitter sources disagree", async () => {
  const disagreeing = config({
    resolveSplitter: async () => ({
      fromOutcome: SPLITTER,
      fromChainManifest: getAddress("0x6666666666666666666666666666666666666666"),
    }),
  });
  assert.equal(
    await refusalCode(() => validatePurchaseAuthorization(disagreeing, proposal(), expectations())),
    "DASKI_POLICY_SPLITTER_EVIDENCE_DISAGREES",
  );
});

test("§4.1.5 refuses a value that differs from the approved quote", async () => {
  assert.equal(
    await refusalCode(() => validatePurchaseAuthorization(
      config(), proposal(), expectations({ approvedQuoteAtomic: AMOUNT - 1n }),
    )),
    "DASKI_POLICY_QUOTE_NOT_APPROVED",
  );
});

test("§4.1.5 refuses above the per-order cap", async () => {
  assert.equal(
    await refusalCode(() => validatePurchaseAuthorization(
      config({ maxPerOrderUsdc: "5.00" }), proposal(), expectations(),
    )),
    "DASKI_POLICY_PER_ORDER_CAP_EXCEEDED",
  );
});

test("§4.1.5 refuses when the session cap would be crossed", async () => {
  const nearlySpent = config({
    sessionCapUsdc: "10.00",
    session: { spentAtomic: () => 5_000_000n, hasOrderFor: () => false },
  });
  assert.equal(
    await refusalCode(() => validatePurchaseAuthorization(nearlySpent, proposal(), expectations())),
    "DASKI_POLICY_SESSION_CAP_EXCEEDED",
  );
});

test("§4.1.6 refuses a window that outlives the cap", async () => {
  const bad = proposal();
  bad.message.validBefore = BigInt(NOW + 5_000);
  assert.equal(
    await refusalCode(() => validatePurchaseAuthorization(
      config(), bad, expectations({ binding: { ...BINDING, expiresAt: NOW + 6_000 } }),
    )),
    "DASKI_POLICY_WINDOW_TOO_LONG",
  );
});

test("§4.1.6 refuses an already-expiring window", async () => {
  const bad = proposal();
  bad.message.validBefore = BigInt(NOW + 5);
  assert.equal(
    await refusalCode(() => validatePurchaseAuthorization(config(), bad, expectations())),
    "DASKI_POLICY_WINDOW_TOO_SHORT",
  );
});

test("§4.1.6 refuses a back-dated validAfter", async () => {
  const bad = proposal();
  bad.message.validAfter = BigInt(NOW - 7_200);
  assert.equal(
    await refusalCode(() => validatePurchaseAuthorization(config(), bad, expectations())),
    "DASKI_POLICY_VALID_AFTER_OUT_OF_RANGE",
  );
});

test("§4.1.6 accepts validAfter of exactly zero", async () => {
  const zeroed = proposal();
  zeroed.message.validAfter = 0n;
  const result = await validatePurchaseAuthorization(config(), zeroed, expectations());
  assert.equal(result.authorization.validAfter, "0");
});

test("§4.1.7 refuses an identifier that already has an order", async () => {
  const seen = config({
    session: { spentAtomic: () => 0n, hasOrderFor: () => true },
  });
  assert.equal(
    await refusalCode(() => validatePurchaseAuthorization(
      seen, proposal(), expectations({ paymentIdentifier: "abcdefghijklmnop" }),
    )),
    "DASKI_POLICY_IDENTIFIER_ALREADY_ORDERED",
  );
});

test("§4.3 refuses a nonce that does not commit to the deal we were shown", async () => {
  const bad = proposal();
  bad.message.nonce = `0x${"cd".repeat(32)}`;
  assert.equal(
    await refusalCode(() => validatePurchaseAuthorization(config(), bad, expectations())),
    "DASKI_POLICY_RECIPE_NONCE_MISMATCH",
  );
});

test("§4.3 refuses a nonce bound to a different splitter than the one being paid", async () => {
  // The classic swap: the deal document is intact, the recipient is not.
  const rogue = getAddress("0x7777777777777777777777777777777777777777");
  const bad = proposal();
  bad.message.to = rogue;
  const permissive = config({
    resolveSplitter: async () => ({ fromOutcome: rogue, fromChainManifest: rogue }),
  });
  assert.equal(
    await refusalCode(() => validatePurchaseAuthorization(
      permissive, bad, expectations({ challengePayTo: rogue }),
    )),
    "DASKI_POLICY_RECIPE_NONCE_MISMATCH",
  );
});

test("an authorization may not outlive the deal it is bound to", async () => {
  const bad = proposal();
  bad.message.validBefore = BigInt(NOW + 400);
  assert.equal(
    await refusalCode(() => validatePurchaseAuthorization(
      config(), bad, expectations({ binding: { ...BINDING, expiresAt: NOW + 100 } }),
    )),
    "DASKI_POLICY_WINDOW_OUTLIVES_BINDING",
  );
});
