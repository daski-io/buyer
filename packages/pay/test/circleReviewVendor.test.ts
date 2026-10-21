/**
 * The direct-review adapter against an installed @circle-fin/cli, offline.
 * The vendor runs in the review child exactly as it does for a user, found on
 * PATH and verified the same way; only Circle's API is a fake
 * (circleVendorApi.ts) standing in for the network. DASKI_TEST_CIRCLE_CLI
 * names the directory that holds that install's `circle` (such as an npm
 * prefix's node_modules/.bin); without it these tests are skipped. The
 * "Circle CLI" workflow runs them against the floor and Circle's latest release.
 */
import assert from "node:assert/strict";
import { createCipheriv, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test, type TestContext } from "node:test";
import { canonicalHash } from "@daski/x402-scheme";
import { encodeFunctionData, type Address } from "viem";
import { confirmationData, EAS_ABI, type DirectCall } from "../src/commands/confirmation.js";
import { circleReviewRunner, createCircleReviewAdapter, resolveCircleReviewEntry } from "../src/signers/circleReview.js";
import type { CircleReviewRequest } from "../src/signers/circleReviewTransport.js";

const bin = process.env.DASKI_TEST_CIRCLE_CLI;
const skip = bin ? false : "set DASKI_TEST_CIRCLE_CLI to the directory of an installed @circle-fin/cli's circle";
const wallet: Address = "0x1111111111111111111111111111111111111111";
const eas: Address = "0x4200000000000000000000000000000000000021";
const txHash = canonicalHash("mined");

function request(mode: CircleReviewRequest["mode"], action: "attest" | "revoke" = "attest"): CircleReviewRequest {
  const schema = canonicalHash("schema");
  const tuple = action === "attest"
    ? { schema, data: { recipient: wallet, expirationTime: "0", revocable: true, refUID: canonicalHash("none"),
      data: confirmationData(canonicalHash("order"), "Confirmed"), value: "0" } }
    : { schema, data: { uid: canonicalHash("uid"), value: "0" } };
  const call: DirectCall = { chainId: 84532, to: eas, function: action, request: tuple,
    calldata: encodeFunctionData({ abi: EAS_ABI, functionName: action, args: [tuple] } as never), value: "0" };
  return { mode, wallet, call, idempotencyKey: "11111111-2222-4333-8444-555555555555" };
}

/** AES-256-GCM as Circle's CLI seals a session secret: base64 of IV, ciphertext and tag. */
function sealed(text: string, keyBase64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), iv);
  return Buffer.concat([iv, cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64");
}

/**
 * A logged-in Base Sepolia session in a fresh Circle home, as `circle wallet
 * login --testnet` leaves it where no keychain holds its secrets, and the
 * adapter for the installed vendor with the fake API in its child.
 */
function vendor(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "daski-circle-vendor-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const encryptionKey = randomBytes(32).toString("base64");
  const storageKey = randomBytes(32).toString("base64");
  const circleHome = join(home, ".circle-cli");
  mkdirSync(join(circleHome, "profiles", "agent"), { recursive: true });
  writeFileSync(join(circleHome, "profiles", "agent", "session.json"), JSON.stringify({ email: "review@example.invalid", testnet: {
    email: "review@example.invalid", userToken: "user-token", encryptionKey, deviceId: "device-1", expiresAt: Date.now() + 3_600_000,
    encryptedUserSecret: sealed("user-secret:1", storageKey), storageKey } }), { mode: 0o600 });
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const log = join(home, "requests.jsonl");
  writeFileSync(log, "");
  writeFileSync(join(home, "api.json"), JSON.stringify({ wallet, encryptionKey, publicKey, txHash, log }));
  const entry = resolveCircleReviewEntry({ PATH: bin });
  const run = circleReviewRunner({ execArgv: ["--import", new URL("./circleVendorApi.js", import.meta.url).href],
    env: { PATH: [bin, process.env.PATH].join(delimiter), HOME: home, CIRCLE_CLI_HOME: circleHome, CIRCLE_ACCEPT_TERMS: "1",
      CIRCLE_REVIEW_TEST_API: join(home, "api.json") } });
  return {
    adapter: createCircleReviewAdapter({ entry, run }),
    /** What reached Circle, without the reads any command may make (the wallet listing, the app configuration). */
    requests: () => readFileSync(log, "utf8").split("\n").filter(Boolean)
      .map(line => JSON.parse(line) as { method: string; url: string; body?: string })
      .map(({ method, url, body }) => ({ route: `${method} ${new URL(url).pathname.replace("/proxy/test", "")}`, body }))
      .filter(({ route }) => route !== "GET /v1/w3s/wallets" && route !== "GET /config"),
  };
}
/** The body Circle received: the approved call's calldata, never the CLI's signature and parameters. */
function sentCall(body: string | undefined, r: CircleReviewRequest): Record<string, unknown> {
  const sent = JSON.parse(body ?? "{}") as Record<string, unknown>;
  assert.equal(sent.callData, r.call.calldata);
  assert.ok(!("abiFunctionSignature" in sent) && !("abiParameters" in sent));
  assert.equal(String(sent.sourceAddress).toLowerCase(), wallet);
  assert.equal(String(sent.contractAddress).toLowerCase(), eas);
  assert.equal(sent.blockchain, "BASE-SEPOLIA");
  assert.equal(sent.walletId, "wallet-1");
  return sent;
}

test("the installed Circle CLI estimates the approved review's exact calldata and sends nothing else", { skip }, async t => {
  for (const action of ["attest", "revoke"] as const) {
    const { adapter, requests } = vendor(t);
    const r = request("estimate", action);
    assert.deepEqual(await adapter.estimate(r), { gasLimit: "201394", networkFee: "0.000000604182", maxFee: "0.003" });
    const sent = requests();
    assert.deepEqual(sent.map(s => s.route), ["POST /v1/w3s/transactions/contractExecution/estimateFee"]);
    assert.ok(!("idempotencyKey" in sentCall(sent[0]!.body, r)));
  }
});

test("the installed Circle CLI submits the approved review once, through the bound challenge, and every decisive step is recorded", { skip }, async t => {
  const { adapter, requests } = vendor(t);
  const r = request("execute");
  assert.deepEqual(await adapter.submit(r), { transactionId: "tx-1", txHash, state: "COMPLETE", progress: {
    executionRequested: true, challengeId: "challenge-1", approvalSent: true, transactionId: "tx-1", state: "COMPLETE", txHash, uncertain: false } });
  const sent = requests();
  assert.deepEqual(sent.map(s => s.route), [
    "POST /v1/w3s/user/transactions/contractExecution",
    "GET /v1/w3s/sdk/user/challenges/challenge-1",
    "POST /v1/w3s/sdk/user/challenges/challenge-1/approve",
    "GET /v1/w3s/user/challenges/challenge-1",
    "GET /v1/w3s/transactions/tx-1",
  ]);
  const execution = sentCall(sent[0]!.body, r);
  assert.equal(execution.idempotencyKey, r.idempotencyKey);
  assert.equal(execution.feeLevel, "MEDIUM");
});

test("the installed Circle CLI's history finds the submitted review by its transaction, read-only", { skip }, async t => {
  const { adapter, requests } = vendor(t);
  const r = request("lookup");
  assert.deepEqual(await adapter.lookup(r, { transactionId: "tx-1" }), { transactionId: "tx-1", hashes: [txHash], state: "COMPLETE" });
  assert.deepEqual(requests().map(s => s.route), ["GET /v1/w3s/transactions"]);
});
