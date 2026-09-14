/**
 * The shape rule for any signature this CLI validates: `0x` plus an even
 * number of hex characters, at most 4,096 bytes. The 65-byte low-s rule is
 * the EOA path's alone; a contract account's bytes are opaque beyond size.
 */
import type { Hex } from "viem";

export const MAX_SIGNATURE_BYTES = 4_096;

/** The 32-byte suffix an ERC-6492 wrapper ends with. Daski never accepts one. */
const ERC6492_SUFFIX = "6492".repeat(16);

export function isBoundedSignature(value: unknown): value is Hex {
  return typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(value) &&
    (value.length - 2) / 2 <= MAX_SIGNATURE_BYTES;
}

export function hasErc6492Suffix(signature: Hex): boolean {
  return signature.length > 66 && signature.toLowerCase().endsWith(ERC6492_SUFFIX);
}
