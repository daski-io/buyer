/**
 * A fake of Circle's agent wallet API for the offline vendor tests
 * (circleReviewVendor.test.ts). The review child loads it with --import,
 * before its own code: it takes the place of Node's fetch, so an installed
 * @circle-fin/cli runs a whole review and nothing leaves the machine. It
 * answers the requests a review makes, in the shapes Circle answered them
 * live (2026-10), and appends every request it receives to the test's log.
 */
import { appendFileSync, readFileSync } from "node:fs";

interface Api { wallet: string; encryptionKey: string; publicKey: string; txHash: string; log: string; refuseExecution?: boolean }
const api = JSON.parse(readFileSync(process.env.CIRCLE_REVIEW_TEST_API!, "utf8")) as Api;
const ROOT = "https://agentic-wallet.circle.com/proxy/test";
const EAS = "0x4200000000000000000000000000000000000021";
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** Circle's SDK responses: AES-GCM under the session's encryption key, the IV first. */
async function sealed(value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", Buffer.from(api.encryptionKey, "base64"), "AES-GCM", false, ["encrypt"]);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return Buffer.concat([iv, new Uint8Array(data)]).toString("base64");
}
// A call Circle executed from calldata is listed with neither signature nor parameters (live, 2026-10-08).
const transaction = () => ({ id: "tx-1", state: "COMPLETE", blockchain: "BASE-SEPOLIA", txHash: api.txHash, sourceAddress: api.wallet,
  destinationAddress: EAS, contractAddress: EAS, operation: "CONTRACT_EXECUTION", transactionType: "OUTBOUND",
  abiFunctionSignature: null, abiParameters: null, createDate: new Date().toISOString(), updateDate: new Date().toISOString() });
const fee = (gwei: string) => ({ gasLimit: "201394", baseFee: gwei, priorityFee: "0.001", maxFee: gwei, networkFee: "0.000000604182" });

// The review child keeps the dispatcher Node's fetch creates on first use.
await fetch("data:,");
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith("data:")) return new Response("");
  const method = init?.method ?? "GET";
  appendFileSync(api.log, JSON.stringify({ method, url, ...(typeof init?.body === "string" ? { body: init.body } : {}) }) + "\n");
  const path = url.startsWith(ROOT + "/") ? new URL(url).pathname.slice("/proxy/test".length) : undefined;
  const route = `${method} ${path}`;
  if (route === "GET /v1/w3s/wallets") {
    return json({ data: { wallets: [{ id: "wallet-1", address: api.wallet, blockchain: "BASE-SEPOLIA", accountType: "SCA", state: "LIVE" }] } });
  }
  if (route === "POST /v1/w3s/transactions/contractExecution/estimateFee") {
    return json({ data: { low: fee("0.0015"), medium: fee("0.003"), high: fee("0.0045"),
      callGasLimit: "48711", verificationGasLimit: "102811", preVerificationGas: "49872" } });
  }
  if (route === "POST /v1/w3s/user/transactions/contractExecution") {
    return api.refuseExecution ? json({ code: 155101, message: "Request refused" }, 400) : json({ data: { challengeId: "challenge-1" } });
  }
  if (route === "GET /config") return json({ appId: "app-1" });
  if (route === "GET /v1/w3s/sdk/user/challenges/challenge-1") {
    return json({ data: { encrypt: await sealed({ id: "challenge-1", publicKey: api.publicKey, pinCodeUserShare: "share-1" }) } });
  }
  if (route === "POST /v1/w3s/sdk/user/challenges/challenge-1/approve") return json({ data: {} });
  if (route === "GET /v1/w3s/user/challenges/challenge-1") {
    return json({ data: { challenge: { id: "challenge-1", status: "COMPLETE", correlationIds: ["tx-1"] } } });
  }
  if (route === "GET /v1/w3s/transactions/tx-1") return json({ data: { transaction: transaction() } });
  if (route === "GET /v1/w3s/transactions") return json({ data: { transactions: [transaction()] } });
  return json({ code: 404, message: "Not found" }, 404);
};
