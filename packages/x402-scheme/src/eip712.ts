/**
 * The one typed-data shape this package will ever sign for a purchase.
 *
 * `TransferWithAuthorization` is declared here as a closed literal and
 * compared field-for-field against whatever the server proposes. The bridge
 * never signs a server-supplied `types` object: it signs *this* one, after
 * confirming the server asked for exactly this one.
 */
import type { Address, Hex } from "viem";

export const TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE = "TransferWithAuthorization" as const;

/** The closed 6-field EIP-3009 type set. Order is part of the hash. */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** The EIP-3009 authorization as it travels on the wire: decimal strings. */
export interface TransferAuthorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface Eip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

/** A complete typed-data request, in the shape a signer adapter receives. */
export interface TypedDataRequest {
  domain: Eip712Domain;
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * Builds the exact typed-data payload for an authorization. `value`,
 * `validAfter` and `validBefore` become bigints here because that is what
 * EIP-712 encoding requires; the wire form keeps them as strings.
 */
export function transferWithAuthorizationTypedData(
  domain: Eip712Domain,
  authorization: TransferAuthorization,
): TypedDataRequest {
  return {
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE,
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  };
}

/**
 * True when `types` is exactly the closed 6-field set: same type names, same
 * field names, same field types, same order, and nothing extra at either
 * level. Used by §4.1 check 2.
 */
export function isClosedTransferWithAuthorizationTypes(types: unknown): boolean {
  if (!types || typeof types !== "object" || Array.isArray(types)) return false;
  const record = types as Record<string, unknown>;
  // EIP712Domain is derived from the domain, never accepted as a declared type.
  if (Object.keys(record).join(",") !== TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE) return false;
  const fields = record[TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE];
  const expected = TRANSFER_WITH_AUTHORIZATION_TYPES.TransferWithAuthorization;
  if (!Array.isArray(fields) || fields.length !== expected.length) return false;
  return expected.every((want, index) => {
    const got = fields[index];
    return !!got && typeof got === "object" && !Array.isArray(got) &&
      Object.keys(got as object).sort().join(",") === "name,type" &&
      (got as { name: unknown }).name === want.name &&
      (got as { type: unknown }).type === want.type;
  });
}

/** The exact field set an EIP-3009 authorization message may carry. */
export const AUTHORIZATION_FIELDS = [
  "from", "to", "value", "validAfter", "validBefore", "nonce",
] as const;
