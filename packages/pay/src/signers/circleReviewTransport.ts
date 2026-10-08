/**
 * Child-scoped Circle transport policy. Inputs are a buyer-validated EAS call,
 * never arbitrary CLI commands. No credentials are persisted or returned here.
 *
 * The pinned CLIs (1.1.4, 1.2.0) run `wallet execute` as: list the wallets,
 * POST the contract execution, read the encrypted challenge, POST its
 * approval, poll the user challenge until COMPLETE, then poll the transaction
 * the challenge names (GET /v1/w3s/transactions/<id>) until it is terminal.
 * The policy permits exactly that sequence for the approved call, and records
 * each step that decides whether Circle can execute before forwarding it, so
 * the buyer knows what happened even when the vendor process fails later.
 */
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import type { DirectCall } from "../commands/confirmation.js";
/**
 * dist/index.js SHA-256 of each @circle-fin/cli release whose review requests
 * this policy was checked against. 1.2.0 sends exactly 1.1.4's. Circle's own
 * version policy refuses every command below 1.1.4, so 1.0.0 is not run.
 */
export const CIRCLE_REVIEW_ENTRY_HASHES: Readonly<Record<string, string>> = {
  "1.1.4": "89f8610b586ca929c3419779405b59618c60be10836bc4428d21c75a7c18f6a4",
  "1.2.0": "feb24e3d404b41bfda54ff69b397c892a3c007487f7831904c2617d036afd9b9",
};
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
const TRANSACTION_PATH = "/v1/w3s/transactions/";

/** One step of a vendor run that decides what Circle can do, recorded before it is forwarded. */
export type CircleReviewEvent =
  | { event: "execution-requested" }
  | { event: "challenge"; challengeId: string }
  | { event: "approval-sent" }
  | { event: "transaction"; transactionId: string }
  | { event: "transaction-state"; transactionId: string; state: string; txHash: Hex | null };
export type CircleReviewReporter = (event: CircleReviewEvent) => void;

/** What a vendor run did, folded from its recorded events, whatever the vendor's exit status. */
export interface CircleReviewProgress {
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
    if (event.event === "execution-requested") progress.executionRequested = true;
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
 * Check that a vendor request carries exactly the approved call, in the form
 * its endpoint parses. Circle's estimate endpoint needs the tuple as JSON and
 * fails to estimate the CLI's text; its execution endpoint parses only the
 * text, the CLI's own form, and refuses JSON as an invalid body (both observed
 * live on Base Sepolia, 2026-10-08). Authentication and other fields stay
 * unchanged.
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
  return request.mode === "estimate" ? { ...b, abiParameters: [tuple] } : b;
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
