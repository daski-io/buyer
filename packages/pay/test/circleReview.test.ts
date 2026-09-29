import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalHash } from "@daski/x402-scheme";
import { encodeFunctionData, type Hex } from "viem";
import { confirmationData, EAS_ABI, type DirectCall } from "../src/commands/confirmation.js";
import { circleReviewEnvironment, matchedCircleTransactions, verifyCircleReviewEntry } from "../src/signers/circleReview.js";
import { CIRCLE_REVIEW_ENTRY_HASHES, circleReviewArguments, circleReviewFetchPolicy, circleReviewTuple,
  normalizeCircleReviewBody, type CircleReviewRequest } from "../src/signers/circleReviewTransport.js";
const wallet = "0x1111111111111111111111111111111111111111";
const eas = "0x4200000000000000000000000000000000000021";
const zero = ("0x" + "00".repeat(32)) as Hex;
function request(mode: CircleReviewRequest["mode"] = "estimate", action: "attest" | "revoke" = "attest"): CircleReviewRequest {
  const schema = canonicalHash("schema"), uid = canonicalHash("uid");
  const data = { recipient: wallet, expirationTime: "0", revocable: true, refUID: zero,
    data: confirmationData(canonicalHash("order"), "Confirmed"), value: "0" };
  const tuple = action === "attest" ? { schema, data } : { schema, data: { uid, value: "0" } };
  const call: DirectCall = { chainId: 84532, to: eas, function: action, request: tuple,
    calldata: encodeFunctionData({ abi: EAS_ABI, functionName: action, args: [tuple] } as never), value: "0" };
  return { mode, wallet, call, idempotencyKey: "11111111-2222-4333-8444-555555555555" };
}
function body(r: CircleReviewRequest) {
  return { walletId: "wallet-id", sourceAddress: wallet, blockchain: "BASE-SEPOLIA", contractAddress: eas,
    abiFunctionSignature: circleReviewArguments({ ...r, mode: "estimate" })[2],
    abiParameters: [JSON.stringify(circleReviewTuple(r.call))],
    ...(r.mode === "execute" ? { feeLevel: "MEDIUM", idempotencyKey: r.idempotencyKey } : {}) };
}
const root = "https://agentic-wallet.circle.com/proxy/test";
test("both pinned Circle artifacts require identical bounded tuple correction for attest and revoke", () => {
  assert.deepEqual(Object.keys(CIRCLE_REVIEW_ENTRY_HASHES), ["1.0.0", "1.1.4"]);
  for (const action of ["attest", "revoke"] as const) {
    for (const mode of ["estimate", "execute"] as const) {
      const r = request(mode, action), b = body(r);
      assert.deepEqual(normalizeCircleReviewBody(r, b), { ...b, abiParameters: [circleReviewTuple(r.call)] });
      assert.throws(() => normalizeCircleReviewBody(r, { ...b, abiParameters: [circleReviewTuple(r.call)] }), "already parsed is not silently corrected twice");
      assert.throws(() => normalizeCircleReviewBody(r, { ...b, contractAddress: wallet }));
      assert.throws(() => normalizeCircleReviewBody(r, { ...b, amount: "1" }));
      assert.throws(() => normalizeCircleReviewBody(r, { ...b, callData: r.call.calldata }));
      assert.throws(() => normalizeCircleReviewBody(r, { ...b, abiParameters: ["[]"] }));
    }
  }
});
test("estimation permits one exact read-only request and cannot create or approve an execution challenge", async () => {
  const r = request();
  const calls: { input: unknown; init?: RequestInit }[] = [];
  const policy = circleReviewFetchPolicy(r, (async (input, init) => { calls.push({ input, ...(init ? { init } : {}) }); return new Response("{}"); }) as typeof fetch);
  const headers = { "X-User-Token": "synthetic-secret" };
  await policy(root + "/v1/w3s/transactions/contractExecution/estimateFee", { method: "POST", headers, body: JSON.stringify(body(r)) });
  assert.equal(calls[0]!.init!.headers, headers, "authentication is preserved without printing or returning it");
  assert.deepEqual(JSON.parse(calls[0]!.init!.body as string).abiParameters, [circleReviewTuple(r.call)]);
  assert.equal(calls[0]!.init!.redirect, "error");
  for (const url of [root + "/v1/w3s/user/transactions/contractExecution", root + "/v1/w3s/sdk/user/challenges/arbitrary/approve",
    "https://evil.example/proxy/test/v1/w3s/transactions", root.replace("/test", "/live") + "/v1/w3s/transactions"]) {
    await assert.rejects(policy(url, { method: "POST", body: "{}" }));
  }
  await assert.rejects(policy(root + "/v1/w3s/transactions/contractExecution/estimateFee", { method: "POST", body: JSON.stringify(body(r)) }));
  assert.equal(calls.length, 1);
});
test("execute permits only approval of its returned challenge and never transfer or cancel", async () => {
  const r = request("execute");
  const seen: string[] = [];
  const policy = circleReviewFetchPolicy(r, (async input => { seen.push(String(input)); return new Response(JSON.stringify({ data: { challengeId: "bound-challenge" } })); }) as typeof fetch);
  await assert.rejects(policy(root + "/v1/w3s/sdk/user/challenges/other/approve", { method: "POST", body: "encrypted" }));
  await policy(root + "/v1/w3s/user/transactions/contractExecution", { method: "POST", body: JSON.stringify(body(r)) });
  await policy(root + "/v1/w3s/sdk/user/challenges/bound-challenge/approve", { method: "POST", body: "encrypted" });
  await assert.rejects(policy(root + "/v1/w3s/user/transactions/transfer", { method: "POST", body: "{}" }));
  await assert.rejects(policy(root + "/v1/w3s/user/transactions/bound-challenge/cancel", { method: "POST", body: "{}" }));
  assert.equal(seen.length, 2);
});
test("lookup command is read-only and vendor lineage requires identity plus exact calldata", async () => {
  const r = request("lookup");
  assert.deepEqual(circleReviewArguments(r).slice(0, 2), ["transaction", "list"]);
  assert.ok(!circleReviewArguments(r).includes("execute") || circleReviewArguments(r).includes("--operation"));
  const row = { id: "vendor-id", idempotencyKey: r.idempotencyKey, operation: "CONTRACT_EXECUTION", sourceAddress: wallet,
    blockchain: "BASE-SEPOLIA", contractAddress: eas, callData: r.call.calldata, txHash: canonicalHash("first") };
  assert.deepEqual(matchedCircleTransactions({ data: { transactions: [row, { ...row, txHash: canonicalHash("replacement") }] } }, r),
    { transactionId: "vendor-id", hashes: [canonicalHash("first"), canonicalHash("replacement")] });
  assert.deepEqual(matchedCircleTransactions([ { ...row, idempotencyKey: "other" } ], r), { hashes: [] });
  assert.deepEqual(matchedCircleTransactions([ { ...row, callData: "0x" } ], r, "vendor-id"), { hashes: [] });
  const policy = circleReviewFetchPolicy(r, (async () => new Response("{}")) as typeof fetch);
  await policy(root + "/v1/w3s/transactions?operation=CONTRACT_EXECUTION", { method: "GET" });
  await assert.rejects(policy(root + "/v1/w3s/user/transactions/contractExecution", { method: "POST", body: "{}" }));
});
test("review subprocess strips credentials from Daski, preload hooks and proxy overrides", () => {
  assert.deepEqual(circleReviewEnvironment({ PATH: "/synthetic", HOME: "/synthetic-home", DASKI_PAYER_PRIVATE_KEY: "private",
    NODE_OPTIONS: "--import arbitrary", NODE_PATH: "/injected", CIRCLE_PROXY_URL: "https://evil", HTTPS_PROXY: "https://evil" }),
  { PATH: "/synthetic", HOME: "/synthetic-home" });
  assert.throws(() => verifyCircleReviewEntry("/definitely-missing/entry"), { code: "DASKI_CIRCLE_REVIEW_PACKAGE_UNSUPPORTED" });
});
