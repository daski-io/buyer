/**
 * Read-only chain access.
 *
 * Everything this CLI learns from the chain — whether a contract account is
 * deployed, whether it accepts a signature, what a receipt contains, what an
 * attestation binds — comes through this one narrow reader. It has no
 * account, no wallet client, and no way to send a transaction: the CLI never
 * sends one (T9), and a sending client is not constructed anywhere.
 *
 * The reader is an interface so `doctor` and the confirmation flow can be
 * exercised against a scripted chain in tests.
 */
import {
  createPublicClient, http, HttpRequestError, TimeoutError, BaseError,
  type Abi, type Address, type Hex,
} from "viem";
import { CliError } from "../cli/errors.js";

/** The bound on one `eth_call` used to verify a contract signature. */
export const ERC1271_CALL_GAS = 1_000_000n;
/** One deadline covering the code lookup and the call. */
export const ERC1271_CALL_TIMEOUT_MS = 5_000;

export interface ReceiptLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
}

export interface TransactionReceiptLike {
  status: "success" | "reverted";
  blockNumber: bigint;
  /** The block that carried the transaction, compared with the canonical block at that height. */
  blockHash: Hex;
  from: Address;
  logs: readonly ReceiptLog[];
}

export interface ChainCallResult {
  /** The return data, or undefined when the call reverted or returned nothing. */
  data: Hex | undefined;
  reverted: boolean;
}

export interface ChainReader {
  /** Code at `address` at the latest block; `undefined` or `0x` for an EOA. */
  getCode(address: Address): Promise<Hex | undefined>;
  /** A bounded, read-only `eth_call` at the latest block. */
  call(args: { to: Address; data: Hex; gas: bigint }): Promise<ChainCallResult>;
  /** The receipt for a hash, or `null` while the transaction is not mined. */
  getTransactionReceipt(hash: Hex): Promise<TransactionReceiptLike | null>;
  /** The number of the newest block the chain reports as finalized. */
  getFinalizedBlockNumber(): Promise<bigint>;
  /** The hash of the canonical block at a height, as this RPC reports the chain now. */
  getBlockHash(blockNumber: bigint): Promise<Hex>;
  readContract<T>(args: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }): Promise<T>;
}

function rpcUnavailable(rpcUrl: string, error: unknown): CliError {
  return new CliError({
    code: "DASKI_RPC_UNAVAILABLE",
    message: `The RPC at ${rpcUrl} did not answer: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    remediation:
      "Nothing was decided from this read. Check connectivity or set a working rpcUrl for " +
      "the profile, then re-run.",
    details: { retryable: true },
  });
}

function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof BaseError)) return true;
  return error.walk((cause) => cause instanceof HttpRequestError || cause instanceof TimeoutError) !== null;
}

/** A viem-backed reader for one RPC endpoint, with one deadline per request. */
export function createChainReader(rpcUrl: string, timeoutMs = ERC1271_CALL_TIMEOUT_MS): ChainReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: timeoutMs, retryCount: 0 }) });
  return {
    async getCode(address) {
      try {
        return await client.getCode({ address });
      } catch (error) {
        throw rpcUnavailable(rpcUrl, error);
      }
    },
    async call({ to, data, gas }) {
      try {
        const result = await client.call({ to, data, gas });
        return { data: result.data, reverted: false };
      } catch (error) {
        // A transport failure is unknown, never invalid; a revert is a final answer.
        if (isTransportFailure(error)) throw rpcUnavailable(rpcUrl, error);
        return { data: undefined, reverted: true };
      }
    },
    async getTransactionReceipt(hash) {
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        return {
          status: receipt.status,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          from: receipt.from,
          logs: receipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data })),
        };
      } catch (error) {
        if (error instanceof BaseError && error.name === "TransactionReceiptNotFoundError") return null;
        if (error instanceof BaseError &&
            error.walk((cause) => (cause as Error).name === "TransactionReceiptNotFoundError") !== null) return null;
        throw rpcUnavailable(rpcUrl, error);
      }
    },
    async getFinalizedBlockNumber() {
      try {
        return (await client.getBlock({ blockTag: "finalized" })).number;
      } catch (error) {
        throw rpcUnavailable(rpcUrl, error);
      }
    },
    async getBlockHash(blockNumber) {
      try {
        return (await client.getBlock({ blockNumber })).hash;
      } catch (error) {
        throw rpcUnavailable(rpcUrl, error);
      }
    },
    async readContract<T>(args: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }) {
      try {
        return await client.readContract(args as never) as T;
      } catch (error) {
        throw rpcUnavailable(rpcUrl, error);
      }
    },
  };
}

/** The ERC-1271 magic value: the only return that verifies a contract signature. */
export const ERC1271_MAGIC = "0x1626ba7e";

export const ERC1271_ABI = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }],
    outputs: [{ name: "magicValue", type: "bytes4" }],
  },
] as const satisfies Abi;

/** True when `data` is exactly the 32-byte ABI encoding of the magic value. */
export function isErc1271Magic(data: Hex | undefined): boolean {
  return typeof data === "string" && data.length === 66 && data.toLowerCase().startsWith(ERC1271_MAGIC);
}

/** A deployed contract has non-empty code. */
export function isDeployedCode(code: Hex | undefined): boolean {
  return typeof code === "string" && /^0x[0-9a-fA-F]+$/.test(code) && code.length > 2;
}
