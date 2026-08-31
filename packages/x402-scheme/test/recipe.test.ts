/**
 * The recipe nonce is a protocol constant, not an implementation detail: if
 * these vectors change, every buyer in the field stops settling. They are
 * pinned against the gateway's published `daski-order-binding` (§4.3) and
 * cross-checked against an independent re-encoding of the same layout.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from "viem";
import {
  deriveBindingNonce,
  RECIPE_NONCE_DOMAIN_V1,
  RECIPE_NONCE_DOMAIN_V2,
  recipeNonce,
  recipeNonceV2,
} from "../src/recipe.js";
import type { OrderBindingV1, OrderBindingV2 } from "../src/binding.js";

/** A real `daski-order-binding` issued by sandbox-gateway.daski.io. */
const LIVE_BINDING_V2: OrderBindingV2 = {
  version: 2,
  profile: "recipe-bound-v2",
  runtimeCommitmentHash: "0xc88b484c75bcc3df77278434824f84ac6a5d9a317c6261d12a61b34cd38be41c",
  providerIntentHash: "0x4cb5b871bba078060c24d5bc905538f5cd9e5775bc66401b886f5f4d0bf8faeb",
  quoteHash: "0x71ef5567e186cd50e882941dfbb4b81260e30d29c3edaa5ffd10292a2dc52662",
  canonicalRequestHash: "0xb6b24dbe4fea483e3b207aeef4a00a345850ca1fb5f4380eb59c37d9c28f3e44",
  orderNonce: "0xcc7ec5d4c2f8b742f1321cd491a33cddf718c47174230a2010ed0cab67ab2266",
  expiresAt: 1788212865,
};

const FACTS = {
  chainId: 84532,
  canonicalToken: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address,
  payer: "0x1111111111111111111111111111111111111111" as Address,
  splitter: "0xE25be9CAAa546a55b2a2e8aF812E8Db51E3eDfd1" as Address,
  grossAmount: 9_990_000n,
};

/** An independent re-encoding of the documented layout, written from the
 *  spec text rather than from `recipe.ts`, so a shared bug cannot hide. */
function independentRecipeNonce(domain: Hex, slots: readonly Hex[]): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "uint256" }, { type: "address" },
      { type: "address" }, { type: "address" }, { type: "uint256" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "bytes32" }, { type: "bytes32" },
    ],
    [
      domain, BigInt(FACTS.chainId), FACTS.canonicalToken, FACTS.payer,
      FACTS.splitter, FACTS.grossAmount, ...slots,
    ] as never,
  ));
}

test("the v2 domain separator is keccak256 of the documented label", () => {
  assert.equal(RECIPE_NONCE_DOMAIN_V2, keccak256(stringToHex("DaskiStandardExactOrderV2")));
  assert.equal(RECIPE_NONCE_DOMAIN_V1, keccak256(stringToHex("DaskiStandardExactOrderV1")));
});

/**
 * Pinned vector. This value was produced independently by the reference
 * client behind 43 settled sandbox orders; if it ever changes, the change is
 * a protocol break and every buyer in the field stops settling.
 */
test("recipeNonceV2 reproduces the pinned reference vector", () => {
  assert.equal(
    recipeNonceV2({ ...FACTS, ...LIVE_BINDING_V2 }),
    "0xa2fe873efb98107270107019a13434f7b65e84269d0ea5047b20b7a009525911",
  );
});

test("recipeNonceV2 matches an independent encoding of the same layout", () => {
  const mine = recipeNonceV2({ ...FACTS, ...LIVE_BINDING_V2 });
  const theirs = independentRecipeNonce(RECIPE_NONCE_DOMAIN_V2, [
    LIVE_BINDING_V2.runtimeCommitmentHash,
    LIVE_BINDING_V2.providerIntentHash,
    LIVE_BINDING_V2.quoteHash,
    LIVE_BINDING_V2.canonicalRequestHash,
    LIVE_BINDING_V2.orderNonce,
  ]);
  assert.equal(mine, theirs);
});

test("recipeNonce v1 fills the manifest/offer slots in the documented order", () => {
  const binding: OrderBindingV1 = {
    version: 1,
    profile: "recipe-bound-v1",
    listingManifestHash: LIVE_BINDING_V2.runtimeCommitmentHash,
    providerOfferHash: LIVE_BINDING_V2.providerIntentHash,
    quoteHash: LIVE_BINDING_V2.quoteHash,
    canonicalRequestHash: LIVE_BINDING_V2.canonicalRequestHash,
    orderNonce: LIVE_BINDING_V2.orderNonce,
    expiresAt: LIVE_BINDING_V2.expiresAt,
  };
  assert.equal(
    recipeNonce({ ...FACTS, ...binding }),
    independentRecipeNonce(RECIPE_NONCE_DOMAIN_V1, [
      binding.listingManifestHash, binding.providerOfferHash, binding.quoteHash,
      binding.canonicalRequestHash, binding.orderNonce,
    ]),
  );
});

test("v1 and v2 never collide on identical slot values", () => {
  const v1: OrderBindingV1 = {
    version: 1, profile: "recipe-bound-v1",
    listingManifestHash: LIVE_BINDING_V2.runtimeCommitmentHash,
    providerOfferHash: LIVE_BINDING_V2.providerIntentHash,
    quoteHash: LIVE_BINDING_V2.quoteHash,
    canonicalRequestHash: LIVE_BINDING_V2.canonicalRequestHash,
    orderNonce: LIVE_BINDING_V2.orderNonce,
    expiresAt: LIVE_BINDING_V2.expiresAt,
  };
  assert.notEqual(deriveBindingNonce(v1, FACTS), deriveBindingNonce(LIVE_BINDING_V2, FACTS));
});

test("every payment fact changes the nonce", () => {
  const base = deriveBindingNonce(LIVE_BINDING_V2, FACTS);
  const variants = [
    { ...FACTS, chainId: 1 },
    { ...FACTS, payer: "0x2222222222222222222222222222222222222222" as Address },
    { ...FACTS, splitter: "0x3333333333333333333333333333333333333333" as Address },
    { ...FACTS, grossAmount: 9_990_001n },
    { ...FACTS, canonicalToken: "0x4444444444444444444444444444444444444444" as Address },
  ];
  for (const variant of variants) {
    assert.notEqual(deriveBindingNonce(LIVE_BINDING_V2, variant), base);
  }
});

test("every binding slot changes the nonce", () => {
  const base = deriveBindingNonce(LIVE_BINDING_V2, FACTS);
  const other = "0x" + "ab".repeat(32) as Hex;
  for (const slot of [
    "runtimeCommitmentHash", "providerIntentHash", "quoteHash",
    "canonicalRequestHash", "orderNonce",
  ] as const) {
    const mutated = { ...LIVE_BINDING_V2, [slot]: other };
    assert.notEqual(deriveBindingNonce(mutated, FACTS), base, `${slot} is not bound`);
  }
});
