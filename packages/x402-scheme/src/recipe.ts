/**
 * §4.3 — local recipe recomputation, the verify-and-sign tier.
 *
 * The nonce of a Daski EIP-3009 authorization is not random: it is a
 * commitment to the whole deal. Recomputing it locally is what lets the
 * bridge sign a server-proposed authorization without trusting the server —
 * if our nonce and theirs disagree, the deal we were shown is not the deal
 * we would be signing, and we refuse.
 *
 * This function mirrors the gateway's `recipeNonceV2` byte for byte.
 * Changing it is a protocol break, not a refactor.
 */
import { encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from "viem";
import type { OrderBinding, OrderBindingV2 } from "./binding.js";

/** `keccak256("DaskiStandardExactOrderV2")` — the recipe domain separator. */
export const RECIPE_NONCE_DOMAIN_V2: Hex = keccak256(stringToHex("DaskiStandardExactOrderV2"));

/**
 * The five payment facts the recipe binds that do not come from the binding
 * extension. Each is independently known to the bridge: the chain and token
 * are pinned by profile, the payer is our own signer, and the splitter and
 * amount are what the policy validator has already allowlisted and capped.
 */
export interface RecipePaymentFacts {
  chainId: number;
  canonicalToken: Address;
  payer: Address;
  splitter: Address;
  grossAmount: bigint;
}

/** The eleven-slot ABI layout of the V2 recipe. */
const RECIPE_ABI = [
  { type: "bytes32" }, // domain separator
  { type: "uint256" }, // chainId
  { type: "address" }, // canonicalToken
  { type: "address" }, // payer
  { type: "address" }, // splitter
  { type: "uint256" }, // grossAmount
  { type: "bytes32" }, // runtimeCommitmentHash
  { type: "bytes32" }, // providerIntentHash
  { type: "bytes32" }, // quoteHash
  { type: "bytes32" }, // canonicalRequestHash
  { type: "bytes32" }, // orderNonce
] as const;

function encodeRecipe(
  domain: Hex,
  facts: RecipePaymentFacts,
  runtimeCommitmentHash: Hex,
  providerIntentHash: Hex,
  quoteHash: Hex,
  canonicalRequestHash: Hex,
  orderNonce: Hex,
): Hex {
  return keccak256(encodeAbiParameters(RECIPE_ABI, [
    domain,
    BigInt(facts.chainId),
    facts.canonicalToken,
    facts.payer,
    facts.splitter,
    facts.grossAmount,
    runtimeCommitmentHash,
    providerIntentHash,
    quoteHash,
    canonicalRequestHash,
    orderNonce,
  ]));
}

export type RecipeNonceV2Input = RecipePaymentFacts &
  Pick<OrderBindingV2, "runtimeCommitmentHash" | "providerIntentHash" | "quoteHash"
    | "canonicalRequestHash" | "orderNonce">;

/** `recipeNonceV2` — the catalog-driven layout, for `recipe-bound-v2` listings. */
export function recipeNonceV2(input: RecipeNonceV2Input): Hex {
  return encodeRecipe(
    RECIPE_NONCE_DOMAIN_V2,
    input,
    input.runtimeCommitmentHash,
    input.providerIntentHash,
    input.quoteHash,
    input.canonicalRequestHash,
    input.orderNonce,
  );
}

/** Recomputes the authorization nonce a binding commits to. */
export function deriveBindingNonce(binding: OrderBinding, facts: RecipePaymentFacts): Hex {
  return recipeNonceV2({ ...facts, ...binding });
}
