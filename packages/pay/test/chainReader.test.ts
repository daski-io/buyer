/**
 * The viem-backed reader against a local JSON-RPC endpoint that behaves like
 * Base's public one: it admits five `eth_call`s per client and refuses the
 * rest with HTTP 429. The review preflight has to fit inside that allowance,
 * and a refusal has to be named for what it is, without printing the path an
 * API key sits in.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeFunctionData, encodeFunctionResult, isAddressEqual, multicall3Abi, toHex, type Abi, type Address, type Hex,
} from "viem";
import { createChainReader, MULTICALL3_ADDRESS, readContracts, type ChainReader } from "../src/chain/reader.js";
import { discoverEasReviewProfile, EAS_IDENTITY_ABI } from "../src/chain/easProfiles.js";
import { CliError } from "../src/cli/errors.js";
import { EAS_ABI, REPUTATION_ABI } from "../src/commands/confirmation.js";

const REPUTATION: Address = "0x3333333333333333333333333333333333333333";
const PAYER: Address = "0x30C8384C2e5477283D6ae38F1A929b8075EB5863";
const ORDER_KEY: Hex = `0x${"ab".repeat(32)}`;
const KEY_PATH = "/v3/not-a-real-key";

function easFixture() {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let n = 0; n < 8; n++, directory = dirname(directory)) {
    const path = join(directory, "test/fixtures/eas/base-8453.json");
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  }
  throw new Error("Missing pinned EAS runtime fixture");
}

const record = {
  orderKey: ORDER_KEY, authorizationKey: ORDER_KEY, providerAgentId: 95751n, serviceId: ORDER_KEY, payer: PAYER,
  providerOwner: REPUTATION, providerAgentWallet: REPUTATION, providerPayee: REPUTATION, canonicalToken: REPUTATION,
  grossAmount: 9_990_000n, paidAt: 1n, providerIdentitySnapshotHash: ORDER_KEY, listingManifestHash: ORDER_KEY,
  releaseEvidenceHash: ORDER_KEY, outcome: 1, confirmation: 0, outcomeAttestationDelay: 0n, outcomeTimestamp: 1n,
  confirmationTimestamp: 0n, confirmationSubmissions: 0, outcomeRecorded: true, reputationEligible: true,
  currentConfirmationUid: `0x${"00".repeat(32)}`,
} as const;

type Refusal = { status: number; error: { code: number; message: string } };

/** A local Base-like RPC. `refuse` answers every eth_call with one fixed refusal instead. */
async function withRpc(options: { allowance?: number; refuse?: Refusal },
  run: (url: string, seen: { ethCalls: number }) => Promise<void>): Promise<void> {
  const f = easFixture();
  const seen = { ethCalls: 0 };
  const answer = (to: Address, data: Hex): Hex => {
    const read = (abi: Abi, result: (functionName: string) => unknown) => {
      const { functionName } = decodeFunctionData({ abi, data });
      return encodeFunctionResult({ abi, functionName, result: result(functionName) } as never);
    };
    if (isAddressEqual(to, REPUTATION)) return read(REPUTATION_ABI, () => record);
    if (data.startsWith("0x2d0335ab")) return read(EAS_ABI, () => 0n);
    return read(EAS_IDENTITY_ABI, (functionName) => f[functionName]);
  };
  const result = (method: string, params: unknown[]): unknown => {
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_getBlockByNumber") {
      return { number: toHex(BigInt(f.blockNumber)), hash: f.blockHash, parentHash: `0x${"00".repeat(32)}`,
        timestamp: toHex(BigInt(f.blockTimestamp)), transactions: [], uncles: [] };
    }
    if (method === "eth_getStorageAt") return `0x${"0".repeat(24)}${f.eas.implementation.slice(2)}`;
    if (method === "eth_getCode") return f.eas.runtimeCode;
    if (method === "eth_call") {
      const { to, data } = params[0] as { to: Address; data: Hex };
      if (!isAddressEqual(to, MULTICALL3_ADDRESS)) return answer(to, data);
      const { args } = decodeFunctionData({ abi: multicall3Abi, data });
      const calls = args[0] as readonly { target: Address; callData: Hex }[];
      return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3",
        result: calls.map((call) => ({ success: true, returnData: answer(call.target, call.callData) })) as never });
    }
    throw new Error(`unexpected ${method}`);
  };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      const refusal = method !== "eth_call" ? undefined
        : options.refuse ?? (++seen.ethCalls > (options.allowance ?? 5)
          ? { status: 429, error: { code: -32016, message: "over rate limit" } } : undefined);
      response.writeHead(refusal?.status ?? 200, { "content-type": "application/json" });
      response.end(JSON.stringify(refusal ? { jsonrpc: "2.0", id, error: refusal.error } : { jsonrpc: "2.0", id, result: result(method, params) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  try {
    await run(`http://127.0.0.1:${address.port}${KEY_PATH}`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The preflight's chain reads, composed as readConfirmationFacts composes them. */
function preflight(reader: ChainReader) {
  return Promise.all([
    readContracts(reader, [
      { address: REPUTATION, abi: REPUTATION_ABI, functionName: "getRecord", args: [ORDER_KEY] },
      { address: "0x4200000000000000000000000000000000000021", abi: EAS_ABI, functionName: "getNonce", args: [PAYER] },
    ]),
    discoverEasReviewProfile(reader, 8453, "0x4200000000000000000000000000000000000021"),
  ]);
}

test("the review preflight spends two eth_calls, inside a public RPC's allowance of five", async () => {
  await withRpc({}, async (url, seen) => {
    const reader = createChainReader(url, "finalized");
    const [[current, nonce], profile] = await preflight(reader);
    assert.equal((current as { orderKey: Hex }).orderKey, ORDER_KEY);
    assert.equal(nonce, 0n);
    assert.equal(profile.id, "eas-native-1.0.1");
    assert.equal(seen.ethCalls, 2);
    await preflight(reader);
    assert.equal(seen.ethCalls, 4, "a second run still fits");
  });
  // Read one at a time, the same values are six eth_calls, and the sixth is refused.
  await withRpc({}, async (url, seen) => {
    const { readContracts: _batched, ...unbatched } = createChainReader(url, "finalized");
    await assert.rejects(preflight(unbatched), (error: unknown) => error instanceof CliError && error.code === "DASKI_RPC_RATE_LIMITED");
    assert.equal(seen.ethCalls, 6);
  });
});

test("a rate-limit refusal is named as one, with what the RPC said and without the endpoint's path", async () => {
  await withRpc({ allowance: 0 }, async (url) => {
    const refused = await preflight(createChainReader(url, "finalized")).catch((error: unknown) => error);
    assert.ok(refused instanceof CliError);
    assert.equal(refused.code, "DASKI_RPC_RATE_LIMITED");
    assert.match(refused.message, /HTTP 429, RPC error -32016: over rate limit/);
    assert.deepEqual(refused.details, { retryable: true, httpStatus: 429, rpcErrorCode: -32016 });
    assert.ok(!refused.message.includes(KEY_PATH) && refused.message.includes("/…"), refused.message);
  });
  await withRpc({ refuse: { status: 200, error: { code: -32005, message: "limit exceeded" } } }, async (url) => {
    await assert.rejects(createChainReader(url, "finalized").readContract({ address: REPUTATION, abi: REPUTATION_ABI,
      functionName: "getRecord", args: [ORDER_KEY] }), (error: unknown) => error instanceof CliError &&
      error.code === "DASKI_RPC_RATE_LIMITED" && error.details.rpcErrorCode === -32005 && !("httpStatus" in error.details));
    // A refused signature check is unknown, not a revert that would read as an invalid signature.
    await assert.rejects(createChainReader(url, "finalized").call({ to: REPUTATION, data: "0x1626ba7e", gas: 1_000_000n }),
      (error: unknown) => error instanceof CliError && error.code === "DASKI_RPC_RATE_LIMITED");
  });
});

test("any other refusal stays unavailable and carries the RPC's own words", async () => {
  await withRpc({ refuse: { status: 403, error: { code: -32602, message: "Archive requests require a personal token" } } }, async (url) => {
    await assert.rejects(preflight(createChainReader(url, "finalized")), (error: unknown) => error instanceof CliError &&
      error.code === "DASKI_RPC_UNAVAILABLE" &&
      error.message.includes("(HTTP 403, RPC error -32602: Archive requests require a personal token)") &&
      !error.message.includes(KEY_PATH));
    // A signature check refused this way is unknown too, not a revert that would read as an invalid signature.
    await assert.rejects(createChainReader(url, "finalized").call({ to: REPUTATION, data: "0x1626ba7e", gas: 1_000_000n }),
      (error: unknown) => error instanceof CliError && error.code === "DASKI_RPC_UNAVAILABLE" &&
        error.details.httpStatus === 403 && error.details.rpcErrorCode === -32602);
  });
});
