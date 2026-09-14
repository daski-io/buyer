/**
 * The doctor's signer self-test.
 *
 * `daski doctor` does not take a signer's word for it. Before reporting one as
 * usable it has the signer sign one fixed vector and checks the result the way
 * the gateway will. For a plain wallet (EOA): the address recovered from the
 * typed data must be the address the adapter claims, `s` must be in the low
 * half of the curve order, and the whole thing must be 65 bytes. For a
 * deployed contract account: the bytes are opaque beyond their size, and the
 * contract itself must answer `isValidSignature` with the ERC-1271 magic value
 * for the hash this CLI computed, through one bounded read-only call against
 * the profile RPC. A signer that rewrites a field, wraps an ERC-6492 blob,
 * emits a malleable twin, or simply throws fails here, on a machine with
 * nothing at stake, instead of at settlement.
 *
 * The vector has the *shape* of a purchase — the closed 6-field
 * `TransferWithAuthorization` type set, so an adapter that mishandles that
 * exact structure is caught — but it can never be one: the domain is
 * `DaskiDoctor` with a zero verifying contract, not any token's; the value
 * and recipient are zero; the validity window is closed. No contract will
 * ever accept it.
 */
import {
  encodeFunctionData,
  getAddress,
  hashTypedData,
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
import {
  ERC1271_ABI, ERC1271_CALL_GAS, isErc1271Magic, type ChainReader,
} from "../chain/reader.js";
import { hasErc6492Suffix, isBoundedSignature, MAX_SIGNATURE_BYTES } from "./signature.js";

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
  /** How the signature verified: `recovery` for a plain wallet, `erc1271` for a contract account. */
  verifiedVia: "recovery" | "erc1271" | null;
  /** The address the signature recovers to on the EOA path, or null when nothing recovers. */
  recovered: Address | null;
  /** True when `s` is at most secp256k1n/2 on the EOA path; null on the contract path. */
  lowS: boolean | null;
  /** Why the test failed. Absent on a pass. */
  reason?: string;
}

/**
 * Runs the self-test that matches the signer's account type. Never throws: a
 * signer that throws has failed the test, and the reason says so.
 */
export async function runSignerSelfTest(
  signer: SignerAdapter,
  chainId: number,
  chain?: ChainReader,
): Promise<SignerSelfTestResult> {
  if (signer.describe().accountType === "contract") {
    return runContractSignerSelfTest(signer, chainId, chain);
  }
  return runEoaSignerSelfTest(signer, chainId);
}

/**
 * Signs the vector with `signer` and checks the signature the way the
 * gateway's EOA path will: exactly 65 bytes, low-s, recovering to the claimed
 * address. No RPC is involved.
 */
export async function runEoaSignerSelfTest(
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
      verifiedVia: null,
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
      verifiedVia: null,
      recovered,
      lowS,
      reason:
        "high-s signature: s is above secp256k1n/2, which the gateway's low-s ECDSA " +
        "recovery rejects",
    };
  }
  return { passed: true, verifiedVia: "recovery", recovered, lowS };
}

/**
 * Signs the vector and asks the deployed wallet itself whether the signature
 * is valid for the EIP-712 hash this CLI computed: one `isValidSignature`
 * `eth_call` with a gas bound and a deadline, accepting only the ERC-1271
 * magic value. A revert, another value, or a malformed return fails; an RPC
 * that cannot be reached fails with a reason that says so, never as invalid.
 */
export async function runContractSignerSelfTest(
  signer: SignerAdapter,
  chainId: number,
  chain: ChainReader | undefined,
): Promise<SignerSelfTestResult> {
  let claimed: Address;
  let vector: TypedDataRequest;
  let signature: unknown;
  try {
    claimed = getAddress(await signer.getAddress());
    vector = selfTestVector(claimed, chainId);
    signature = await signer.signTypedData(vector);
  } catch (error) {
    return failedContract(`the signer threw: ${errorMessage(error)}`);
  }
  if (!isBoundedSignature(signature)) {
    return failedContract(
      `malformed signature: expected 0x-prefixed hex of at most ${MAX_SIGNATURE_BYTES} bytes, ` +
      `got ${describeShape(signature)}`,
    );
  }
  if (hasErc6492Suffix(signature)) {
    return failedContract(
      "counterfactual (ERC-6492) signature: the wallet is not deployed, and Daski refuses " +
      "ERC-6492 wrappers",
    );
  }
  if (!chain) return failedContract("no RPC reader was available to call isValidSignature");
  const hash = hashTypedData(vector as never);
  const data = encodeFunctionData({
    abi: ERC1271_ABI, functionName: "isValidSignature", args: [hash, signature],
  });
  let result;
  try {
    result = await chain.call({ to: claimed, data, gas: ERC1271_CALL_GAS });
  } catch (error) {
    return failedContract(`isValidSignature could not be called: ${errorMessage(error)}`);
  }
  if (result.reverted) return failedContract("isValidSignature reverted for the vector");
  if (!isErc1271Magic(result.data)) {
    return failedContract(
      `isValidSignature returned ${describeReturn(result.data)}, not the ERC-1271 magic value`,
    );
  }
  return { passed: true, verifiedVia: "erc1271", recovered: null, lowS: null };
}

function failed(reason: string): SignerSelfTestResult {
  return { passed: false, verifiedVia: null, recovered: null, lowS: false, reason };
}

function failedContract(reason: string): SignerSelfTestResult {
  return { passed: false, verifiedVia: null, recovered: null, lowS: null, reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeShape(value: unknown): string {
  return typeof value === "string" ? `a ${value.length}-character string` : typeof value;
}

function describeReturn(data: Hex | undefined): string {
  if (data === undefined || data === "0x") return "no data";
  return `${(data.length - 2) / 2} bytes starting ${data.slice(0, 10)}`;
}
