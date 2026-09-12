/**
 * The confirmation requests this CLI sends, proved against the gateway's
 * closed request shapes vendored under test/fixtures/gateway-wire/: every
 * prepare, submit, and check body carries exactly the keys the gateway's
 * parser enforces, per action and mode. A key the gateway does not list, or a
 * missing one, is CONFIRMATION_REQUEST_INVALID on the wire.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { encodeEventTopics, encodeFunctionData, type Address, type Hex } from "viem";
import { canonicalHash, type TypedDataRequest } from "@daski/x402-scheme";
import type { ChainReader } from "../src/chain/reader.js";
import { confirmOrder, confirmationData, EAS_ABI, type ConfirmationFacts } from "../src/commands/confirmation.js";
import type { CommandContext } from "../src/context.js";
import { DEFAULT_CONFIG, EAS_PREDEPLOY } from "../src/config.js";
import { findByIntent, upsertOrder } from "../src/store/orders.js";

function fixtureDirectory(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, "test", "fixtures", "gateway-wire");
    if (existsSync(join(candidate, "confirmation-request-shapes.json"))) return candidate;
    directory = dirname(directory);
  }
  throw new Error("gateway wire fixtures are missing: re-vendor test/fixtures/gateway-wire/ from the gateway");
}

interface Shapes {
  schemaVersion: number;
  submissionModes: string[];
  sponsoredRequires: string;
  shapes: Record<"confirmation" | "revoke-confirmation", { prepare: string[]; submit: string[]; check: string[] }>;
}
const shapes = JSON.parse(readFileSync(join(fixtureDirectory(), "confirmation-request-shapes.json"), "utf8")) as Shapes;

const payer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const profile = { ...DEFAULT_CONFIG.profiles.sandbox! };
const ZERO_UID = `0x${"00".repeat(32)}` as Hex;
const RECIPIENT = "0x4444444444444444444444444444444444444444" as Address;
const UID = canonicalHash("attestation");
const TX = `0x${"aa".repeat(32)}` as Hex;
const facts: ConfirmationFacts = {
  chainId: 84532, eas: EAS_PREDEPLOY, schemaUid: canonicalHash("schema"), reputationStorage: "0x3333333333333333333333333333333333333333",
  orderKey: canonicalHash("order"), recipient: RECIPIENT, currentUid: ZERO_UID, nonce: "0", submissionsUsed: 0,
};
const active = { ...facts, currentUid: UID, submissionsUsed: 1 };
const attestation = { uid: UID, schema: facts.schemaUid, time: 1n, expirationTime: 0n, revocationTime: 0n, refUID: ZERO_UID,
  recipient: RECIPIENT, attester: payer.address, revocable: true, data: confirmationData(facts.orderKey, "Confirmed") };

function directCall(action: "attest" | "revoke", f: ConfirmationFacts) {
  return action === "attest"
    ? { chainId: f.chainId, to: f.eas, function: "attest", request: { schema: f.schemaUid, data: { recipient: f.recipient, expirationTime: "0", revocable: true, refUID: f.currentUid, data: confirmationData(f.orderKey, "Confirmed"), value: "0" } },
      calldata: encodeFunctionData({ abi: EAS_ABI, functionName: "attest", args: [{ schema: f.schemaUid, data: { recipient: f.recipient, expirationTime: 0n, revocable: true, refUID: f.currentUid, data: confirmationData(f.orderKey, "Confirmed"), value: 0n } }] }) }
    : { chainId: f.chainId, to: f.eas, function: "revoke", request: { schema: f.schemaUid, data: { uid: f.currentUid, value: "0" } },
      calldata: encodeFunctionData({ abi: EAS_ABI, functionName: "revoke", args: [{ schema: f.schemaUid, data: { uid: f.currentUid, value: 0n } }] }) };
}

function sponsoredPreparation(action: "attest" | "revoke", f: ConfirmationFacts) {
  const deadline = String(Math.floor(Date.now() / 1000) + 300);
  const common = { schema: f.schemaUid, value: "0", nonce: f.nonce, deadline };
  return { preparationId: "prep", orderKey: f.orderKey, currentRefUid: f.currentUid, submissionsUsed: f.submissionsUsed, finalAttestation: false,
    signableTypedData: { domain: { name: "EAS", version: "1.2.0", chainId: f.chainId, verifyingContract: f.eas },
      types: action === "attest"
        ? { Attest: [{ name: "schema", type: "bytes32" }, { name: "recipient", type: "address" }, { name: "expirationTime", type: "uint64" }, { name: "revocable", type: "bool" }, { name: "refUID", type: "bytes32" }, { name: "data", type: "bytes" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" }] }
        : { Revoke: [{ name: "schema", type: "bytes32" }, { name: "uid", type: "bytes32" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" }] },
      primaryType: action === "attest" ? "Attest" : "Revoke",
      message: action === "attest"
        ? { ...common, recipient: f.recipient, expirationTime: "0", revocable: true, refUID: f.currentUid, data: confirmationData(f.orderKey, "Confirmed") }
        : { ...common, uid: f.currentUid } } };
}

/** A context whose gateway answers every phase and records each request body it received. */
function fixture(accountType: "eoa" | "contract", action: "attest" | "revoke") {
  const f = action === "revoke" ? active : facts;
  const sent: { name: string; request: Record<string, unknown> }[] = [];
  const signer = { getAddress: async () => payer.address,
    describe: () => ({ provider: accountType === "contract" ? "circle-agent" : "local", accountType, conformance: "verified" as const }),
    signTypedData: async (data: TypedDataRequest) => payer.signTypedData(data as never) };
  const reader: ChainReader = {
    getCode: async () => "0x6080", call: async () => ({ data: undefined, reverted: true }),
    getTransactionReceipt: async () => ({ status: "success", blockNumber: 42n, from: payer.address, logs: [{ address: EAS_PREDEPLOY,
      topics: encodeEventTopics({ abi: EAS_ABI, eventName: action === "attest" ? "Attested" : "Revoked", args: { recipient: RECIPIENT, attester: payer.address, schemaUID: facts.schemaUid } }) as Hex[], data: UID }] }),
    getFinalizedBlockNumber: async () => 100n,
    readContract: async <T,>(args: { functionName: string }): Promise<T> => {
      if (args.functionName === "getAttestation") return { ...attestation, revocationTime: action === "revoke" ? 7n : 0n } as T;
      throw new Error(`unexpected read ${args.functionName}`);
    },
  };
  const json = (structuredContent: Record<string, unknown>) => ({ content: [], structuredContent, isError: false });
  const context = { profile, profileName: "sandbox", payerAddress: payer.address, signer, resolveSigner: async () => signer, chain: reader,
    client: { hasTool: async () => true, callTool: async (name: string, args: Record<string, unknown>) => {
      const request = (args.request ?? {}) as Record<string, unknown>;
      const toolAction = name === "daski_revoke_delivery_confirmation" ? "revoke-confirmation" : "confirmation";
      if (!args.authorization) {
        const now = Math.floor(Date.now() / 1000);
        return json({ authorizationRequired: true, challenge: { orderId: "id", action: toolAction, method: "POST",
          absoluteResourceUri: `${profile.gatewayUrl}/orders/handle/actions/${toolAction}`, requestHash: canonicalHash(request),
          nonce: canonicalHash(`${name}-${sent.length}-${Math.random()}`), issuedAt: now, validBefore: now + 120 } });
      }
      sent.push({ name, request });
      if (request.phase === "prepare") {
        return json(request.submission === "direct"
          ? { submissionsUsed: f.submissionsUsed, finalAttestation: false, call: directCall(action, f) }
          : sponsoredPreparation(action, f));
      }
      if (request.phase === "check") return json({ confirmedCurrent: { state: "Confirmed", currentUid: action === "attest" ? UID : ZERO_UID }, finalizedBlock: { number: "50", hash: canonicalHash("b") } });
      return json({ operationId: "op", state: "final" });
    } } } as unknown as CommandContext;
  return { context, sent, facts: f };
}

async function withStore(run: () => Promise<void>): Promise<void> {
  const previous = process.env.DASKI_HOME;
  const home = mkdtempSync(join(tmpdir(), "daski-wire-"));
  process.env.DASKI_HOME = home;
  try {
    const now = new Date().toISOString();
    upsertOrder({ intentId: "intent", handle: "handle", profile: "sandbox", providerAgentId: "1", outcomeId: "form",
      payer: payer.address, amount: "1", state: "FULFILLED", createdAt: now, updatedAt: now });
    await run();
  } finally {
    if (previous === undefined) delete process.env.DASKI_HOME; else process.env.DASKI_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

const keysOf = (request: Record<string, unknown>) => Object.keys(request).sort();
const shape = (action: "attest" | "revoke", phase: "prepare" | "submit" | "check") =>
  [...shapes.shapes[action === "attest" ? "confirmation" : "revoke-confirmation"][phase]].sort();

test("the vendored shapes are the gateway's current ones", () => {
  assert.equal(shapes.schemaVersion, 1);
  assert.deepEqual(shapes.submissionModes, ["sponsored", "direct"]);
  assert.equal(shapes.sponsoredRequires, "eoa");
});

for (const action of ["attest", "revoke"] as const) {
  test(`sponsored ${action}: prepare and submit carry exactly the gateway's keys`, async () => {
    await withStore(async () => {
      const { context, sent, facts: f } = fixture("eoa", action);
      const record = findByIntent("intent")!;
      await confirmOrder(context, record, { handle: "handle", json: true, ...(action === "revoke" ? { revoke: true } : { confirmation: "Confirmed" }) }, async () => f);
      assert.equal(sent.length, 2);
      assert.deepEqual(keysOf(sent[0]!.request), shape(action, "prepare"), "prepare");
      assert.deepEqual(keysOf(sent[1]!.request), shape(action, "submit"), "submit");
      assert.equal(sent[0]!.request.submission, "sponsored");
      assert.equal(sent[1]!.request.submission, "sponsored");
      assert.equal(sent[0]!.name, action === "attest" ? "daski_confirm_delivery" : "daski_revoke_delivery_confirmation");
    });
  });

  test(`direct ${action}: prepare and check carry exactly the gateway's keys, and there is no submit`, async () => {
    await withStore(async () => {
      const { context, sent, facts: f } = fixture("contract", action);
      const record = findByIntent("intent")!;
      await confirmOrder(context, record, { handle: "handle", json: true, ...(action === "revoke" ? { revoke: true } : { confirmation: "Confirmed" }) }, async () => f);
      await confirmOrder(context, findByIntent("intent")!, { handle: "handle", json: true, tx: TX });
      const checked = await confirmOrder(context, findByIntent("intent")!, { handle: "handle", json: true, check: true });
      assert.equal(checked.state, "observed");
      assert.deepEqual(sent.map((entry) => entry.request.phase), ["prepare", "check"]);
      assert.deepEqual(keysOf(sent[0]!.request), shape(action, "prepare"), "prepare");
      assert.deepEqual(keysOf(sent[1]!.request), shape(action, "check"), "check");
      assert.equal(sent[0]!.request.submission, "direct");
      assert.equal(sent[1]!.request.submission, "direct");
    });
  });
}
