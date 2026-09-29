/**
 * Child-scoped Circle transport policy. Inputs are a buyer-validated EAS call,
 * never arbitrary CLI commands. No credentials are persisted or returned here.
 */
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import type { DirectCall } from "../commands/confirmation.js";
export const CIRCLE_REVIEW_ENTRY_HASHES: Readonly<Record<string, string>> = {
  "1.0.0": "40508e51b251c0c7b696a3ee30f2c21b7052b00b483ec4fc2d64811135ea6df0",
  "1.1.4": "89f8610b586ca929c3419779405b59618c60be10836bc4428d21c75a7c18f6a4",
};
export type CircleReviewMode = "estimate" | "execute" | "lookup";
export interface CircleReviewRequest {
  mode: CircleReviewMode; wallet: Address; call: DirectCall; idempotencyKey: string;
}
const SIGNATURES = {
  attest: "attest((bytes32,(address,uint64,bool,bytes32,bytes,uint256)))",
  revoke: "revoke((bytes32,(bytes32,uint256)))",
} as const;
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
/** Correct exactly one known tuple; authentication and non-target fields stay unchanged. */
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
  return { ...b, abiParameters: [tuple] };
}
export function circleReviewFetchPolicy(request: CircleReviewRequest, original: typeof fetch): typeof fetch {
  assertCircleReviewRequest(request);
  let corrected = false;
  let challengeId: string | undefined;
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
      const response = await original(input, { ...init, body: JSON.stringify(body), redirect: "error" });
      if (request.mode === "execute" && response.ok) {
        const payload = await response.clone().json() as { data?: { challengeId?: string }; challengeId?: string };
        const id = payload.data?.challengeId ?? payload.challengeId;
        if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new Error("Circle challenge identity missing");
        challengeId = id;
      }
      return response;
    }
    const read = method === "GET" && (path === "/config" ||
      /^\/v1\/w3s\/wallets(?:\/[a-zA-Z0-9-]+)?$/.test(path) ||
      path === "/v1/w3s/transactions" ||
      (challengeId !== undefined && (path === "/v1/w3s/user/challenges/" + challengeId || path === "/v1/w3s/sdk/user/challenges/" + challengeId)));
    const approve = request.mode === "execute" && challengeId !== undefined && method === "POST" &&
      path === "/v1/w3s/sdk/user/challenges/" + challengeId + "/approve" && !url.search;
    if (!read && !approve) throw new Error("Circle request is outside review scope");
    return original(input, { ...init, redirect: "error" });
  };
}
