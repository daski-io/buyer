/**
 * Read-only chain access.
 *
 * Everything this CLI learns from the chain — whether a contract account is
 * deployed, whether it accepts a signature, what a receipt contains, what an
 * attestation binds — comes through this one narrow reader. It has no
 * account, no wallet client, and no way to send a transaction: the reader cannot
 * send one. The optional Circle direct-review adapter is a separate boundary.
 *
 * The reader is an interface so `doctor` and the confirmation flow can be
 * exercised against a scripted chain in tests.
 *
 * Public RPCs admit only a few `eth_call`s per client in a short window and
 * refuse the rest (https://mainnet.base.org among them), so a command that
 * needs several contract values reads them through `readContracts`: one call.
 */
import {
  createPublicClient, http, HttpRequestError, RpcError, RpcRequestError, TimeoutError, BaseError,
  type Abi, type Address, type Hex,
} from "viem";
import { CliError } from "../cli/errors.js";
import { redactRpcUrl } from "../cli/redact.js";

/** The bound on one `eth_call` used to verify a contract signature. */
export const ERC1271_CALL_GAS = 1_000_000n;
/** One deadline covering the code lookup and the call. */
export const ERC1271_CALL_TIMEOUT_MS = 5_000;

/** Multicall3 at its address on every chain that carries it; Base and Base Sepolia preinstall it. */
export const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** One contract read in a batch. */
export interface ContractRead {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

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

/** The block tag a profile's chain treats as final. */
export type FinalityTag = "safe" | "finalized";

/**
 * Base mainnet waits for L1 finality; the sandbox (Base Sepolia) treats the
 * `safe` tag (the batch is posted to L1) as final, the same rule the gateway
 * applies through CHAIN_FINALITY_TAG (owner decision 2026-08-28).
 */
export function finalityTagFor(chainId: number): FinalityTag {
  return chainId === 8453 ? "finalized" : "safe";
}

export interface ChainReader {
  /** Code at `address` at the latest block; `undefined` or `0x` for an EOA. */
  getCode(address: Address, blockNumber?: bigint): Promise<Hex | undefined>;
  /** EIP-1967 identity read at the same final block as profile checks. */
  getStorageAt?(address: Address, slot: Hex, blockNumber: bigint): Promise<Hex | undefined>;
  /** A bounded, read-only `eth_call` at the latest block. */
  call(args: { to: Address; data: Hex; gas: bigint }): Promise<ChainCallResult>;
  /** The receipt for a hash, or `null` while the transaction is not mined. */
  getTransactionReceipt(hash: Hex): Promise<TransactionReceiptLike | null>;
  /** The number of the newest block at the profile chain's finality tag. */
  getFinalBlockNumber(): Promise<bigint>;
  /** The hash of the canonical block at a height, as this RPC reports the chain now. */
  getBlockHash(blockNumber: bigint): Promise<Hex>;
  /** A contract read, at the latest state or pinned to a block number. */
  readContract<T>(args: { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; blockNumber?: bigint }): Promise<T>;
  /**
   * Contract reads answered together by one Multicall3 `eth_call`, in order,
   * at the latest state or pinned to a block number. Callers go through
   * `readContracts`, which reads one at a time from a reader without it.
   */
  readContracts?(args: { reads: readonly ContractRead[]; blockNumber?: bigint }): Promise<readonly unknown[]>;
}

/** Several contract reads in one call where the reader batches, otherwise one at a time; results keep their order. */
export function readContracts(chain: ChainReader, reads: readonly ContractRead[], blockNumber?: bigint): Promise<readonly unknown[]> {
  const pinned = blockNumber === undefined ? {} : { blockNumber };
  if (chain.readContracts) return chain.readContracts({ reads, ...pinned });
  return Promise.all(reads.map((read) => chain.readContract({ ...read, ...pinned })));
}

/** JSON-RPC codes that refuse a client over its rate: EIP-1474's limit exceeded, and proxyd's (Base's public RPC). */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([-32005, -32016]);

interface RpcAnswer { status?: number; code?: number; message?: string }

/** What the RPC answered, when it answered: the HTTP status and the JSON-RPC error. */
function rpcAnswer(error: unknown): RpcAnswer {
  if (!(error instanceof BaseError)) return {};
  const answer: RpcAnswer = {};
  const failed = error.walk((cause) => cause instanceof HttpRequestError);
  if (failed instanceof HttpRequestError) {
    if (failed.status !== undefined) answer.status = failed.status;
    // A refused HTTP request carries the body's JSON-RPC error, if any, as its details.
    try {
      const body = JSON.parse(failed.details) as { code?: unknown; message?: unknown };
      if (typeof body.code === "number") answer.code = body.code;
      if (typeof body.message === "string") answer.message = body.message;
    } catch {
      if (failed.details) answer.message = failed.details;
    }
  }
  const refused = error.walk((cause) => cause instanceof RpcError || cause instanceof RpcRequestError);
  if (refused instanceof RpcError || refused instanceof RpcRequestError) {
    answer.code = refused.code;
    if (refused.details) answer.message = refused.details;
  }
  return answer;
}

function isRateLimited(answer: RpcAnswer): boolean {
  return answer.status === 429 || (answer.code !== undefined && RATE_LIMIT_CODES.has(answer.code)) ||
    /rate.?limit|too many requests/i.test(answer.message ?? "");
}

function describeAnswer(answer: RpcAnswer): string {
  const head = [answer.status === undefined ? "" : `HTTP ${answer.status}`,
    answer.code === undefined ? "" : `RPC error ${answer.code}`].filter(Boolean).join(", ");
  return head && answer.message ? `${head}: ${answer.message}` : head || answer.message || "";
}

/** A failed read, named for what the RPC said; the endpoint is printed without the path or query a key may sit in. */
function rpcFailure(rpcUrl: string, error: unknown): CliError {
  const answer = rpcAnswer(error);
  const answered = describeAnswer(answer);
  const details = { retryable: true, ...(answer.status === undefined ? {} : { httpStatus: answer.status }),
    ...(answer.code === undefined ? {} : { rpcErrorCode: answer.code }) };
  if (isRateLimited(answer)) {
    return new CliError({
      code: "DASKI_RPC_RATE_LIMITED",
      message: `The RPC at ${redactRpcUrl(rpcUrl)} refused the read over its rate limit (${answered || "rate limited"}).`,
      remediation:
        "Nothing was decided from this read. Wait several seconds before re-running and do not retry in a " +
        "loop: the endpoint counts refused reads too. Public endpoints such as https://mainnet.base.org admit " +
        "only a few reads per client; set rpcUrl for the profile to a dedicated endpoint.",
      details,
    });
  }
  const first = error instanceof Error ? error.message.split("\n")[0] : String(error);
  return new CliError({
    code: "DASKI_RPC_UNAVAILABLE",
    message: `The RPC at ${redactRpcUrl(rpcUrl)} did not answer: ${first}${answered ? ` (${answered})` : ""}`,
    remediation:
      "Nothing was decided from this read. Check connectivity or set a working rpcUrl for " +
      "the profile, then re-run.",
    details,
  });
}

function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof BaseError)) return true;
  return error.walk((cause) => cause instanceof HttpRequestError || cause instanceof TimeoutError) !== null;
}

/** A viem-backed reader for one RPC endpoint, with one deadline per request. */
export function createChainReader(rpcUrl: string, finalityTag: FinalityTag, timeoutMs = ERC1271_CALL_TIMEOUT_MS): ChainReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: timeoutMs, retryCount: 0 }) });
  return {
    async getCode(address, blockNumber) {
      try {
        return await client.getCode({ address, ...(blockNumber === undefined ? {} : { blockNumber }) });
      } catch (error) {
        throw rpcFailure(rpcUrl, error);
      }
    },
    async getStorageAt(address, slot, blockNumber) {
      try { return await client.getStorageAt({ address, slot, blockNumber }); }
      catch (error) { throw rpcFailure(rpcUrl, error); }
    },
    async call({ to, data, gas }) {
      try {
        const result = await client.call({ to, data, gas });
        return { data: result.data, reverted: false };
      } catch (error) {
        // A transport failure or a refusal is unknown, never invalid; a revert is a final answer.
        if (isTransportFailure(error) || isRateLimited(rpcAnswer(error))) throw rpcFailure(rpcUrl, error);
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
        throw rpcFailure(rpcUrl, error);
      }
    },
    async getFinalBlockNumber() {
      try {
        return (await client.getBlock({ blockTag: finalityTag })).number;
      } catch (error) {
        throw rpcFailure(rpcUrl, error);
      }
    },
    async getBlockHash(blockNumber) {
      try {
        return (await client.getBlock({ blockNumber })).hash;
      } catch (error) {
        throw rpcFailure(rpcUrl, error);
      }
    },
    async readContract<T>(args: { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; blockNumber?: bigint }) {
      try {
        return await client.readContract(args as never) as T;
      } catch (error) {
        throw rpcFailure(rpcUrl, error);
      }
    },
    async readContracts({ reads, blockNumber }) {
      try {
        // batchSize 0: never split the batch, so it stays one eth_call.
        return await client.multicall({ contracts: reads as never, allowFailure: false, batchSize: 0,
          multicallAddress: MULTICALL3_ADDRESS, ...(blockNumber === undefined ? {} : { blockNumber }) }) as readonly unknown[];
      } catch (error) {
        throw rpcFailure(rpcUrl, error);
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
