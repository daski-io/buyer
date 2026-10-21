import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { canonicalHash } from "@daski/x402-scheme";
import { encodeFunctionData, type Hex } from "viem";
import type { CliError } from "../src/cli/errors.js";
import { confirmationData, EAS_ABI, type DirectCall } from "../src/commands/confirmation.js";
import {
  circleProgressOf, circleReviewEnvironment, createCircleReviewAdapter, matchedCircleTransactions, resolveCircleReviewEntry, spawnCircleReview,
  verifyCircleReviewEntry,
} from "../src/signers/circleReview.js";
import { CIRCLE_REVIEW_MINIMUM_VERSION, circleReviewArguments, circleReviewFetchPolicy, circleReviewPackageVersion, circleReviewProgress,
  circleReviewTuple, circleReviewVersionSupported, normalizeCircleReviewBody, type CircleReviewRequest } from "../src/signers/circleReviewTransport.js";
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
test("both endpoints get the approved call's exact calldata in place of the CLI's signature and parameters, for attest and revoke", () => {
  for (const action of ["attest", "revoke"] as const) {
    for (const mode of ["estimate", "execute"] as const) {
      const r = request(mode, action), b = body(r);
      // Circle cannot execute the tuple from parameters; callData is the exact approved call (live, 2026-10-08).
      const { abiFunctionSignature: _signature, abiParameters: _parameters, ...rest } = b;
      assert.deepEqual(normalizeCircleReviewBody(r, b), { ...rest, callData: r.call.calldata });
      assert.throws(() => normalizeCircleReviewBody(r, { ...b, abiParameters: [circleReviewTuple(r.call)] }), "a vendor body is never already parsed");
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
  const estimated = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
  assert.equal(estimated.callData, r.call.calldata);
  assert.ok(!("abiParameters" in estimated) && !("abiFunctionSignature" in estimated));
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
  const sent: Record<string, unknown>[] = [];
  const policy = circleReviewFetchPolicy(r, (async (input, init) => { seen.push(String(input)); if (init?.body && init.body !== "encrypted") sent.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ data: { challengeId: "bound-challenge" } })); }) as typeof fetch);
  await assert.rejects(policy(root + "/v1/w3s/sdk/user/challenges/other/approve", { method: "POST", body: "encrypted" }));
  await policy(root + "/v1/w3s/user/transactions/contractExecution", { method: "POST", body: JSON.stringify(body(r)) });
  await policy(root + "/v1/w3s/sdk/user/challenges/bound-challenge/approve", { method: "POST", body: "encrypted" });
  await assert.rejects(policy(root + "/v1/w3s/user/transactions/transfer", { method: "POST", body: "{}" }));
  await assert.rejects(policy(root + "/v1/w3s/user/transactions/bound-challenge/cancel", { method: "POST", body: "{}" }));
  assert.equal(seen.length, 2);
  assert.equal(sent[0]!.callData, r.call.calldata, "the execution carries the exact approved calldata");
  assert.ok(!("abiParameters" in sent[0]!) && !("abiFunctionSignature" in sent[0]!));
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

/** An npm install of a synthetic @circle-fin/cli: its package.json, the entry point, and a PATH directory with `circle`. */
function vendorPackage(t: TestContext, pkg: Record<string, unknown>, entry = "export {};\n") {
  const prefix = mkdtempSync(join(tmpdir(), "daski-circle-vendor-"));
  t.after(() => rmSync(prefix, { recursive: true, force: true }));
  const root = join(prefix, "node_modules", "@circle-fin", "cli");
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@circle-fin/cli", type: "module", bin: { circle: "dist/index.js" }, ...pkg }));
  writeFileSync(join(root, "dist", "index.js"), entry);
  mkdirSync(join(prefix, "bin"));
  symlinkSync(join(root, "dist", "index.js"), join(prefix, "bin", "circle"));
  return { root, entry: realpathSync(join(root, "dist", "index.js")), bin: join(prefix, "bin") };
}
const unsupported = { code: "DASKI_CIRCLE_REVIEW_PACKAGE_UNSUPPORTED", message: /@circle-fin\/cli 1\.2\.0 or later/ };

test("every @circle-fin/cli release from 1.2.0 runs reviews whatever its build, and nothing older, prereleased or other", t => {
  assert.equal(CIRCLE_REVIEW_MINIMUM_VERSION, "1.2.0");
  for (const version of ["1.2.0", "1.2.2", "1.3.0", "1.10.0", "2.0.0"]) assert.equal(circleReviewVersionSupported(version), true, version);
  for (const version of ["1.1.4", "1.1.99", "1.0.0", "0.9.0", "1.2.0-beta.1", "1.3.0-rc.0", "1.2", "1.2.0.1", "v1.2.0", "01.2.0", "", undefined, null, 120]) {
    assert.equal(circleReviewVersionSupported(version), false, String(version));
  }
  // A release the hash pin never saw, found on PATH as npm installs it.
  const installed = vendorPackage(t, { version: "1.2.2" });
  assert.equal(resolveCircleReviewEntry({ PATH: installed.bin }), installed.entry);
  assert.equal(verifyCircleReviewEntry(installed.entry), "1.2.2");
  assert.equal(createCircleReviewAdapter({ entry: installed.entry }).packageVersion, "1.2.2");
  assert.equal(verifyCircleReviewEntry(vendorPackage(t, { version: "1.10.0", bin: "./dist/index.js" }).entry), "1.10.0");
  assert.equal(circleReviewPackageVersion(vendorPackage(t, { version: "2.0.0", bin: "dist/index.js" }).entry), "2.0.0");
  // Below the floor, a prerelease, another package, or a file that is not the package's circle.
  for (const pkg of [{ version: "1.1.4" }, { version: "1.3.0-beta.1" }, { version: "1.2.2", name: "@circle-fin/cli-fork" },
    { version: "1.2.2", bin: { circle: "dist/other.js" } }, { version: "1.2.2", bin: { other: "dist/index.js" } }, { version: 2 }]) {
    const candidate = vendorPackage(t, pkg);
    writeFileSync(join(candidate.root, "dist", "other.js"), "export {};\n");
    assert.throws(() => verifyCircleReviewEntry(candidate.entry), unsupported, JSON.stringify(pkg));
    assert.throws(() => createCircleReviewAdapter({ entry: candidate.entry }), unsupported);
  }
  const unnamed = vendorPackage(t, { version: "1.2.2" });
  rmSync(join(unnamed.root, "package.json"));
  assert.throws(() => verifyCircleReviewEntry(unnamed.entry), unsupported);
});

/** A loopback port nothing listens on: a connection attempt to it is refused by the system, not by the buyer. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
/** Vendor-side attempts, each reported as the refusal's message or the system's connection error. */
const ATTEMPTS = `
const outcome = async (attempt) => {
  try { await attempt(); return "connected"; } catch (error) { return String(error?.cause?.code ?? error?.code ?? error?.cause?.message ?? error?.message); }
};
const request = (module, url) => new Promise((resolve, reject) => { const r = module.request(url, resolve); r.on("error", reject); r.end(); });
const socket = (open) => new Promise((resolve, reject) => { const s = open(); s.on("connect", resolve); s.on("error", reject); });
`;
const OUTSIDE = "Circle request is outside review scope";

test("confinement leaves Node's fetch, to its one endpoint, as the only connection the review child can open", async () => {
  const allowed = await closedPort();
  let other = await closedPort();
  while (other === allowed) other = await closedPort();
  const transport = new URL("../src/signers/circleReviewTransport.js", import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import http from "node:http"; import https from "node:https"; import net from "node:net"; import tls, { connect as named } from "node:tls";
    const { confineCircleReviewNetwork } = await import(${JSON.stringify(transport)});
    const confined = await confineCircleReviewNetwork({ host: "127.0.0.1", port: ${allowed} });
    ${ATTEMPTS}
    const shared = globalThis[Symbol.for("undici.globalDispatcher.1")];
    process.stdout.write(JSON.stringify({
      allowed: await outcome(() => confined("https://127.0.0.1:${allowed}/")),
      otherPort: await outcome(() => confined("https://127.0.0.1:${other}/")),
      plainFetch: await outcome(() => fetch("https://127.0.0.1:${allowed}/")),
      sharedDispatcher: await outcome(() => shared.request({ origin: "https://127.0.0.1:${allowed}", path: "/", method: "GET" })),
      tls: await outcome(() => socket(() => tls.connect({ host: "127.0.0.1", port: ${allowed} }))),
      tlsNamed: await outcome(() => socket(() => named({ host: "127.0.0.1", port: ${allowed} }))),
      https: await outcome(() => request(https, "https://127.0.0.1:${allowed}/")),
      http: await outcome(() => request(http, "http://127.0.0.1:${allowed}/")),
      net: await outcome(() => socket(() => net.connect(${allowed}, "127.0.0.1"))),
      socket: await outcome(() => socket(() => new net.Socket().connect(${allowed}, "127.0.0.1"))),
    }));`]);
  assert.deepEqual(JSON.parse(stdout), { allowed: "ECONNREFUSED", otherPort: OUTSIDE, plainFetch: OUTSIDE, sharedDispatcher: OUTSIDE,
    tls: OUTSIDE, tlsNamed: OUTSIDE, https: OUTSIDE, http: OUTSIDE, net: OUTSIDE, socket: OUTSIDE });
});

test("the review child runs an admitted release with only the policy's fetch to reach Circle, and never runs another", async t => {
  const port = await closedPort();
  const vendor = vendorPackage(t, { version: "1.3.0" }, `
    import http from "node:http"; import https from "node:https"; import net from "node:net";
    ${ATTEMPTS}
    const shared = globalThis[Symbol.for("undici.globalDispatcher.1")];
    process.stdout.write(JSON.stringify({ argv: process.argv.slice(2, 4),
      fetch: await outcome(() => fetch("https://127.0.0.1:${port}/")),
      sharedDispatcher: await outcome(() => shared.request({ origin: "https://127.0.0.1:${port}", path: "/", method: "GET" })),
      https: await outcome(() => request(https, "https://127.0.0.1:${port}/")),
      http: await outcome(() => request(http, "http://127.0.0.1:${port}/")),
      net: await outcome(() => socket(() => net.connect(${port}, "127.0.0.1"))),
    }));`);
  const run = await spawnCircleReview(vendor.entry, request("estimate"));
  assert.deepEqual(run.output, { argv: ["wallet", "execute"], fetch: "Circle endpoint is not allowed", sharedDispatcher: OUTSIDE,
    https: OUTSIDE, http: OUTSIDE, net: OUTSIDE });
  assert.deepEqual(run.progress, { executionRequested: false, approvalSent: false, uncertain: false });
  // The child checks the package itself too: an older release never starts, whatever the parent asked.
  const marker = join(vendor.root, "ran");
  const old = vendorPackage(t, { version: "1.1.4" }, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "");`);
  await assert.rejects(spawnCircleReview(old.entry, request("estimate")), (error: CliError) =>
    error.code === "DASKI_CIRCLE_REVIEW_UNKNOWN" && !circleProgressOf(error)!.approvalSent && !existsSync(marker));
});

/**
 * The request sequence @circle-fin/cli 1.2 sends for an agent wallet's
 * `wallet execute` (dist/index.js: resolveWallet, handleAgentExecute,
 * executeChallenge, pollChallenge, pollTransaction), in order; the vendor
 * tests (circleReviewVendor.test.ts) check it against an installed release.
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

test("the Circle CLI's whole execute sequence passes, each decisive step is recorded before it leaves, and only the challenge's transaction can be polled", async () => {
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

/** A `transaction list --output json` row exactly as Circle CLI 1.2 prints it: no idempotencyKey and no callData. */
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
  // A call executed from calldata is listed with null parameters (live, 2026-10-08): its transaction ID identifies it.
  const fromCalldata = { transactions: [printedRow(r, { abiFunctionSignature: undefined, abiParameters: null })] };
  assert.deepEqual(matchedCircleTransactions(fromCalldata, r, { transactionId: "vendor-id" }),
    { transactionId: "vendor-id", hashes: [canonicalHash("printed")], state: "COMPLETE" });
  assert.deepEqual(matchedCircleTransactions(fromCalldata, r, { notBefore }), { hashes: [] }, "a row carrying no call never matches by time alone");
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
  const adapter = createCircleReviewAdapter({ entry: "/synthetic", packageVersion: "1.2.0",
    run: async () => ({ output: { id: "tx-1", state: "COMPLETE", txHash: canonicalHash("mined") }, progress }) });
  assert.deepEqual(await adapter.submit(r), { transactionId: "tx-1", txHash: canonicalHash("mined"), state: "COMPLETE", progress });
  const quiet = createCircleReviewAdapter({ entry: "/synthetic", packageVersion: "1.2.0", run: async () => ({ output: {}, progress }) });
  assert.deepEqual(await quiet.submit(r), { transactionId: "tx-1", txHash: canonicalHash("mined"), state: "COMPLETE", progress });
});
