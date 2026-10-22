/**
 * Child-scoped Circle transport policy. Inputs are a buyer-validated EAS call,
 * never arbitrary CLI commands. No credentials are persisted or returned here.
 *
 * @circle-fin/cli 1.2.0 and later run `wallet execute` as: list the wallets,
 * POST the contract execution, read the encrypted challenge, POST its
 * approval, poll the user challenge until COMPLETE, then poll the transaction
 * the challenge names (GET /v1/w3s/transactions/<id>) until it is terminal.
 * The policy permits exactly that sequence for the approved call, and records
 * each step that decides whether Circle can execute before forwarding it, so
 * the buyer knows what happened even when the vendor process fails later.
 * The buyer trusts the installed CLI; the policy and the network confinement
 * below are correctness aids that stop a release sending anything else
 * through Node's usual clients, not a boundary against the vendor. That a run
 * sent nothing is believed only of a qualified build (circleReview.ts).
 */
import { readFileSync, realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { dirname, join } from "node:path";
import tls from "node:tls";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import type { DirectCall } from "../commands/confirmation.js";
/**
 * The oldest @circle-fin/cli whose review requests this policy was checked
 * against; every later release runs, and the policy refuses whatever it
 * sends beyond that sequence. Circle's own version policy refuses every
 * command below 1.1.4, and 1.1.4 is below this floor. Like the package check
 * below, a sanity check of the installed CLI, which the buyer trusts.
 */
export const CIRCLE_REVIEW_MINIMUM_VERSION = "1.2.0";
const RELEASE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
/** A release (never a prerelease, as npm's `>=1.2.0` reads it) at or above the floor. */
export function circleReviewVersionSupported(version: unknown): boolean {
  const found = typeof version === "string" ? RELEASE.exec(version) : null;
  const floor = RELEASE.exec(CIRCLE_REVIEW_MINIMUM_VERSION)!;
  if (!found) return false;
  for (const part of [1, 2, 3]) {
    if (Number(found[part]) !== Number(floor[part])) return Number(found[part]) > Number(floor[part]);
  }
  return true;
}
/**
 * The version of the installed @circle-fin/cli whose `circle` command this
 * entry point is: the package.json above its directory names that package and
 * declares this very file its `circle` binary, at a release the floor admits.
 * Undefined for anything else; nothing about the package is reported.
 */
export function circleReviewPackageVersion(entry: string): string | undefined {
  try {
    const file = realpathSync(entry);
    const root = dirname(dirname(file));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown; version?: unknown; bin?: unknown };
    const bin = typeof pkg.bin === "string" ? pkg.bin
      : pkg.bin && typeof pkg.bin === "object" ? (pkg.bin as Record<string, unknown>).circle : undefined;
    if (pkg.name !== "@circle-fin/cli" || typeof bin !== "string" || realpathSync(join(root, bin)) !== file ||
        !circleReviewVersionSupported(pkg.version)) return undefined;
    return pkg.version as string;
  } catch {
    return undefined;
  }
}

/** Where Circle's agent wallet API is: the only place the child may connect. */
export interface CircleReviewEndpoint { host: string; port: number }
const CIRCLE_ENDPOINT: CircleReviewEndpoint = { host: "agentic-wallet.circle.com", port: 443 };
/** Where Node's fetch, and any undici, finds the dispatcher a request without its own uses. */
const SHARED_DISPATCHER = Symbol.for("undici.globalDispatcher.1");
/** Node's own fetch opens its sockets from this module, on every supported Node version. */
const NODE_FETCH = "node:internal/deps/undici/undici";
const outsideScope = (): never => { throw new Error("Circle request is outside review scope"); };
/** The file of the code that called `fn`; undefined when the stack cannot say. */
function callerOf(fn: (...args: never[]) => unknown): string | undefined {
  const prepare = Error.prepareStackTrace;
  const limit = Error.stackTraceLimit;
  try {
    Error.prepareStackTrace = (_error, sites) => sites;
    Error.stackTraceLimit = 1;
    const holder: { stack?: NodeJS.CallSite[] } = {};
    Error.captureStackTrace(holder, fn);
    return holder.stack?.[0]?.getFileName() ?? undefined;
  } finally {
    Error.prepareStackTrace = prepare;
    Error.stackTraceLimit = limit;
  }
}
/**
 * Leaves Node's own fetch, for the review policy, as the child's usual way to
 * the network, before any vendor code loads. The dispatcher that fetch
 * connects with is kept for the policy alone; every other client that would
 * share it (a vendor's own undici, WebSocket) finds a refusal instead. A TLS
 * connection opens only from Node's fetch, by its call stack, and only to
 * Circle's endpoint, and a socket connects only inside such a connection.
 * Node's http, https and http2 clients, undici and the usual HTTP libraries
 * connect through these, so a release that moved its requests to one of them
 * fails at that request. It is a correctness aid, not a boundary: threads,
 * processes, DNS, UDP, native addons, process.binding and the inspector are
 * not confined, and code that rewrites the call stack passes the TLS check.
 */
export async function confineCircleReviewNetwork(endpoint: CircleReviewEndpoint = CIRCLE_ENDPOINT): Promise<typeof fetch> {
  const original = globalThis.fetch;
  // Node creates its fetch dispatcher on first use; a data: URL connects nowhere.
  await original("data:,");
  const shared = globalThis as unknown as Record<symbol, unknown>;
  const dispatcher = shared[SHARED_DISPATCHER];
  if (!dispatcher || typeof dispatcher !== "object") throw new Error("Node's fetch dispatcher is unavailable");
  shared[SHARED_DISPATCHER] = new Proxy({}, { get: (_target, key) => key === "then" ? undefined : outsideScope });
  const connectTls = tls.connect;
  const connectSocket = net.Socket.prototype.connect;
  let opening = false;
  tls.connect = function confinedTls(this: unknown, ...args: unknown[]) {
    const options = args[0] as { host?: unknown; port?: unknown; servername?: unknown } | null;
    if (callerOf(confinedTls) !== NODE_FETCH || !options || typeof options !== "object" || options.host !== endpoint.host ||
        Number(options.port) !== endpoint.port || (options.servername != null && options.servername !== endpoint.host)) outsideScope();
    opening = true;
    try {
      return Reflect.apply(connectTls, this, args) as tls.TLSSocket;
    } finally {
      opening = false;
    }
  } as typeof tls.connect;
  net.Socket.prototype.connect = function confinedSocket(this: net.Socket, ...args: unknown[]) {
    if (!opening) outsideScope();
    return Reflect.apply(connectSocket, this, args) as net.Socket;
  } as typeof net.Socket.prototype.connect;
  syncBuiltinESMExports();
  return (input, init) => original(input, { ...init, dispatcher } as RequestInit);
}
export type CircleReviewMode = "estimate" | "execute" | "lookup";
export interface CircleReviewRequest {
  mode: CircleReviewMode; wallet: Address; call: DirectCall; idempotencyKey: string;
}
export const CIRCLE_REVIEW_SIGNATURES = {
  attest: "attest((bytes32,(address,uint64,bool,bytes32,bytes,uint256)))",
  revoke: "revoke((bytes32,(bytes32,uint256)))",
} as const;
const SIGNATURES = CIRCLE_REVIEW_SIGNATURES;
const IDENTIFIER = /^[a-zA-Z0-9-]{1,128}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const VENDOR_STATE = /^[A-Z_]{1,32}$/;
const BUILD = /^[0-9a-f]{64}$/;
const TRANSACTION_PATH = "/v1/w3s/transactions/";

/** One step of a vendor run that decides what Circle can do, recorded before it is forwarded. */
export type CircleReviewEvent =
  /** The SHA-256 of the CLI entry point about to load, recorded before any of its code runs. */
  | { event: "vendor"; build: string }
  | { event: "execution-requested" }
  | { event: "challenge"; challengeId: string }
  | { event: "approval-sent" }
  | { event: "transaction"; transactionId: string }
  | { event: "transaction-state"; transactionId: string; state: string; txHash: Hex | null };
export type CircleReviewReporter = (event: CircleReviewEvent) => void;

/** What a vendor run did, folded from its recorded events, whatever the vendor's exit status. */
export interface CircleReviewProgress {
  /** The build that loaded; absent when the vendor never did. */
  build?: string;
  /** The contract execution request left the child. */
  executionRequested: boolean;
  challengeId?: string;
  /** The challenge approval left the child; Circle cannot execute without it. */
  approvalSent: boolean;
  transactionId?: string;
  /** Circle's last reported state for that transaction. */
  state?: string;
  txHash?: Hex;
  /** A line could not be read: treat the run as possibly executed. */
  uncertain: boolean;
}

/** Folds the event lines a child recorded. An unreadable line makes the run uncertain, never harmless. */
export function circleReviewProgress(lines: string): CircleReviewProgress {
  const progress: CircleReviewProgress = { executionRequested: false, approvalSent: false, uncertain: false };
  for (const line of lines.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an event");
      event = parsed as Record<string, unknown>;
    } catch {
      progress.uncertain = true;
      continue;
    }
    if (event.event === "vendor" && typeof event.build === "string" && BUILD.test(event.build) &&
        (progress.build === undefined || progress.build === event.build)) progress.build = event.build;
    else if (event.event === "execution-requested") progress.executionRequested = true;
    else if (event.event === "approval-sent") progress.approvalSent = true;
    else if (event.event === "challenge" && typeof event.challengeId === "string" && IDENTIFIER.test(event.challengeId)) {
      progress.challengeId = event.challengeId;
    } else if (event.event === "transaction" && typeof event.transactionId === "string" && IDENTIFIER.test(event.transactionId)) {
      progress.transactionId ??= event.transactionId;
    } else if (event.event === "transaction-state" && typeof event.transactionId === "string" && IDENTIFIER.test(event.transactionId) &&
        typeof event.state === "string" && VENDOR_STATE.test(event.state)) {
      progress.transactionId ??= event.transactionId;
      if (event.transactionId === progress.transactionId) {
        progress.state = event.state;
        if (typeof event.txHash === "string" && TX_HASH.test(event.txHash)) progress.txHash = event.txHash.toLowerCase() as Hex;
      }
    } else progress.uncertain = true;
  }
  return progress;
}

export function circleReviewTuple(call: DirectCall): unknown[] {
  const data = call.request.data as Record<string, unknown>;
  return [call.request.schema, call.function === "attest"
    ? [data.recipient, data.expirationTime, data.revocable, data.refUID, data.data, data.value]
    : [data.uid, data.value]];
}
export function encodedCircleTuple(action: "attest" | "revoke", tuple: unknown[]): Hex {
  const abi = parseAbi([action === "attest"
    ? "function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data) request) payable returns (bytes32)"
    : "function revoke((bytes32 schema,(bytes32 uid,uint256 value) data) request) payable"]);
  return encodeFunctionData({ abi, functionName: action, args: [tuple] } as never);
}
export function assertCircleReviewRequest(request: CircleReviewRequest): void {
  const { call } = request;
  if (!["estimate", "execute", "lookup"].includes(request.mode) ||
      ![8453, 84532].includes(call.chainId) ||
      call.to.toLowerCase() !== "0x4200000000000000000000000000000000000021" ||
      call.value !== "0" || !["attest", "revoke"].includes(call.function) ||
      !/^0x[0-9a-fA-F]{40}$/.test(request.wallet) ||
      !/^[0-9a-f-]{36}$/i.test(request.idempotencyKey) ||
      encodedCircleTuple(call.function, circleReviewTuple(call)).toLowerCase() !== call.calldata.toLowerCase()) {
    throw new Error("Unqualified Circle review request");
  }
}
export function circleReviewArguments(request: CircleReviewRequest): string[] {
  assertCircleReviewRequest(request);
  const chain = request.call.chainId === 8453 ? "BASE" : "BASE-SEPOLIA";
  if (request.mode === "lookup") return ["transaction", "list", "--address", request.wallet,
    "--chain", chain, "--operation", "execute", "--limit", "50", "--output", "json"];
  return ["wallet", "execute", SIGNATURES[request.call.function], JSON.stringify(circleReviewTuple(request.call)),
    "--contract", request.call.to, "--address", request.wallet, "--chain", chain, "--output", "json",
    ...(request.mode === "estimate" ? ["--estimate"] : ["--idempotency-key", request.idempotencyKey])];
}
/**
 * Check that a vendor request carries exactly the approved call, then send
 * that call's calldata in place of the signature and parameters the CLI
 * builds. Circle cannot execute the review's tuple from parameters: its
 * execution endpoint refuses the tuple as JSON and, given the CLI's text,
 * fails to estimate the transaction after approval (ESTIMATION_ERROR). With
 * callData both endpoints take the exact approved call, and the estimate is
 * the one the JSON tuple gives (all observed live on Base Sepolia,
 * 2026-10-08). Authentication and other fields stay unchanged.
 */
export function normalizeCircleReviewBody(request: CircleReviewRequest, body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid Circle body");
  const b = body as Record<string, unknown>;
  const allowed = new Set(["walletId", "sourceAddress", "blockchain", "contractAddress", "abiFunctionSignature", "abiParameters",
    ...(request.mode === "execute" ? ["idempotencyKey", "feeLevel"] : [])]);
  if (Object.keys(b).some(key => !allowed.has(key)) ||
      typeof b.walletId !== "string" || b.sourceAddress?.toString().toLowerCase() !== request.wallet.toLowerCase() ||
      b.blockchain !== (request.call.chainId === 8453 ? "BASE" : "BASE-SEPOLIA") ||
      b.contractAddress?.toString().toLowerCase() !== request.call.to.toLowerCase() ||
      b.abiFunctionSignature !== SIGNATURES[request.call.function] ||
      !Array.isArray(b.abiParameters) || b.abiParameters.length !== 1 ||
      typeof b.abiParameters[0] !== "string" ||
      (request.mode === "execute" && (b.idempotencyKey !== request.idempotencyKey || b.feeLevel !== "MEDIUM"))) {
    throw new Error("Circle request differs from approved call");
  }
  const tuple: unknown = JSON.parse(b.abiParameters[0]);
  if (!Array.isArray(tuple) || JSON.stringify(tuple) !== JSON.stringify(circleReviewTuple(request.call)) ||
      encodedCircleTuple(request.call.function, tuple).toLowerCase() !== request.call.calldata.toLowerCase()) {
    throw new Error("Circle tuple differs from approved calldata");
  }
  const { abiFunctionSignature: _signature, abiParameters: _parameters, ...rest } = b;
  return { ...rest, callData: request.call.calldata };
}

/** Circle echoes parameters as sent or as strings; booleans may come back as "true"/"false". */
function echoedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(echoedValue);
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

/**
 * Whether a vendor transaction row carries exactly the approved call: same
 * wallet, chain, EAS target and operation, and calldata that is either echoed
 * or re-encodes identically from the echoed signature and parameters.
 */
export function circleRowCarriesCall(row: Record<string, unknown>, request: CircleReviewRequest): boolean {
  if (row.operation !== "CONTRACT_EXECUTION" ||
      String(row.sourceAddress ?? "").toLowerCase() !== request.wallet.toLowerCase() ||
      row.blockchain !== (request.call.chainId === 8453 ? "BASE" : "BASE-SEPOLIA") ||
      String(row.contractAddress ?? row.destinationAddress ?? "").toLowerCase() !== request.call.to.toLowerCase()) return false;
  const calldata = row.callData ?? row.calldata;
  if (typeof calldata === "string") return calldata.toLowerCase() === request.call.calldata.toLowerCase();
  if (row.abiFunctionSignature !== SIGNATURES[request.call.function] || !Array.isArray(row.abiParameters) || row.abiParameters.length !== 1) return false;
  try {
    const first: unknown = row.abiParameters[0];
    const tuple = echoedValue(typeof first === "string" ? JSON.parse(first) : first);
    return Array.isArray(tuple) && encodedCircleTuple(request.call.function, tuple).toLowerCase() === request.call.calldata.toLowerCase();
  } catch {
    return false;
  }
}

async function jsonOf(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = await response.clone().json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
function inner(body: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const data = body?.data && typeof body.data === "object" ? body.data as Record<string, unknown> : body;
  const value = data?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function circleReviewFetchPolicy(request: CircleReviewRequest, original: typeof fetch,
  report: CircleReviewReporter = () => undefined): typeof fetch {
  assertCircleReviewRequest(request);
  let corrected = false;
  let challengeId: string | undefined;
  /** Transactions the bound challenge named once COMPLETE; only these may be polled by id. */
  const transactions = new Set<string>();
  const root = "https://agentic-wallet.circle.com/proxy/" + (request.call.chainId === 8453 ? "live" : "test");
  return async (input, init) => {
    if (typeof input !== "string" || !input.startsWith(root + "/")) throw new Error("Circle endpoint is not allowed");
    const url = new URL(input);
    if (url.username || url.password || url.hash || url.origin !== "https://agentic-wallet.circle.com") throw new Error("Circle URL is not allowed");
    const path = url.pathname.slice(new URL(root).pathname.length);
    const method = init?.method ?? "GET";
    const target = request.mode === "estimate" ? "/v1/w3s/transactions/contractExecution/estimateFee"
      : "/v1/w3s/user/transactions/contractExecution";
    if (request.mode !== "lookup" && path === target && method === "POST" && !url.search) {
      if (corrected || typeof init?.body !== "string") throw new Error("Duplicate or invalid Circle request");
      const body = normalizeCircleReviewBody(request, JSON.parse(init.body));
      corrected = true;
      if (request.mode === "execute") report({ event: "execution-requested" });
      const response = await original(input, { ...init, body: JSON.stringify(body), redirect: "error" });
      if (request.mode === "execute" && response.ok) {
        const payload = await response.clone().json() as { data?: { challengeId?: string }; challengeId?: string };
        const id = payload.data?.challengeId ?? payload.challengeId;
        if (typeof id !== "string" || !IDENTIFIER.test(id)) throw new Error("Circle challenge identity missing");
        challengeId = id;
        report({ event: "challenge", challengeId: id });
      }
      return response;
    }
    const userChallenge = challengeId !== undefined && path === "/v1/w3s/user/challenges/" + challengeId;
    const challengeRead = challengeId !== undefined && (userChallenge || path === "/v1/w3s/sdk/user/challenges/" + challengeId);
    const transactionRead = path.startsWith(TRANSACTION_PATH) && transactions.has(path.slice(TRANSACTION_PATH.length));
    const read = method === "GET" && (path === "/config" ||
      /^\/v1\/w3s\/wallets(?:\/[a-zA-Z0-9-]+)?$/.test(path) ||
      path === "/v1/w3s/transactions" ||
      (!url.search && (challengeRead || transactionRead)));
    const approve = request.mode === "execute" && challengeId !== undefined && method === "POST" &&
      path === "/v1/w3s/sdk/user/challenges/" + challengeId + "/approve" && !url.search;
    if (!read && !approve) throw new Error("Circle request is outside review scope");
    // Recorded before it leaves: without a recorded approval, Circle cannot have executed.
    if (approve) report({ event: "approval-sent" });
    const response = await original(input, { ...init, redirect: "error" });
    if (read && userChallenge && response.ok) {
      const challenge = inner(await jsonOf(response), "challenge");
      if (challenge?.status === "COMPLETE" && Array.isArray(challenge.correlationIds)) {
        for (const id of challenge.correlationIds) {
          if (typeof id !== "string" || !IDENTIFIER.test(id) || transactions.has(id)) continue;
          transactions.add(id);
          report({ event: "transaction", transactionId: id });
        }
      }
    }
    if (read && transactionRead && response.ok) {
      const transaction = inner(await jsonOf(response), "transaction");
      const id = path.slice(TRANSACTION_PATH.length);
      if (transaction && typeof transaction.state === "string" && VENDOR_STATE.test(transaction.state)) {
        report({ event: "transaction-state", transactionId: id, state: transaction.state,
          txHash: typeof transaction.txHash === "string" && TX_HASH.test(transaction.txHash) ? transaction.txHash as Hex : null });
      }
    }
    return response;
  };
}
