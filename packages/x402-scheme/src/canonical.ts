/**
 * Canonical JSON, byte-identical to the gateway's.
 *
 * Object keys sort, numbers must be finite, lone surrogates are rejected, and
 * `undefined` is an error rather than an omission. The bridge uses this to
 * recompute the `requestHash` in a lifecycle challenge instead of trusting
 * the one it was handed.
 */
import { keccak256, stringToHex, type Hex } from "viem";

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("Canonical JSON contains invalid Unicode");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("Canonical JSON contains invalid Unicode");
    }
  }
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON accepts only finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("Unsupported canonical value");
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => {
    assertValidUnicode(key);
    if (object[key] === undefined) throw new Error("Undefined canonical value");
    return `${JSON.stringify(key)}:${canonicalValue(object[key])}`;
  }).join(",")}}`;
}

export const canonicalJson = (value: unknown): string => canonicalValue(value);
export const canonicalHash = (value: unknown): Hex => keccak256(stringToHex(canonicalValue(value)));
