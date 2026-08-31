/**
 * The `daski-order-binding` challenge extension: parsed as a closed shape.
 *
 * "Closed" is load-bearing. An extra field in a binding is a field the bridge
 * did not check and did not feed into the recipe recomputation, so a binding
 * that carries one is refused rather than trimmed.
 */
import type { Hex } from "viem";
import { refuse } from "./errors.js";

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

export interface OrderBindingV1 {
  version: 1;
  profile: "recipe-bound-v1";
  listingManifestHash: Hex;
  providerOfferHash: Hex;
  quoteHash: Hex;
  canonicalRequestHash: Hex;
  orderNonce: Hex;
  expiresAt: number;
}

/** Catalog-driven checkout: the runtime listing commitment plus the
 *  provider's signed registration intent. */
export interface OrderBindingV2 {
  version: 2;
  profile: "recipe-bound-v2";
  runtimeCommitmentHash: Hex;
  providerIntentHash: Hex;
  quoteHash: Hex;
  canonicalRequestHash: Hex;
  orderNonce: Hex;
  expiresAt: number;
}

export type OrderBinding = OrderBindingV1 | OrderBindingV2;

const SHARED_SLOTS = ["quoteHash", "canonicalRequestHash", "orderNonce"] as const;
const DEAL_SLOTS_V1 = ["listingManifestHash", "providerOfferHash"] as const;
const DEAL_SLOTS_V2 = ["runtimeCommitmentHash", "providerIntentHash"] as const;

const BINDING_DOC =
  "https://github.com/daski-io/buyer/blob/main/docs/policy.md#daski-order-binding";

/**
 * Parses the `daski-order-binding` extension, or returns `undefined` when the
 * challenge carries none (the stock-delegation path).
 */
export function parseOrderBinding(value: unknown): OrderBinding | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    refuse({
      check: "challenge-shape",
      code: "DASKI_BINDING_NOT_AN_OBJECT",
      expected: "an object under extensions['daski-order-binding']",
      actual: Array.isArray(value) ? "an array" : typeof value,
      remediation: `Request a fresh challenge; see ${BINDING_DOC}`,
    });
  }
  const binding = value as Record<string, unknown>;
  const isV2 = binding.profile === "recipe-bound-v2";
  const dealSlots = isV2 ? DEAL_SLOTS_V2 : DEAL_SLOTS_V1;
  const expectedKeys = [
    "version", "profile", ...dealSlots, ...SHARED_SLOTS, "expiresAt",
  ].sort();
  const actualKeys = Object.keys(binding).sort();
  if (actualKeys.join(",") !== expectedKeys.join(",")) {
    refuse({
      check: "challenge-shape",
      code: "DASKI_BINDING_OPEN_SHAPE",
      expected: `exactly [${expectedKeys.join(", ")}]`,
      actual: `[${actualKeys.join(", ")}]`,
      remediation:
        "An unrecognized binding layout cannot be recomputed, so it cannot be " +
        `signed. Upgrade @daski/x402-scheme, or see ${BINDING_DOC}`,
    });
  }
  const versionOk = isV2
    ? binding.version === 2
    : binding.version === 1 && binding.profile === "recipe-bound-v1";
  if (!versionOk) {
    refuse({
      check: "challenge-shape",
      code: "DASKI_BINDING_UNKNOWN_PROFILE",
      expected: "recipe-bound-v1 (version 1) or recipe-bound-v2 (version 2)",
      actual: `profile=${String(binding.profile)} version=${String(binding.version)}`,
      remediation: `Upgrade @daski/x402-scheme; see ${BINDING_DOC}`,
    });
  }
  for (const slot of [...dealSlots, ...SHARED_SLOTS]) {
    if (!HEX32.test(String(binding[slot]))) {
      refuse({
        check: "challenge-shape",
        code: "DASKI_BINDING_MALFORMED_SLOT",
        expected: `${slot} to be a 32-byte hex string`,
        actual: `${slot}=${String(binding[slot])}`,
        remediation: `Request a fresh challenge; see ${BINDING_DOC}`,
      });
    }
  }
  if (!Number.isSafeInteger(binding.expiresAt) || Number(binding.expiresAt) <= 0) {
    refuse({
      check: "challenge-shape",
      code: "DASKI_BINDING_MALFORMED_EXPIRY",
      expected: "expiresAt to be a positive unix timestamp in seconds",
      actual: `expiresAt=${String(binding.expiresAt)}`,
      remediation: `Request a fresh challenge; see ${BINDING_DOC}`,
    });
  }
  return binding as unknown as OrderBinding;
}
