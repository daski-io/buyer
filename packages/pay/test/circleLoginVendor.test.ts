/** Inspect initialization and legacy refusal against an installed, unmodified Circle CLI.
 * This proves client control flow with a fake API, not live account recovery.
 * Uses the same opt-in and vendor-version matrix as circleReviewVendor.test.ts.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { resolveCircleReviewEntry } from "../src/signers/circleReview.js";

const bin = process.env.DASKI_TEST_CIRCLE_CLI;
const skip = bin ? false : "set DASKI_TEST_CIRCLE_CLI to an installed Circle CLI's bin directory";
const email = "buyer+recovery@example.invalid";
const jwt = (payload: object) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.synthetic`;

function vendor(t: TestContext, testnet = true, outcome = "complete") {
  const home = mkdtempSync(join(tmpdir(), "daski-circle-login-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = `https://agentic-wallet.circle.com/proxy/${testnet ? "test" : "live"}`;
  const deviceEncryptionKey = randomBytes(32).toString("base64");
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const otpToken = jwt({ otpHead: "TST" });
  const log = join(home, "requests.jsonl");
  writeFileSync(log, "");
  const api = join(home, "api.json");
  writeFileSync(api, JSON.stringify({ root, email, deviceEncryptionKey, otpToken, publicKey, log, outcome,
    initialized: join(home, "initialized"), encryptionKey: randomBytes(32).toString("base64"), storageKey: randomBytes(32).toString("base64"),
    userToken: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) }));
  const entry = resolveCircleReviewEntry({ PATH: bin });
  const circleHome = join(home, "circle");
  const flags = testnet ? ["--testnet"] : [];
  function run(args: string[], legacy = false) {
    const result = spawnSync(process.execPath, ["--import", new URL("./circleLoginVendorApi.js", import.meta.url).href, entry,
      "wallet", ...args, "--type", "agent", "--output", "json"], {
      encoding: "utf8", timeout: 15_000,
      env: { PATH: process.env.PATH, CIRCLE_CLI_HOME: circleHome, CIRCLE_ACCEPT_TERMS: "1", CIRCLE_LOGIN_TEST_API: api,
        CIRCLE_EXPERIMENTAL_AUTH_V2: legacy ? "0" : "1" },
    });
    assert.ifError(result.error);
    return { status: result.status, output: JSON.parse(result.stdout), stderr: result.stderr };
  }
  const sessionFile = join(circleHome, "profiles", "agent", "session.json");
  return {
    run, flags, circleHome, sessionFile,
    routes: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line).route as string),
    list: () => run(["list", "--chain", testnet ? "BASE-SEPOLIA" : "BASE"]),
    startLegacy() {
      const start = run(["login", email, ...flags, "--init"], true);
      assert.equal(start.status, 0, JSON.stringify(start));
      const requestId = String(start.output.data.message).match(/--request ([0-9a-f-]{36})/)?.[1];
      assert.ok(requestId, "Circle must return a fresh request ID in its completion command");
      const request = JSON.parse(readFileSync(join(circleHome, "login-requests", requestId + ".json"), "utf8"));
      assert.equal(request.email, email);
      assert.equal(request.testnet, testnet);
      assert.equal(request.authPath, undefined);
      assert.equal(request.proxyUrl, root);
      return requestId;
    },
    seedV2Returning() {
      const requestId = randomUUID();
      mkdirSync(join(circleHome, "login-requests"), { recursive: true });
      writeFileSync(join(circleHome, "login-requests", requestId + ".json"), JSON.stringify({ requestId, email, testnet, profile: "agent",
        deviceId: "synthetic-device", deviceToken: "synthetic-device-token", deviceEncryptionKey, proxyUrl: root, timestamp: Date.now(),
        authPath: "wus-v2", challengeId: "auth-1", correlationState: "synthetic-state", operation: "login", otpToken, emailFactorIndex: 0, otpHead: "TST" }));
      return requestId;
    },
  };
}

test("installed Circle returning login saves a valid session but skips initialization", { skip }, t => {
  const v = vendor(t);
  const result = v.run(["login", ...v.flags, "--request", v.seedV2Returning(), "--otp", "123456"]);
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.ok(existsSync(v.sessionFile), "synthetic session must use the isolated file, never the OS keychain");
  assert.equal(v.run(["status"]).output.data.testnet.tokenStatus, "VALID");
  assert.deepEqual(v.list().output.data.wallets, []);
  const create = v.run(["create", ...v.flags]);
  assert.equal(create.status, 1);
  assert.equal(create.output.error.code, "AUTH_REQUIRED");
  assert.match(create.output.error.message, /^User not initialized\./);
  assert.deepEqual(v.routes(), ["GET /config", "POST /v1/w3s/sdk/auth/challenges/auth-1/factors",
    "GET /v1/w3s/auth/challenges/auth-1", "GET /v1/w3s/wallets", "GET /v1/w3s/user"]);
});

test("installed Circle legacy login initializes when the service accepts it: the same exact email on the selected network", { skip }, t => {
  for (const testnet of [true, false]) {
    const v = vendor(t, testnet);
    // First reproduce the partial state, then recover it without logout. Keep
    // a second-network session for the same account throughout the attempt.
    assert.equal(v.run(["login", ...v.flags, "--request", v.seedV2Returning(), "--otp", "123456"]).status, 0);
    const before = JSON.parse(readFileSync(v.sessionFile, "utf8"));
    const otherNetwork = testnet ? "mainnet" : "testnet";
    const otherSession = { ...before[testnet ? "testnet" : "mainnet"], deviceId: "other-network-device" };
    writeFileSync(v.sessionFile, JSON.stringify({ ...before, [otherNetwork]: otherSession }));
    assert.deepEqual(v.list().output.data.wallets, []);
    const priorRoutes = v.routes().length;
    const requestId = v.startLegacy();
    const result = v.run(["login", ...v.flags, "--request", requestId, "--otp", "123456"], true);
    assert.equal(result.status, 0, JSON.stringify(result));
    const session = JSON.parse(readFileSync(v.sessionFile, "utf8"));
    assert.equal(session.email, email);
    assert.equal(session[testnet ? "testnet" : "mainnet"].email, email);
    assert.deepEqual(session[otherNetwork], otherSession, "preserve the other network's existing session");
    assert.equal(v.list().output.data.wallets.length, 1);
    assert.deepEqual(v.routes().slice(priorRoutes), ["POST /v1/w3s/users/email/token", "GET /config", "POST /v1/w3s/sdk/users/email/verifyOTP",
      "POST /v1/w3s/user/initialize", "GET /config", "GET /v1/w3s/sdk/user/challenges/init-1",
      "POST /v1/w3s/sdk/user/challenges/init-1/approve", "GET /v1/w3s/user/challenges/init-1", "GET /v1/w3s/wallets"]);
  }
});

test("installed Circle can report legacy login success without a usable wallet: verify the result", { skip }, t => {
  for (const outcome of ["conflict", "failed"]) {
    const v = vendor(t, true, outcome);
    const requestId = v.startLegacy();
    const result = v.run(["login", ...v.flags, "--request", requestId, "--otp", "123456"], true);
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.equal(v.run(["status"]).output.data.testnet.tokenStatus, "VALID");
    assert.deepEqual(v.list().output.data.wallets, [], "a successful login alone is not recovery");
    assert.equal(v.routes().filter(route => route === "POST /v1/w3s/user/initialize").length, 1);
  }
});

test("installed Circle v2-required account refuses legacy login before OTP or initialization and preserves sessions", { skip }, t => {
  for (const testnet of [true, false]) {
    const v = vendor(t, testnet, "v2-required");
    assert.equal(v.run(["login", ...v.flags, "--request", v.seedV2Returning(), "--otp", "123456"]).status, 0);
    const before = JSON.parse(readFileSync(v.sessionFile, "utf8"));
    const otherNetwork = testnet ? "mainnet" : "testnet";
    before[otherNetwork] = { ...before[testnet ? "testnet" : "mainnet"], deviceId: "other-network-device" };
    writeFileSync(v.sessionFile, JSON.stringify(before));
    const savedSession = readFileSync(v.sessionFile, "utf8");
    const requests = readdirSync(join(v.circleHome, "login-requests"));
    const priorRoutes = v.routes().length;

    const result = v.run(["login", email, ...v.flags, "--init"], true);
    assert.equal(result.status, 1);
    assert.equal(result.output.error.code, "CONFLICT");
    assert.match(result.output.error.message, /Account must use the v2 authentication path\./);
    assert.doesNotMatch(JSON.stringify(result.output), /--request|--otp/);
    assert.deepEqual(v.routes().slice(priorRoutes), ["POST /v1/w3s/users/email/token"],
      "refusal must not reach OTP verification, initialization, or a retry");
    assert.deepEqual(readdirSync(join(v.circleHome, "login-requests")), requests, "no pending login request is created");
    assert.equal(readFileSync(v.sessionFile, "utf8"), savedSession, "both sessions must remain byte-for-byte intact");
    assert.equal(v.run(["status"]).output.data[testnet ? "testnet" : "mainnet"].tokenStatus, "VALID");
    assert.deepEqual(v.list().output.data.wallets, []);
  }
});
