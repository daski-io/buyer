import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalHash } from "@daski/x402-scheme";
import { encodeFunctionData, type Hex } from "viem";
import { confirmationData, EAS_ABI, type DirectCall } from "../src/commands/confirmation.js";
import { circleReviewEnvironment, createCircleReviewAdapter, matchedCircleTransactions, verifyCircleReviewEntry } from "../src/signers/circleReview.js";
import { CIRCLE_REVIEW_ENTRY_HASHES, circleReviewArguments, circleReviewFetchPolicy, circleReviewProgress, circleReviewTuple,
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
  assert.deepEqual(Object.keys(CIRCLE_REVIEW_ENTRY_HASHES), ["1.1.4", "1.2.0"]);
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
  assert.deepEqual(matchedCircleTransactions([ { ...row, callData: "0x" } ], r, { transactionId: "vendor-id" }), { hashes: [] });
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

/**
 * The request sequence @circle-fin/cli 1.1.4 and 1.2.0 send for an agent
 * wallet's `wallet execute` (dist/index.js: resolveWallet, handleAgentExecute,
 * executeChallenge, pollChallenge, pollTransaction), in order.
 */
function vendorExecuteSequence(r: CircleReviewRequest, transactionId = "tx-from-challenge") {
  return [
    { url: root + "/v1/w3s/wallets?blockchain=BASE-SEPOLIA&address=" + wallet, init: { method: "GET" } },
    { url: root + "/v1/w3s/user/transactions/contractExecution", init: { method: "POST", body: JSON.stringify(body(r)) },
      response: { data: { challengeId: "bound-challenge" } } },
    { url: root + "/config", init: { method: "GET" }, response: { appId: "app" } },
    { url: root + "/v1/w3s/sdk/user/challenges/bound-challenge", init: { method: "GET" }, response: { data: { challenge: { id: "bound-challenge" } } } },
    { url: root + "/v1/w3s/sdk/user/challenges/bound-challenge/approve", init: { method: "POST", body: "encrypted" }, response: { data: {} } },
    { url: root + "/v1/w3s/user/challenges/bound-challenge", init: { method: "GET" },
      response: { data: { challenge: { id: "bound-challenge", status: "COMPLETE", correlationIds: [transactionId] } } } },
    { url: root + "/v1/w3s/transactions/" + transactionId, init: { method: "GET" },
      response: { data: { transaction: { id: transactionId, state: "COMPLETE", txHash: canonicalHash("mined") } } } },
  ];
}

test("the pinned CLIs' whole execute sequence passes, each decisive step is recorded before it leaves, and only the challenge's transaction can be polled", async () => {
  const r = request("execute");
  const events: { event: string; [key: string]: unknown }[] = [];
  const forwarded: string[] = [];
  let pending: Record<string, unknown> = {};
  const policy = circleReviewFetchPolicy(r, (async (input: string) => {
    forwarded.push(input);
    // What the policy had recorded when this request left the child.
    forwarded.push(`events:${events.map(e => e.event).join(",")}`);
    return new Response(JSON.stringify(pending));
  }) as typeof fetch, event => events.push(event));
  for (const step of vendorExecuteSequence(r)) {
    pending = step.response ?? {};
    await policy(step.url, step.init);
  }
  assert.deepEqual(events.map(e => e.event), ["execution-requested", "challenge", "approval-sent", "transaction", "transaction-state"]);
  const approve = forwarded.indexOf(root + "/v1/w3s/sdk/user/challenges/bound-challenge/approve");
  assert.match(forwarded[approve + 1]!, /approval-sent$/, "the approval is recorded before it is forwarded");
  const execution = forwarded.indexOf(root + "/v1/w3s/user/transactions/contractExecution");
  assert.match(forwarded[execution + 1]!, /^events:execution-requested$/);
  assert.deepEqual(events.at(-1), { event: "transaction-state", transactionId: "tx-from-challenge", state: "COMPLETE", txHash: canonicalHash("mined") });
  await assert.rejects(policy(root + "/v1/w3s/transactions/another-transaction", { method: "GET" }), /outside review scope/);
  await assert.rejects(policy(root + "/v1/w3s/transactions/tx-from-challenge/cancel", { method: "POST", body: "{}" }), /outside review scope/);
});

test("a transaction is pollable only once the bound challenge names it as COMPLETE", async () => {
  const r = request("execute");
  let pending: Record<string, unknown> = {};
  const policy = circleReviewFetchPolicy(r, (async () => new Response(JSON.stringify(pending))) as typeof fetch);
  const steps = vendorExecuteSequence(r);
  for (const step of steps.slice(0, 5)) { pending = step.response ?? {}; await policy(step.url, step.init); }
  await assert.rejects(policy(root + "/v1/w3s/transactions/tx-from-challenge", { method: "GET" }), /outside review scope/);
  pending = { data: { challenge: { id: "bound-challenge", status: "PENDING", correlationIds: ["tx-from-challenge"] } } };
  await policy(root + "/v1/w3s/user/challenges/bound-challenge", { method: "GET" });
  await assert.rejects(policy(root + "/v1/w3s/transactions/tx-from-challenge", { method: "GET" }), /outside review scope/);
});

test("a step that cannot be recorded is not forwarded", async () => {
  const r = request("execute");
  const forwarded: string[] = [];
  const policy = circleReviewFetchPolicy(r, (async (input: string) => {
    forwarded.push(input);
    return new Response(JSON.stringify({ data: { challengeId: "bound-challenge" } }));
  }) as typeof fetch, event => { if (event.event === "approval-sent") throw new Error("disk full"); });
  await policy(root + "/v1/w3s/user/transactions/contractExecution", { method: "POST", body: JSON.stringify(body(r)) });
  await assert.rejects(policy(root + "/v1/w3s/sdk/user/challenges/bound-challenge/approve", { method: "POST", body: "encrypted" }), /disk full/);
  assert.equal(forwarded.filter(url => url.endsWith("/approve")).length, 0);
});

test("recorded progress folds to what Circle can have done; an unreadable line makes the run uncertain", () => {
  const lines = [
    { event: "execution-requested" }, { event: "challenge", challengeId: "bound-challenge" },
    { event: "approval-sent" }, { event: "transaction", transactionId: "tx-1" },
    { event: "transaction-state", transactionId: "tx-1", state: "SENT", txHash: null },
    { event: "transaction-state", transactionId: "tx-1", state: "COMPLETE", txHash: canonicalHash("mined") },
  ].map(e => JSON.stringify(e)).join("\n");
  assert.deepEqual(circleReviewProgress(lines), { executionRequested: true, challengeId: "bound-challenge", approvalSent: true,
    transactionId: "tx-1", state: "COMPLETE", txHash: canonicalHash("mined"), uncertain: false });
  assert.deepEqual(circleReviewProgress(JSON.stringify({ event: "execution-requested" }) + "\n"),
    { executionRequested: true, approvalSent: false, uncertain: false }, "refused before any approval");
  assert.equal(circleReviewProgress('{"event":"execution-requested"}\n{"event":"approv').uncertain, true);
  assert.equal(circleReviewProgress('{"event":"something-else"}').uncertain, true);
  assert.equal(circleReviewProgress("").approvalSent, false);
});

/** A `transaction list --output json` row exactly as the pinned CLIs print it: no idempotencyKey and no callData. */
function printedRow(r: CircleReviewRequest, overrides: Record<string, unknown> = {}) {
  return { id: "vendor-id", state: "COMPLETE", blockchain: "BASE-SEPOLIA", txHash: canonicalHash("printed"),
    sourceAddress: wallet, destinationAddress: eas, operation: "CONTRACT_EXECUTION", transactionType: "OUTBOUND",
    abiFunctionSignature: circleReviewArguments({ ...r, mode: "estimate" })[2],
    abiParameters: [circleReviewTuple(r.call)], contractAddress: eas,
    createDate: "2026-10-07T12:00:30Z", updateDate: "2026-10-07T12:01:00Z", ...overrides };
}

test("vendor history as the CLIs print it matches by the challenge's transaction or by the exact call after submission started", () => {
  const r = request("lookup");
  const notBefore = "2026-10-07T12:00:00Z";
  const printed = { transactions: [printedRow(r)] };
  assert.deepEqual(matchedCircleTransactions(printed, r, { transactionId: "vendor-id" }),
    { transactionId: "vendor-id", hashes: [canonicalHash("printed")], state: "COMPLETE" });
  assert.deepEqual(matchedCircleTransactions(printed, r, { notBefore }),
    { transactionId: "vendor-id", hashes: [canonicalHash("printed")], state: "COMPLETE" });
  // Circle may echo booleans and numbers as strings.
  const stringly = JSON.parse(JSON.stringify(circleReviewTuple(r.call)).replace("true", '"true"'));
  assert.equal(matchedCircleTransactions({ transactions: [printedRow(r, { abiParameters: [stringly] })] }, r, { notBefore }).transactionId, "vendor-id");
  assert.equal(matchedCircleTransactions({ transactions: [printedRow(r, { abiParameters: [JSON.stringify(circleReviewTuple(r.call))] })] }, r, { notBefore }).transactionId, "vendor-id");
  // Another order's or another choice's review, an earlier row, or no identity at all never match.
  const other = request("lookup", "revoke");
  assert.deepEqual(matchedCircleTransactions({ transactions: [printedRow(other)] }, r, { notBefore }), { hashes: [] });
  assert.deepEqual(matchedCircleTransactions({ transactions: [printedRow(r, { createDate: "2026-10-07T11:00:00Z" })] }, r, { notBefore }), { hashes: [] });
  assert.deepEqual(matchedCircleTransactions(printed, r), { hashes: [] });
  assert.deepEqual(matchedCircleTransactions({ transactions: [printedRow(r, { id: "other-id" })] }, r, { transactionId: "vendor-id" }), { hashes: [] });
  // A row with the recorded ID but no call fields at all is still that transaction.
  const bare = { id: "vendor-id", state: "FAILED", txHash: null };
  assert.deepEqual(matchedCircleTransactions({ transactions: [bare] }, r, { transactionId: "vendor-id" }), { transactionId: "vendor-id", hashes: [], state: "FAILED" });
  // Two exact-call rows are ambiguous: no identity, though each hash is still checked on chain.
  const twice = { transactions: [printedRow(r), printedRow(r, { id: "second-id", txHash: canonicalHash("second") })] };
  assert.deepEqual(matchedCircleTransactions(twice, r, { notBefore }), { hashes: [canonicalHash("printed"), canonicalHash("second")] });
});

test("the adapter reports the transaction from the vendor output or, failing that, from the recorded progress", async () => {
  const r = request("execute");
  const progress = { executionRequested: true, challengeId: "bound-challenge", approvalSent: true, transactionId: "tx-1",
    state: "COMPLETE", txHash: canonicalHash("mined"), uncertain: false };
  const adapter = createCircleReviewAdapter({ entry: "/synthetic", packageVersion: "1.1.4",
    run: async () => ({ output: { id: "tx-1", state: "COMPLETE", txHash: canonicalHash("mined") }, progress }) });
  assert.deepEqual(await adapter.submit(r), { transactionId: "tx-1", txHash: canonicalHash("mined"), state: "COMPLETE", progress });
  const quiet = createCircleReviewAdapter({ entry: "/synthetic", packageVersion: "1.1.4", run: async () => ({ output: {}, progress }) });
  assert.deepEqual(await quiet.submit(r), { transactionId: "tx-1", txHash: canonicalHash("mined"), state: "COMPLETE", progress });
});
