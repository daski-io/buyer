/** Offline API for the unmodified Circle login CLI. All credentials are synthetic. */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

interface Api {
  root: string; email: string; deviceEncryptionKey: string; encryptionKey: string; storageKey: string;
  userToken: string; otpToken: string; publicKey: string; log: string; initialized: string;
  outcome: "complete" | "conflict" | "failed" | "v2-required";
}
const api = JSON.parse(readFileSync(process.env.CIRCLE_LOGIN_TEST_API!, "utf8")) as Api;

// CIRCLE_CLI_HOME does not isolate the OS keychain. Force file storage and
// block all vendor subprocesses, including reads/writes to credential tools.
const access = fs.access;
fs.access = async (path, mode) => {
  if (/\/(security|secret-tool)$/.test(String(path))) throw new Error("offline test: no keychain");
  return access(path, mode);
};
const noChild = () => { throw new Error("offline login test: subprocess forbidden"); };
childProcess.execFile = noChild as unknown as typeof childProcess.execFile;
childProcess.execFileSync = noChild as typeof childProcess.execFileSync;
childProcess.exec = noChild as unknown as typeof childProcess.exec;
childProcess.execSync = noChild as typeof childProcess.execSync;
childProcess.spawn = noChild as typeof childProcess.spawn;
childProcess.spawnSync = noChild as typeof childProcess.spawnSync;
childProcess.fork = noChild as typeof childProcess.fork;
syncBuiltinESMExports();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { "content-type": "application/json" } });
async function sealed(value: unknown, keyBase64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", Buffer.from(keyBase64, "base64"), "AES-GCM", false, ["encrypt"]);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return Buffer.concat([iv, new Uint8Array(data)]).toString("base64");
}

globalThis.fetch = async (input, init) => {
  const url = String(input);
  assert.ok(url.startsWith(api.root + "/"), "request must stay on the selected network");
  const route = `${init?.method ?? "GET"} ${url.slice(api.root.length).split("?")[0]}`;
  appendFileSync(api.log, JSON.stringify({ route, body: init?.body }) + "\n");
  if (route === "POST /v1/w3s/users/email/token") {
    assert.equal(JSON.parse(String(init?.body)).email, api.email, "preserve the exact email, including the plus tag");
    if (api.outcome === "v2-required") return json({ message: "Account must use the v2 authentication path." }, 409);
    return json({ data: { otpToken: api.otpToken, deviceToken: "synthetic-device-token", deviceEncryptionKey: api.deviceEncryptionKey } });
  }
  if (route === "GET /config") return json({ appId: "synthetic-app" });
  if (route === "POST /v1/w3s/sdk/users/email/verifyOTP" || route === "POST /v1/w3s/sdk/auth/challenges/auth-1/factors") {
    return json({ data: { encrypt: await sealed({ state: "completed", userToken: api.userToken,
      encryptionKey: api.encryptionKey, userSecret: "synthetic-secret:1", storageKey: api.storageKey }, api.deviceEncryptionKey) } });
  }
  if (route === "GET /v1/w3s/auth/challenges/auth-1") {
    return json({ data: { challengeId: "auth-1", operation: "login", state: "completed", result: { accountRootId: "synthetic-root" } } });
  }
  if (route === "POST /v1/w3s/user/initialize") {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.accountType, "SCA");
    assert.ok(body.blockchains.includes(api.root.endsWith("/test") ? "BASE-SEPOLIA" : "BASE"));
    return api.outcome === "conflict" ? json({ code: 409, message: "Initialization conflict" }, 409)
      : json({ data: { challengeId: "init-1" } });
  }
  if (route === "GET /v1/w3s/sdk/user/challenges/init-1") {
    return json({ data: { encrypt: await sealed({ id: "init-1", publicKey: api.publicKey, pinCodeUserShare: "share-1" }, api.encryptionKey) } });
  }
  if (route === "POST /v1/w3s/sdk/user/challenges/init-1/approve") return json({ data: {} });
  if (route === "GET /v1/w3s/user/challenges/init-1") {
    if (api.outcome === "complete") writeFileSync(api.initialized, "yes");
    return json({ data: { challenge: { id: "init-1", status: api.outcome === "failed" ? "FAILED" : "COMPLETE", correlationIds: [] } } });
  }
  if (route === "GET /v1/w3s/wallets") {
    return json({ data: { wallets: existsSync(api.initialized) ? [{ id: "synthetic-wallet", address: "0x1111111111111111111111111111111111111111",
      blockchain: api.root.endsWith("/test") ? "BASE-SEPOLIA" : "BASE", accountType: "SCA", state: "LIVE" }] : [] } });
  }
  if (route === "GET /v1/w3s/user") return json({ data: { status: "ENABLED", pinStatus: existsSync(api.initialized) ? "ENABLED" : "UNSET" } });
  throw new Error(`Unexpected offline login request: ${route}`);
};
