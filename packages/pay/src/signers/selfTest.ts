/**
 * The doctor's signer self-test.
 *
 * `daski doctor` does not take a signer's word for it. Before reporting one as
 * usable it has the signer sign one fixed vector and checks the result the way
 * the gateway will: the address recovered from the typed data must be the
 * address the adapter claims, `s` must be in the low half of the curve order,
 * and the whole thing must be 65 bytes. A signer that rewrites a field, wraps
 * an ERC-1271 blob, emits a malleable twin, or simply throws fails here, on a
 * machine with nothing at stake, instead of at settlement.
 *
 * The vector has the *shape* of a purchase — the closed 6-field
 * `TransferWithAuthorization` type set, so an adapter that mishandles that
 * exact structure is caught — but it can never be one: the domain is
 * `DaskiDoctor` with a zero verifying contract, not any token's; the value
 * and recipient are zero; the validity window is closed. No contract will
 * ever accept it.
 */
import {
  getAddress,
  hexToBigInt,
  keccak256,
  parseSignature,
  recoverTypedDataAddress,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import {
  TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  type SignerAdapter,
  type TypedDataRequest,
} from "@daski/x402-scheme";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/** The vector's nonce: a commitment to nothing but its own name. */
export const SELF_TEST_NONCE: Hex = keccak256(stringToHex("daski-doctor-self-test"));

/** The secp256k1 group order, and the largest `s` the gateway's recovery accepts. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const LOW_S_MAX = SECP256K1_N / 2n;

/**
 * The fixed vector for one signer address and chain. Everything about it is
 * pinned except the payer, which must be the signer under test so that a
 * matching recovered address proves the signer signed *this* message,
 * unchanged.
 */
export function selfTestVector(signerAddress: Address, chainId: number): TypedDataRequest {
  return {
    domain: {
      name: "DaskiDoctor",
      version: "1",
      chainId,
      verifyingContract: ZERO_ADDRESS,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE,
    message: {
      from: signerAddress,
      to: ZERO_ADDRESS,
      value: 0n,
      validAfter: 0n,
      validBefore: 0n,
      nonce: SELF_TEST_NONCE,
    },
  };
}

export interface SignerSelfTestResult {
  passed: boolean;
  /** The address the signature recovers to, or null when nothing recovers. */
  recovered: Address | null;
  /** True when `s` is at most secp256k1n/2. */
  lowS: boolean;
  /** Why the test failed. Absent on a pass. */
  reason?: string;
}

/**
 * Signs the vector with `signer` and checks the signature the way the gateway
 * will. Never throws: a signer that throws has failed the test, and the reason
 * says so.
 */
export async function runSignerSelfTest(
  signer: SignerAdapter,
  chainId: number,
): Promise<SignerSelfTestResult> {
  let claimed: Address;
  let vector: TypedDataRequest;
  let signature: unknown;
  try {
    claimed = getAddress(await signer.getAddress());
    vector = selfTestVector(claimed, chainId);
    signature = await signer.signTypedData(vector);
  } catch (error) {
    return failed(`the signer threw: ${errorMessage(error)}`);
  }
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return failed(
      `malformed signature: expected 65 bytes of 0x-prefixed hex, got ${describeShape(signature)}`,
    );
  }
  let recovered: Address;
  let s: bigint;
  try {
    recovered = await recoverTypedDataAddress({ ...vector, signature } as never);
    s = hexToBigInt(parseSignature(signature as Hex).s);
  } catch (error) {
    return failed(`the signature does not recover: ${errorMessage(error)}`);
  }
  const lowS = s <= LOW_S_MAX;
  if (recovered !== claimed) {
    return {
      passed: false,
      recovered,
      lowS,
      reason:
        `recovered-address mismatch: the signature recovers to ${recovered} but the ` +
        `signer reports ${claimed}, so either the key is not the one claimed or a ` +
        "field was rewritten before signing",
    };
  }
  if (!lowS) {
    return {
      passed: false,
      recovered,
      lowS,
      reason:
        "high-s signature: s is above secp256k1n/2, which the gateway's low-s ECDSA " +
        "recovery rejects",
    };
  }
  return { passed: true, recovered, lowS };
}

function failed(reason: string): SignerSelfTestResult {
  return { passed: false, recovered: null, lowS: false, reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeShape(value: unknown): string {
  return typeof value === "string" ? `a ${value.length}-character string` : typeof value;
}
