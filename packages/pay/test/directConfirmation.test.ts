import { EAS_REVIEW_PROFILES } from "../src/chain/easProfiles.js";
/**
 * Direct-mode delivery confirmation: the mode follows the signer, the
 * prepared call is validated field by field against chain facts and the
 * pinned EAS before it is shown, the record moves prepared → submitted →
 * observed only on matching evidence, and the CLI never sends anything.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { encodeEventTopics, encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { canonicalHash, type SignerDescription, type TypedDataRequest } from "@daski/x402-scheme";
import type { ChainLog, ChainReader, TransactionReceiptLike } from "../src/chain/reader.js";
import { CliError } from "../src/cli/errors.js";
import {
  confirmOrder, confirmationData, EAS_ABI, FINAL_ATTESTATION_WARNING, readConfirmationFacts,
  selectConfirmationMode, validateDirectCall, type ConfirmationFacts, type DirectCall,
} from "../src/commands/confirmation.js";
import type { CommandContext } from "../src/context.js";
import { DEFAULT_CONFIG, EAS_PREDEPLOY } from "../src/config.js";
import { parseGatewayMetadata } from "../src/gateway/metadata.js";
import { findByIntent, updateOrder, upsertOrder, type OrderRecord } from "../src/store/orders.js";
import { createCircleReviewAdapter, spawnCircleReview } from "../src/signers/circleReview.js";

const code = (wanted: string) => (error: unknown): boolean => error instanceof CliError && error.code === wanted;
const payer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const profile = { ...DEFAULT_CONFIG.profiles.sandbox! };
const ZERO_UID = `0x${"00".repeat(32)}` as Hex;
const RECIPIENT = "0x4444444444444444444444444444444444444444" as Address;
const REPUTATION = "0x3333333333333333333333333333333333333333" as Address;
const facts: ConfirmationFacts = {
  profile: EAS_REVIEW_PROFILES[84532]!, chainId: 84532, eas: EAS_PREDEPLOY, schemaUid: canonicalHash("schema"), reputationStorage: REPUTATION,
  orderKey: canonicalHash("order"), recipient: RECIPIENT, currentUid: ZERO_UID, nonce: "0", submissionsUsed: 0,
};
const TX = `0x${"aa".repeat(32)}` as Hex;
const UID = canonicalHash("new attestation");
/** The canonical chain of the fixture RPC: block n has hash canonicalHash("block-n") unless a test overrides it. */
const blockHashAt = (number: bigint): Hex => canonicalHash(`block-${number}`);

function attestCall(f: ConfirmationFacts = facts, choice: "Confirmed" | "NotConfirmed" = "Confirmed"): DirectCall {
  const data = confirmationData(f.orderKey, choice);
  return {
    chainId: f.chainId, to: f.eas, function: "attest",
    request: { schema: f.schemaUid, data: { recipient: f.recipient, expirationTime: "0", revocable: true, refUID: f.currentUid, data, value: "0" } },
    calldata: encodeFunctionData({ abi: EAS_ABI, functionName: "attest", args: [{ schema: f.schemaUid,
      data: { recipient: f.recipient, expirationTime: 0n, revocable: true, refUID: f.currentUid, data, value: 0n } }] }),
    value: "0",
  };
}

function revokeCall(f: ConfirmationFacts): DirectCall {
  return {
    chainId: f.chainId, to: f.eas, function: "revoke",
    request: { schema: f.schemaUid, data: { uid: f.currentUid, value: "0" } },
    calldata: encodeFunctionData({ abi: EAS_ABI, functionName: "revoke", args: [{ schema: f.schemaUid, data: { uid: f.currentUid, value: 0n } }] }),
    value: "0",
  };
}

const description = (accountType: SignerDescription["accountType"]): SignerDescription =>
  ({ provider: accountType === "contract" ? "circle-agent" : "local", accountType, conformance: "verified" });

/** A receipt carrying one EAS event, optionally from another contract. */
function receipt(args: { event?: "Attested" | "Revoked"; emitter?: Address; attester?: Address; schema?: Hex; uid?: Hex; status?: "success" | "reverted"; blockHash?: Hex } = {}): TransactionReceiptLike {
  const topics = encodeEventTopics({ abi: EAS_ABI, eventName: args.event ?? "Attested",
    args: { recipient: RECIPIENT, attester: args.attester ?? payer.address, schemaUID: args.schema ?? facts.schemaUid } });
  return { status: args.status ?? "success", blockNumber: 42n, blockHash: args.blockHash ?? blockHashAt(42n), from: payer.address,
    logs: [{ address: args.emitter ?? EAS_PREDEPLOY, topics: topics as Hex[], data: args.uid ?? UID }] };
}

interface Attestation { uid: Hex; schema: Hex; time: bigint; expirationTime: bigint; revocationTime: bigint; refUID: Hex; recipient: Address; attester: Address; revocable: boolean; data: Hex }
const attestation = (overrides: Partial<Attestation> = {}): Attestation => ({
  uid: UID, schema: facts.schemaUid, time: 1n, expirationTime: 0n, revocationTime: 0n, refUID: ZERO_UID,
  recipient: RECIPIENT, attester: payer.address, revocable: true, data: confirmationData(facts.orderKey, "Confirmed"), ...overrides,
});

interface Fixture {
  context: CommandContext;
  calls: { name: string; request: Record<string, unknown> }[];
  chain: { receipt: TransactionReceiptLike | null; attestation: Attestation; record?: Record<string, unknown>; finalized: bigint;
    /** Canonical block hashes the fixture RPC reports, by height; defaults to blockHashAt. */
    canonical: Map<bigint, Hex>;
    /** Attestations by uid for batched receipts; falls back to `attestation`. */
    attestations: Map<Hex, Attestation>;
    /** Every reader call, in order, for ordering assertions. */
    log: string[];
    /** Mined EAS logs the fixture RPC returns to a matching getLogs. */
    logs: ChainLog[] };
  gateway: { prepared: Record<string, unknown>; check: Record<string, unknown>; eas: Address };
}

function fixture(accountType: SignerDescription["accountType"]): Fixture {
  const json = (structuredContent: Record<string, unknown>, isError = false) => ({ content: [], structuredContent, isError });
  const signer = { getAddress: async () => payer.address, describe: () => description(accountType),
    signTypedData: async (data: TypedDataRequest) => payer.signTypedData(data as never) };
  const calls: Fixture["calls"] = [];
  const chainState: Fixture["chain"] = { receipt: null, attestation: attestation(), finalized: 100n, canonical: new Map(), attestations: new Map(), log: [], logs: [] };
  const gateway: Fixture["gateway"] = { prepared: { submissionsUsed: 0, revocationAvailable: false, finalAttestation: false, call: attestCall() },
    check: { lastObserved: null, confirmedCurrent: null, submissionsUsed: 0, observedBlock: null, finalizedBlock: null }, eas: EAS_PREDEPLOY };
  const reader: ChainReader = {
    getCode: async () => "0x6080",
    call: async () => ({ data: undefined, reverted: true }),
    getTransactionReceipt: async (hash) => { assert.equal(hash, TX); chainState.log.push("receipt"); return chainState.receipt; },
    getFinalBlockNumber: async () => { chainState.log.push("final"); return chainState.finalized; },
    getBlockHash: async (number) => { chainState.log.push(`blockHash:${number}`); return chainState.canonical.get(number) ?? blockHashAt(number); },
    getLogs: async ({ address, topics, fromBlock, toBlock }) => {
      chainState.log.push(`logs:${fromBlock}-${toBlock}`);
      return chainState.logs.filter(log => log.address.toLowerCase() === address.toLowerCase() && log.blockNumber >= fromBlock &&
        log.blockNumber <= toBlock && topics.every((topic, index) => log.topics[index]?.toLowerCase() === topic.toLowerCase()));
    },
    readContract: async <T,>(args: { functionName: string; args: readonly unknown[]; blockNumber?: bigint }): Promise<T> => {
      chainState.log.push(`${args.functionName}${args.blockNumber === undefined ? "" : `@${args.blockNumber}`}`);
      if (args.functionName === "getAttestation") return (chainState.attestations.get(args.args[0] as Hex) ?? chainState.attestation) as T;
      if (args.functionName === "getNonce") return 0n as T;
      if (args.functionName === "getRecord") return (chainState.record ?? {}) as T;
      throw new Error(`unexpected read ${args.functionName}`);
    },
  };
  const context = { profile, profileName: "sandbox", payerAddress: payer.address, signer, resolveSigner: async () => signer, chain: reader,
    metadata: async () => parseGatewayMetadata({ confirmationSigning: { profile: EAS_REVIEW_PROFILES[84532]!, chainId: 84532, eas: gateway.eas, schemaUid: facts.schemaUid, reputationStorage: REPUTATION } }),
    client: { hasTool: async () => true, callTool: async (name: string, args: Record<string, unknown>) => {
      if (name === "daski_get_order_status" && args.readCapability) return json({ orderKey: facts.orderKey, state: "FULFILLED" });
      const action = name === "daski_get_order_access" ? "grant-read" : name === "daski_revoke_delivery_confirmation" ? "revoke-confirmation" : "confirmation";
      const request = (args.request ?? {}) as Record<string, unknown>;
      if (!args.authorization) {
        const now = Math.floor(Date.now() / 1000);
        return json({ authorizationRequired: true, challenge: { orderId: "id", action, method: "POST",
          absoluteResourceUri: `${profile.gatewayUrl}/orders/handle/actions/${action}`, requestHash: canonicalHash(request),
          nonce: canonicalHash(`${name}-${calls.length}-${Math.random()}`), issuedAt: now, validBefore: now + 120 } });
      }
      calls.push({ name, request });
      if (request.phase === "prepare") return json(gateway.prepared);
      if (request.phase === "check") return json(gateway.check);
      return json({ ok: true });
    } } } as unknown as CommandContext;
  return { context, calls, chain: chainState, gateway };
}

async function withStore(run: (record: OrderRecord) => Promise<void>): Promise<void> {
  const previous = process.env.DASKI_HOME;
  const home = mkdtempSync(join(tmpdir(), "daski-direct-"));
  process.env.DASKI_HOME = home;
  try {
    const now = new Date().toISOString();
    await run(upsertOrder({ intentId: "intent", handle: "handle", profile: "sandbox", providerAgentId: "1", outcomeId: "form",
      payer: payer.address, amount: "27100000", state: "FULFILLED", createdAt: now, updatedAt: now,
      readCapability: { token: "cap", expiresAt: Math.floor(Date.now() / 1000) + 600 } }));
  } finally {
    if (previous === undefined) delete process.env.DASKI_HOME; else process.env.DASKI_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

const current = () => findByIntent("intent")!;
/** The gateway's block view: a decimal string and the canonical hash at that height. */
const block = (number: number, hash = blockHashAt(BigInt(number))) => ({ number: String(number), hash });
const factsReader = (f: ConfirmationFacts = facts) => async () => f;
const options = { handle: "handle", json: true };

/** The gateway's sponsored attest preparation for the fixture facts, signable as is. */
function sponsoredAttestPreparation(): Record<string, unknown> {
  const deadline = String(Math.floor(Date.now() / 1000) + 300);
  return { preparationId: "prep", profileId: "eas-native-1.2.0", domainVersion: "1.2.0", signedDeadline: deadline, admissionExpiresAt: new Date(Number(deadline) * 1000).toISOString(), orderKey: facts.orderKey, currentRefUid: facts.currentUid, submissionsUsed: 0, finalAttestation: false,
    signableTypedData: { domain: { name: "EAS", version: "1.2.0", chainId: facts.chainId, verifyingContract: facts.eas },
      types: { Attest: [{ name: "schema", type: "bytes32" }, { name: "recipient", type: "address" }, { name: "expirationTime", type: "uint64" },
        { name: "revocable", type: "bool" }, { name: "refUID", type: "bytes32" }, { name: "data", type: "bytes" }, { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" }] },
      primaryType: "Attest", message: { schema: facts.schemaUid, recipient: facts.recipient, expirationTime: "0", revocable: true,
        refUID: facts.currentUid, data: confirmationData(facts.orderKey, "Confirmed"), value: "0", nonce: facts.nonce, deadline } } };
}

test("the mode follows the signer: contract accounts submit directly, plain wallets are sponsored unless they ask", () => {
  assert.equal(selectConfirmationMode(description("contract"), undefined), "direct");
  assert.equal(selectConfirmationMode(description("eoa"), undefined), "sponsored");
  assert.equal(selectConfirmationMode(description("unknown"), undefined), "sponsored");
  assert.equal(selectConfirmationMode(description("eoa"), "direct"), "direct");
  assert.equal(selectConfirmationMode(description("eoa"), "sponsored"), "sponsored");
  assert.throws(() => selectConfirmationMode(description("contract"), "sponsored"), code("DASKI_CONFIRMATION_SPONSORED_REQUIRES_EOA"));
  assert.throws(() => selectConfirmationMode(description("eoa"), "relayed"), code("DASKI_CONFIRMATION_SUBMISSION_INVALID"));
});

test("a direct call is accepted only when every field derives from chain facts and re-encodes identically", () => {
  const valid = validateDirectCall(attestCall(), facts, "Confirmed", EAS_PREDEPLOY);
  assert.equal(valid.action, "attest");
  assert.equal(valid.call.calldata, attestCall().calldata.toLowerCase());
  assert.throws(() => validateDirectCall(attestCall(), facts, "NotConfirmed", EAS_PREDEPLOY), code("DASKI_CONFIRMATION_PREPARATION_INVALID"), "another label");
  const tampered: [string, (call: DirectCall) => unknown][] = [
    ["chain", (call) => ({ ...call, chainId: 8453 })],
    ["target", (call) => ({ ...call, to: REPUTATION })],
    ["function", (call) => ({ ...call, function: "revoke" })],
    ["schema", (call) => ({ ...call, request: { ...call.request, schema: canonicalHash("other") } })],
    ["recipient", (call) => ({ ...call, request: { ...call.request, data: { ...(call.request.data as object), recipient: REPUTATION } } })],
    ["refUID", (call) => ({ ...call, request: { ...call.request, data: { ...(call.request.data as object), refUID: canonicalHash("x") } } })],
    ["data", (call) => ({ ...call, request: { ...call.request, data: { ...(call.request.data as object), data: confirmationData(facts.orderKey, "NotConfirmed") } } })],
    ["value", (call) => ({ ...call, request: { ...call.request, data: { ...(call.request.data as object), value: "1" } } })],
    ["expiration", (call) => ({ ...call, request: { ...call.request, data: { ...(call.request.data as object), expirationTime: "1" } } })],
    ["revocable", (call) => ({ ...call, request: { ...call.request, data: { ...(call.request.data as object), revocable: false } } })],
    ["calldata", (call) => ({ ...call, calldata: `${call.calldata.slice(0, -2)}00` })],
    ["extra key", (call) => ({ ...call, gas: "21000" })],
    ["outer value", (call) => ({ ...call, value: "1" })],
    ["missing outer value", (call) => { const { value: _value, ...rest } = call; return rest; }],
    ["extra field", (call) => ({ ...call, request: { ...call.request, data: { ...(call.request.data as object), memo: "hi" } } })],
  ];
  for (const [label, tamper] of tampered) {
    assert.throws(() => validateDirectCall(tamper(attestCall()), facts, "Confirmed", EAS_PREDEPLOY), code("DASKI_CONFIRMATION_PREPARATION_INVALID"), label);
  }
  // A mismatched EAS target: the call names the pinned address but the profile pins another.
  assert.throws(() => validateDirectCall(attestCall(), facts, "Confirmed", REPUTATION), code("DASKI_CONFIRMATION_PREPARATION_INVALID"));
  assert.throws(() => validateDirectCall(attestCall({ ...facts, submissionsUsed: 3 }), { ...facts, submissionsUsed: 3 }, "Confirmed", EAS_PREDEPLOY),
    code("DASKI_CONFIRMATION_PREPARATION_INVALID"), "no attestation left");
  const active = { ...facts, currentUid: UID, submissionsUsed: 1 };
  assert.equal(validateDirectCall(revokeCall(active), active, "revoke", EAS_PREDEPLOY).action, "revoke");
  assert.throws(() => validateDirectCall(revokeCall(facts), facts, "revoke", EAS_PREDEPLOY), code("DASKI_CONFIRMATION_PREPARATION_INVALID"), "nothing to revoke");
  assert.throws(() => validateDirectCall({ ...revokeCall(active), request: { schema: active.schemaUid, data: { uid: canonicalHash("x"), value: "0" } } }, active, "revoke", EAS_PREDEPLOY),
    code("DASKI_CONFIRMATION_PREPARATION_INVALID"), "another uid");
});

test("a contract signer walks prepared → submitted → observed on matching evidence, and unrelated receipts leave it submitted", async () => {
  await withStore(async (record) => {
    const { context, calls, chain, gateway } = fixture("contract");
    const prepared = await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader());
    assert.equal(prepared.mode, "direct");
    assert.deepEqual(prepared.call, { ...attestCall(), calldata: attestCall().calldata.toLowerCase() });
    assert.equal(calls[0]!.request.submission, "direct");
    assert.equal(calls[0]!.request.phase, "prepare");
    assert.equal(current().confirmationTx?.state, "prepared");
    assert.deepEqual(current().confirmationTx?.expected, { schema: facts.schemaUid, recipient: RECIPIENT, refUID: ZERO_UID,
      dataHash: keccak256(confirmationData(facts.orderKey, "Confirmed")) });
    await assert.rejects(confirmOrder(context, current(), { ...options, confirmation: "Confirmed" }, factsReader()), code("DASKI_CONFIRMATION_TX_PENDING"));
    await assert.rejects(confirmOrder(context, current(), { ...options, check: true }), code("DASKI_CONFIRMATION_TX_NOT_RECORDED"));
    await assert.rejects(confirmOrder(context, current(), { ...options, tx: "0x1234" }), code("DASKI_CONFIRMATION_TX_MALFORMED"));

    const submitted = await confirmOrder(context, current(), { ...options, tx: TX });
    assert.equal(submitted.state, "submitted");
    assert.equal(current().confirmationTx?.txHash, TX, "the hash is on disk immediately, unverified");
    assert.equal(current().confirmationTx?.state, "submitted");
    await assert.rejects(confirmOrder(context, current(), { ...options, abandon: true }), code("DASKI_CONFIRMATION_TX_MAY_EXECUTE"),
      "a pending hash cannot be abandoned");
    const pending = await confirmOrder(context, current(), { ...options, check: true });
    assert.equal(pending.receipt, "pending");
    assert.equal(current().confirmationTx?.state, "submitted");

    chain.receipt = receipt({ emitter: REPUTATION });
    await assert.rejects(confirmOrder(context, current(), { ...options, check: true }), code("DASKI_CONFIRMATION_RECEIPT_UNRELATED"), "another emitting contract");
    assert.equal(current().confirmationTx?.state, "submitted");
    chain.receipt = receipt();
    chain.attestation = attestation({ data: confirmationData(canonicalHash("another order"), "Confirmed") });
    await assert.rejects(confirmOrder(context, current(), { ...options, check: true }), code("DASKI_CONFIRMATION_RECEIPT_UNRELATED"),
      "same payer and schema, another order's attestation");
    assert.equal(current().confirmationTx?.state, "submitted");
    chain.attestation = attestation({ refUID: canonicalHash("other") });
    await assert.rejects(confirmOrder(context, current(), { ...options, check: true }), code("DASKI_CONFIRMATION_RECEIPT_UNRELATED"), "refUID differs");
    chain.attestation = attestation();
    await assert.rejects(confirmOrder(context, current(), { ...options, abandon: true }), code("DASKI_CONFIRMATION_TX_MAY_EXECUTE"),
      "an executed transaction cannot be abandoned");

    const unfinalized = await confirmOrder(context, current(), { ...options, check: true });
    assert.equal(unfinalized.state, "submitted");
    assert.equal(unfinalized.receipt, "success");
    assert.equal(unfinalized.uid, UID);
    const check = calls.at(-1)!;
    assert.deepEqual(check.request, { phase: "check", submission: "direct" });
    assert.equal(check.name, "daski_confirm_delivery");

    gateway.check = { lastObserved: { state: "Confirmed", currentUid: UID }, confirmedCurrent: { state: "Confirmed", currentUid: UID, submissionsUsed: 1 },
      submissionsUsed: 1, observedBlock: block(50), finalizedBlock: block(41) };
    assert.equal((await confirmOrder(context, current(), { ...options, check: true })).state, "submitted",
      "a finalized read from before the receipt's block proves nothing, even with the new uid");
    gateway.check = { ...gateway.check, finalizedBlock: block(42) };
    const observed = await confirmOrder(context, current(), { ...options, check: true });
    assert.equal(observed.state, "observed");
    assert.equal(observed.review, "current");
    assert.equal(current().confirmationTx?.state, "observed");
    assert.equal(current().confirmationTx?.uid, UID);
    await assert.rejects(confirmOrder(context, current(), { ...options, tx: TX }), code("DASKI_CONFIRMATION_TX_ALREADY_RECORDED"));
    // Once observed, a plain --check asks the gateway for the current state and reports the record as history;
    // --submission direct re-verifies the record itself.
    const afterwards = await confirmOrder(context, current(), { ...options, check: true });
    assert.equal(afterwards.state, "checked");
    assert.equal((afterwards.directRecord as { state: string }).state, "observed");
    assert.equal((await confirmOrder(context, current(), { ...options, check: true, submission: "direct" })).state, "observed");

    // The observed record no longer blocks a new preparation.
    gateway.prepared = { submissionsUsed: 1, revocationAvailable: true, finalAttestation: false, call: attestCall({ ...facts, currentUid: UID, submissionsUsed: 1 }) };
    const again = await confirmOrder(context, current(), { ...options, confirmation: "Confirmed" }, factsReader({ ...facts, currentUid: UID, submissionsUsed: 1 }));
    assert.equal(again.mode, "direct");
    assert.equal(current().confirmationTx?.state, "prepared");
  });
});

test("abandon clears local tracking only when nothing can execute, and says it cancels nothing at the wallet", async () => {
  await withStore(async (record) => {
    const { context, chain } = fixture("contract");
    await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader());
    const abandoned = await confirmOrder(context, current(), { ...options, abandon: true });
    assert.equal(abandoned.state, "abandoned");
    assert.match(String(abandoned.note), /cancels nothing at the wallet/);
    assert.equal(current().confirmationTx?.state, "abandoned");
    await confirmOrder(context, current(), { ...options, confirmation: "Confirmed" }, factsReader());
    await confirmOrder(context, current(), { ...options, tx: TX });
    chain.receipt = receipt({ status: "reverted" });
    const reverted = await confirmOrder(context, current(), { ...options, check: true });
    assert.equal(reverted.receipt, "reverted");
    assert.equal(current().confirmationTx?.state, "submitted");
    assert.equal((await confirmOrder(context, current(), { ...options, abandon: true })).state, "abandoned");
    await assert.rejects(confirmOrder(context, current(), { ...options, abandon: true }), code("DASKI_CONFIRMATION_TX_NOT_PREPARED"));
    await assert.rejects(confirmOrder(context, current(), { ...options, check: true, abandon: true }), code("DASKI_CONFIRMATION_FLAGS_CONFLICT"));
  });
});

test("a revocation binds to the attestation it revokes and is observed only once revoked and no longer current", async () => {
  await withStore(async (record) => {
    const active = { ...facts, currentUid: UID, submissionsUsed: 1 };
    const { context, chain, gateway } = fixture("contract");
    gateway.prepared = { submissionsUsed: 1, revocationAvailable: true, finalAttestation: false, call: revokeCall(active) };
    const prepared = await confirmOrder(context, record, { ...options, revoke: true }, factsReader(active));
    assert.equal(prepared.action, "revoke");
    assert.deepEqual(current().confirmationTx?.expected, { schema: facts.schemaUid, recipient: RECIPIENT, refUID: ZERO_UID,
      dataHash: keccak256(confirmationData(facts.orderKey, "Confirmed")), uid: UID });
    await confirmOrder(context, current(), { ...options, tx: TX });
    chain.receipt = receipt({ event: "Revoked" });
    await assert.rejects(confirmOrder(context, current(), { ...options, check: true }), code("DASKI_CONFIRMATION_RECEIPT_UNRELATED"), "not revoked on chain");
    chain.attestation = attestation({ revocationTime: 7n });
    gateway.check = { confirmedCurrent: { state: "Confirmed", currentUid: UID }, finalizedBlock: block(41) };
    assert.equal((await confirmOrder(context, current(), { ...options, check: true })).state, "submitted", "the anchor is behind the receipt");
    // A finalized read from before the attestation existed carries the zero uid,
    // which differs from the revoked one; without the block anchor it would pass.
    gateway.check = { confirmedCurrent: { state: "Pending", currentUid: ZERO_UID, submissionsUsed: 0 }, finalizedBlock: block(1) };
    assert.equal((await confirmOrder(context, current(), { ...options, check: true })).state, "submitted", "a pre-attestation finalized state is not evidence");
    gateway.check = { confirmedCurrent: { state: "Pending", currentUid: ZERO_UID, submissionsUsed: 1 } };
    assert.equal((await confirmOrder(context, current(), { ...options, check: true })).state, "submitted", "no finalized anchor at all");
    gateway.check = { confirmedCurrent: { state: "Pending", currentUid: ZERO_UID, submissionsUsed: 1 }, finalizedBlock: block(42) };
    assert.equal((await confirmOrder(context, current(), { ...options, check: true })).state, "observed");
  });
});

test("an EOA signer may ask for direct mode; a contract signer cannot be sponsored; capacity is checked before the gateway is asked", async () => {
  await withStore(async (record) => {
    const eoa = fixture("eoa");
    const prepared = await confirmOrder(eoa.context, record, { ...options, confirmation: "Confirmed", submission: "direct" }, factsReader());
    assert.equal(prepared.mode, "direct");
    assert.equal(eoa.calls[0]!.request.submission, "direct");
    // The prepared direct call blocks every new preparation until it is resolved; clear it for the mode checks below.
    assert.equal((await confirmOrder(eoa.context, current(), { ...options, abandon: true })).state, "abandoned");
    const contract = fixture("contract");
    await assert.rejects(confirmOrder(contract.context, current(), { ...options, confirmation: "Confirmed", submission: "sponsored" }, factsReader()),
      code("DASKI_CONFIRMATION_SPONSORED_REQUIRES_EOA"));
    await assert.rejects(confirmOrder(fixture("eoa").context, upsertOrder({ ...record, intentId: "other", handle: "other" }),
      { ...options, handle: "other", confirmation: "Confirmed" }, factsReader({ ...facts, submissionsUsed: 3, currentUid: UID })),
      (error: unknown) => code("DASKI_CONFIRMATION_CAP_REACHED")(error) && /revoke-confirmation/.test((error as CliError).remediation));
    await assert.rejects(confirmOrder(fixture("eoa").context, findByIntent("other")!, { ...options, handle: "other", revoke: true }, factsReader()),
      code("DASKI_CONFIRMATION_NOT_ACTIVE"));
    assert.equal(contract.calls.length, 0, "no preparation was requested for a refused mode or an exhausted order");
  });
});

test("the final attestation is withheld until acknowledged, then carries the exact warning", async () => {
  await withStore(async (record) => {
    const { context, gateway } = fixture("contract");
    const final = { ...facts, submissionsUsed: 2, currentUid: UID };
    gateway.prepared = { submissionsUsed: 2, revocationAvailable: true, finalAttestation: true };
    const warned = await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader(final));
    assert.deepEqual(warned.warning, { code: "FINAL_ATTESTATION", message: FINAL_ATTESTATION_WARNING });
    assert.equal(current().confirmationTx, undefined, "nothing is tracked until a call exists");
    gateway.prepared = { submissionsUsed: 2, revocationAvailable: true, finalAttestation: true, call: attestCall(final) };
    await assert.rejects(confirmOrder(context, current(), { ...options, confirmation: "Confirmed" }, factsReader(final)),
      code("DASKI_CONFIRMATION_MISMATCH"), "a final call without acknowledgment is refused locally too");
    const accepted = await confirmOrder(context, current(), { ...options, confirmation: "Confirmed", acknowledgeFinalTransition: true }, factsReader(final));
    assert.equal(accepted.finalAttestation, true);
    assert.deepEqual(accepted.warning, { code: "FINAL_ATTESTATION", message: FINAL_ATTESTATION_WARNING });
    assert.equal(current().confirmationTx?.state, "prepared");
  });
});

test("chain facts refuse a gateway whose EAS pin differs from the profile's before any preparation is requested", async () => {
  await withStore(async (record) => {
    const { context, calls, chain, gateway } = fixture("contract");
    chain.record = { orderKey: facts.orderKey, providerAgentId: 1n, payer: payer.address, providerOwner: REPUTATION,
      providerAgentWallet: RECIPIENT, confirmationSubmissions: 1, outcomeRecorded: true,
      reputationEligible: true, currentConfirmationUid: UID };
    const read = await readConfirmationFacts(context, record, async () => EAS_REVIEW_PROFILES[84532]!);
    assert.deepEqual(read, { ...facts, currentUid: UID, submissionsUsed: 1 });
    chain.record = { ...chain.record, providerAgentWallet: "0x0000000000000000000000000000000000000000" };
    await assert.rejects(readConfirmationFacts(context, record, async () => EAS_REVIEW_PROFILES[84532]!), code("DASKI_CONFIRMATION_MISMATCH"), "a zero provider wallet is not a record this CLI attests to");
    chain.record = { ...chain.record, providerAgentWallet: RECIPIENT };
    gateway.eas = REPUTATION;
    await assert.rejects(readConfirmationFacts(context, record), code("DASKI_EAS_ADDRESS_MISMATCH"));
    await assert.rejects(confirmOrder(context, record, { ...options, confirmation: "Confirmed" }), code("DASKI_EAS_ADDRESS_MISMATCH"));
    assert.equal(calls.length, 0);
  });
});

test("chain facts read the order record and EAS nonce in one batched read when the reader batches", async () => {
  await withStore(async (record) => {
    const { context, chain } = fixture("contract");
    chain.record = { orderKey: facts.orderKey, providerAgentId: 1n, payer: payer.address, providerOwner: REPUTATION,
      providerAgentWallet: RECIPIENT, confirmationSubmissions: 1, outcomeRecorded: true,
      reputationEligible: true, currentConfirmationUid: UID };
    const single = context.chain.readContract;
    const batches: string[][] = [];
    context.chain = { ...context.chain,
      readContract: async () => { throw new Error("an unbatched read"); },
      readContracts: async ({ reads, blockNumber }) => {
        batches.push(reads.map((read) => `${read.functionName}${blockNumber === undefined ? "" : `@${blockNumber}`}`));
        return Promise.all(reads.map((read) => single(read)));
      } };
    const read = await readConfirmationFacts(context, record, async () => EAS_REVIEW_PROFILES[84532]!);
    assert.deepEqual(read, { ...facts, currentUid: UID, submissionsUsed: 1 });
    assert.deepEqual(batches, [["getRecord", "getNonce"]], "both at the latest state, in one call");
  });
});

test("a wrong successful hash can be corrected or abandoned only once it is finalized and provably not this call", async () => {
  await withStore(async (record) => {
    const { context, chain } = fixture("contract");
    const prepared = await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader());
    await confirmOrder(context, current(), { ...options, tx: TX });
    // The recorded transaction succeeded but another contract emitted its logs; not finalized yet, so
    // nothing about it is settled: no unrelated verdict, no replacement, no abandonment.
    chain.receipt = receipt({ emitter: REPUTATION });
    chain.finalized = 41n;
    const unsettled = await confirmOrder(context, current(), { ...options, check: true });
    assert.equal(unsettled.state, "submitted");
    assert.match(String(unsettled.verification), /not final on the profile's RPC yet/);
    const other = `0x${"bb".repeat(32)}` as Hex;
    await assert.rejects(confirmOrder(context, current(), { ...options, tx: other }), code("DASKI_CONFIRMATION_TX_UNFINALIZED"), "replacement waits for finality");
    await assert.rejects(confirmOrder(context, current(), { ...options, abandon: true }), code("DASKI_CONFIRMATION_TX_UNFINALIZED"), "abandon waits for finality");
    await assert.rejects(confirmOrder(context, current(), { ...options, confirmation: "Confirmed" }, factsReader()), code("DASKI_CONFIRMATION_TX_PENDING"));
    assert.equal(current().confirmationTx?.txHash, TX);
    // Finalized: the unrelated verdict is reported, and a related receipt is never replaced or abandoned.
    chain.finalized = 42n;
    await assert.rejects(confirmOrder(context, current(), { ...options, check: true }), code("DASKI_CONFIRMATION_RECEIPT_UNRELATED"));
    chain.receipt = receipt();
    chain.attestation = attestation();
    await assert.rejects(confirmOrder(context, current(), { ...options, tx: other }), code("DASKI_CONFIRMATION_TX_ALREADY_RECORDED"));
    await assert.rejects(confirmOrder(context, current(), { ...options, abandon: true }), code("DASKI_CONFIRMATION_TX_MAY_EXECUTE"));
    // Finalized and unrelated: the journal can be corrected; the reviewed call is preserved.
    chain.receipt = receipt({ emitter: REPUTATION });
    const replaced = await confirmOrder(context, current(), { ...options, tx: other });
    assert.equal(replaced.state, "submitted");
    assert.deepEqual((replaced.corrected as { previousTxHash: Hex }).previousTxHash, TX);
    assert.match(String(replaced.note), /cancels nothing at the wallet/);
    assert.equal(current().confirmationTx?.txHash, other);
    assert.equal(current().confirmationTx?.callHash, prepared.callHash, "the prepared call and its binding survive the correction");
    assert.deepEqual(current().confirmationTx?.expected, { schema: facts.schemaUid, recipient: RECIPIENT, refUID: ZERO_UID,
      dataHash: keccak256(confirmationData(facts.orderKey, "Confirmed")) });
  });
  await withStore(async (record) => {
    // Abandon of a finalized unrelated receipt clears tracking and says so.
    const { context, chain } = fixture("contract");
    await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader());
    await confirmOrder(context, current(), { ...options, tx: TX });
    chain.receipt = receipt({ emitter: REPUTATION });
    chain.finalized = 42n;
    const abandoned = await confirmOrder(context, current(), { ...options, abandon: true });
    assert.equal(abandoned.state, "abandoned");
    assert.match(String(abandoned.unrelatedReceipt), /no log was emitted by the pinned EAS/);
    assert.match(String(abandoned.note), /record that hash instead/);
    assert.equal(current().confirmationTx?.state, "abandoned");
  });
});

test("two concurrent direct preparations for one order yield exactly one tracked call", async () => {
  await withStore(async (record) => {
    const { context } = fixture("contract");
    const original = context.client.callTool;
    context.client.callTool = async (name: string, args: Record<string, unknown>) => {
      const request = (args.request ?? {}) as Record<string, unknown>;
      if (args.authorization && request.phase === "prepare") {
        return { content: [], structuredContent: { submissionsUsed: 0, finalAttestation: false, call: attestCall(facts, request.confirmation as "Confirmed" | "NotConfirmed") } };
      }
      return original(name, args);
    };
    const results = await Promise.allSettled([
      confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader()),
      confirmOrder(context, record, { ...options, confirmation: "NotConfirmed" }, factsReader()),
    ]);
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<Record<string, unknown>> => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(fulfilled.length, 1, "the second preparation is refused, not silently overwritten");
    assert.equal(rejected.length, 1);
    assert.ok(code("DASKI_CONFIRMATION_TX_PENDING")(rejected[0]!.reason));
    assert.equal(current().confirmationTx?.callHash, fulfilled[0]!.value.callHash, "the tracked record is the call that was returned");
    assert.equal(current().confirmationTx?.state, "prepared");
  });
});

test("direct mode derives the final attestation and the count from chain facts, not from the gateway", async () => {
  await withStore(async (record) => {
    const { context, gateway } = fixture("contract");
    const last = { ...facts, submissionsUsed: 2, currentUid: UID };
    // Two submissions used on chain: this call is final. A gateway that says otherwise is refused.
    gateway.prepared = { submissionsUsed: 2, finalAttestation: false, call: attestCall(last) };
    await assert.rejects(confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader(last)), code("DASKI_CONFIRMATION_MISMATCH"));
    await assert.rejects(confirmOrder(context, record, { ...options, confirmation: "Confirmed", acknowledgeFinalTransition: true }, factsReader(last)),
      code("DASKI_CONFIRMATION_MISMATCH"));
    assert.equal(current().confirmationTx, undefined, "nothing is tracked");
    // A gateway count that disagrees with the chain is refused too.
    gateway.prepared = { submissionsUsed: 1, finalAttestation: false, call: attestCall() };
    await assert.rejects(confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader()), code("DASKI_CONFIRMATION_MISMATCH"));
    // The truthful final preparation carries the warning and needs the acknowledgement.
    gateway.prepared = { submissionsUsed: 2, finalAttestation: true, call: attestCall(last) };
    await assert.rejects(confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader(last)), code("DASKI_CONFIRMATION_MISMATCH"));
    const accepted = await confirmOrder(context, record, { ...options, confirmation: "Confirmed", acknowledgeFinalTransition: true }, factsReader(last));
    assert.equal(accepted.finalAttestation, true);
    assert.deepEqual(accepted.warning, { code: "FINAL_ATTESTATION", message: FINAL_ATTESTATION_WARNING });
  });
});

test("a signed review survives all admission refusals; only evidenced safe retirement archives it", async () => {
  await withStore(async (record) => {
    const { context, gateway } = fixture("eoa");
    gateway.prepared = sponsoredAttestPreparation();
    const original = context.client.callTool;
    let refusal: Record<string, unknown> = { code: "CONFIRMATION_SPONSORSHIP_UNAVAILABLE" };
    context.client.callTool = async (name: string, args: Record<string, unknown>) => {
      if (args.authorization && (args.request as Record<string, unknown> | undefined)?.phase === "submit") {
        return { content: [], isError: true, structuredContent: refusal };
      }
      return original(name, args);
    };
    // Ambiguous: the chain read failed; the signed request may be admitted later, so it is kept for --resume.
    await assert.rejects(confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader()), code("CONFIRMATION_SPONSORSHIP_UNAVAILABLE"));
    assert.ok(current().confirmationSubmission, "kept for --resume");
    await assert.rejects(confirmOrder(context, current(), { ...options, confirmation: "Confirmed", submission: "direct" }, factsReader()), code("DASKI_CONFIRMATION_PENDING"));
    // A signature may remain reusable even when admission was refused.
    refusal = { code: "CONFIRMATION_SPONSORSHIP_LIMIT", chainEligible: true };
    await assert.rejects(confirmOrder(context, current(), { ...options, resume: true }, factsReader()), code("CONFIRMATION_SPONSORSHIP_LIMIT"));
    assert.ok(current().confirmationSubmission, "signed bytes survive definite admission refusal");
    refusal = { code: "CONFIRMATION_SUBMISSION_FAILED", expected: { operationId: "retired-op", safeRetired: true, disposition: "deadline-expired" } };
    await assert.rejects(confirmOrder(context, current(), { ...options, resume: true }, factsReader()), code("CONFIRMATION_SUBMISSION_FAILED"));
    assert.equal(current().confirmationSubmission, undefined);
    assert.equal(current().confirmationHistory?.[0]?.submission.operationId, "retired-op");
    await assert.rejects(confirmOrder(context, current(), { ...options, resume: true }, factsReader()), code("DASKI_CONFIRMATION_NOT_PENDING"));
    gateway.prepared = { submissionsUsed: 0, revocationAvailable: false, finalAttestation: false, call: attestCall() };
    const direct = await confirmOrder(context, current(), { ...options, confirmation: "Confirmed", submission: "direct" }, factsReader());
    assert.equal(direct.mode, "direct");
    assert.equal(current().confirmationTx?.state, "prepared");
  });
});

test("a stale answer on --resume is ambiguous: the journal is kept, its remediation says to keep resuming, and a new preparation is refused", async () => {
  await withStore(async (record) => {
    // The reproduction: the sponsored submission was accepted as pending, the
    // gateway's 300 s preparation TTL passed, and a resumed submit is answered
    // CONFIRMATION_PREPARATION_STALE although the operation may already run.
    const { context, gateway } = fixture("eoa");
    gateway.prepared = sponsoredAttestPreparation();
    let answer: Record<string, unknown> = { code: "CONFIRMATION_SUBMISSION_PENDING" };
    let isError = true;
    const original = context.client.callTool;
    context.client.callTool = async (name: string, args: Record<string, unknown>) => {
      if (args.authorization && (args.request as Record<string, unknown> | undefined)?.phase === "submit") {
        return { content: [], isError, structuredContent: answer };
      }
      return original(name, args);
    };
    const pending = await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader());
    assert.equal(pending.state, "pending");
    assert.equal(current().confirmationSubmission?.request.preparationId, "prep");

    answer = { code: "CONFIRMATION_PREPARATION_STALE", message: "The preparation has expired." };
    await assert.rejects(confirmOrder(context, current(), { ...options, resume: true }, factsReader()),
      (error: unknown) => code("CONFIRMATION_PREPARATION_STALE")(error) &&
        /--resume/.test((error as CliError).remediation) && /--check/.test((error as CliError).remediation) &&
        /new preparation is refused/.test((error as CliError).remediation));
    assert.equal(current().confirmationSubmission?.request.preparationId, "prep", "kept: the gateway may already have admitted it");
    await assert.rejects(confirmOrder(context, current(), { ...options, confirmation: "Confirmed", submission: "direct" }, factsReader()),
      code("DASKI_CONFIRMATION_PENDING"), "a new direct preparation is refused while the journal is pending");
    await assert.rejects(confirmOrder(context, current(), { ...options, confirmation: "Confirmed" }, factsReader()),
      code("DASKI_CONFIRMATION_PENDING"), "so is a new sponsored one");
    // Once the gateway reports the operation, the same resumed submission closes the journal.
    answer = { operationId: "op", state: "final" };
    isError = false;
    const closed = await confirmOrder(context, current(), { ...options, resume: true }, factsReader());
    assert.equal(closed.state, "final");
    assert.equal(current().confirmationSubmission, undefined);
  });
});

test("a gateway without confirmation pins is refused with its own code before any chain read or preparation", async () => {
  await withStore(async (record) => {
    const { context, calls, chain } = fixture("contract");
    chain.record = { orderKey: facts.orderKey, providerAgentId: 1n, payer: payer.address, providerOwner: REPUTATION,
      providerAgentWallet: RECIPIENT, confirmationSubmissions: 0, outcomeRecorded: true, reputationEligible: true, currentConfirmationUid: ZERO_UID };
    context.metadata = async () => parseGatewayMetadata({ payerAccounts: { types: ["eoa", "contract"], counterfactual: false } });
    chain.log.length = 0;
    await assert.rejects(readConfirmationFacts(context, record),
      (error: unknown) => code("DASKI_GATEWAY_CONFIRMATION_PINS_MISSING")(error) && /confirmationSigning/.test((error as CliError).message));
    await assert.rejects(confirmOrder(context, record, { ...options, confirmation: "Confirmed" }), code("DASKI_GATEWAY_CONFIRMATION_PINS_MISSING"));
    assert.deepEqual(chain.log, [], "no chain fact is read without the pins");
    assert.equal(calls.length, 0, "nothing is prepared at the gateway");
  });
});

test("a batched receipt with another order's event first is still bound to the prepared call through the event that matches", async () => {
  await withStore(async (record) => {
    const { context, chain, gateway } = fixture("contract");
    await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader());
    await confirmOrder(context, current(), { ...options, tx: TX });
    const OTHER_UID = canonicalHash("another order's attestation");
    const batched = receipt();
    chain.receipt = { ...batched, logs: [...receipt({ uid: OTHER_UID }).logs, ...batched.logs] };
    chain.attestations.set(OTHER_UID, attestation({ uid: OTHER_UID, data: confirmationData(canonicalHash("another order"), "Confirmed") }));
    chain.attestations.set(UID, attestation());
    chain.finalized = 42n;
    // Related through the second event: neither replacement nor abandonment is a correction.
    await assert.rejects(confirmOrder(context, current(), { ...options, abandon: true }), code("DASKI_CONFIRMATION_TX_MAY_EXECUTE"));
    await assert.rejects(confirmOrder(context, current(), { ...options, tx: `0x${"bb".repeat(32)}` }), code("DASKI_CONFIRMATION_TX_ALREADY_RECORDED"));
    gateway.check = { confirmedCurrent: { state: "Confirmed", currentUid: UID, submissionsUsed: 1 }, finalizedBlock: block(42) };
    const observed = await confirmOrder(context, current(), { ...options, check: true });
    assert.equal(observed.state, "observed");
    assert.equal(observed.uid, UID, "the binding event, not the first one");
    // A batch in which no candidate binds is unrelated, naming every candidate's mismatch.
    const again = await confirmOrder(context, current(), { ...options, confirmation: "Confirmed" }, factsReader({ ...facts, currentUid: UID, submissionsUsed: 1 }))
      .catch(() => undefined);
    void again;
  });
  await withStore(async (record) => {
    const { context, chain } = fixture("contract");
    await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader());
    await confirmOrder(context, current(), { ...options, tx: TX });
    const A = canonicalHash("a"); const B = canonicalHash("b");
    const base = receipt();
    chain.receipt = { ...base, logs: [...receipt({ uid: A }).logs, ...receipt({ uid: B }).logs] };
    chain.attestations.set(A, attestation({ uid: A, refUID: canonicalHash("x") }));
    chain.attestations.set(B, attestation({ uid: B, data: confirmationData(canonicalHash("other"), "Confirmed") }));
    await assert.rejects(confirmOrder(context, current(), { ...options, check: true }),
      (error: unknown) => code("DASKI_CONFIRMATION_RECEIPT_UNRELATED")(error) && /none of the 2 candidate events/.test((error as CliError).message));
    chain.finalized = 42n;
    assert.equal((await confirmOrder(context, current(), { ...options, abandon: true })).state, "abandoned");
  });
});

test("evidence is bound to the canonical chain: a replaced receipt block or a non-canonical finalized anchor never marks the record observed", async () => {
  await withStore(async (record) => {
    const active = { ...facts, currentUid: UID, submissionsUsed: 1 };
    const { context, chain, gateway } = fixture("contract");
    gateway.prepared = { submissionsUsed: 1, revocationAvailable: true, finalAttestation: false, call: revokeCall(active) };
    await confirmOrder(context, record, { ...options, revoke: true }, factsReader(active));
    await confirmOrder(context, current(), { ...options, tx: TX });
    const fork = canonicalHash("fork block 42");
    // The receipt and the attestation came from a fork the RPC still follows; the gateway's finalized block at the same height differs.
    chain.receipt = receipt({ event: "Revoked", blockHash: fork });
    chain.canonical.set(42n, fork);
    chain.attestation = attestation({ revocationTime: 43n });
    gateway.check = { confirmedCurrent: { state: "Pending", currentUid: ZERO_UID, submissionsUsed: 0 }, finalizedBlock: block(42, canonicalHash("canonical block 42")) };
    const forked = await confirmOrder(context, current(), { ...options, check: true });
    assert.equal(forked.state, "submitted");
    assert.match(String(forked.verification), /not the chain's canonical block at that height/);
    // The RPC has moved to the canonical chain: the receipt's block is no longer canonical.
    chain.canonical.set(42n, canonicalHash("canonical block 42"));
    const replaced = await confirmOrder(context, current(), { ...options, check: true });
    assert.equal(replaced.state, "submitted");
    assert.equal(replaced.receipt, "reorganized");
    await assert.rejects(confirmOrder(context, current(), { ...options, abandon: true }),
      (error: unknown) => code("DASKI_CONFIRMATION_TX_UNFINALIZED")(error) && /not the chain's canonical block/.test((error as CliError).message),
      "a receipt whose block is not canonical settles nothing and is never abandoned");
    // Re-included on the canonical chain: observed.
    chain.receipt = receipt({ event: "Revoked", blockHash: canonicalHash("canonical block 42") });
    const observed = await confirmOrder(context, current(), { ...options, check: true });
    assert.equal(observed.state, "observed");
    assert.equal(observed.finalizedBlock, "42");
  });
  await withStore(async (record) => {
    // An unrelated receipt whose block is not canonical cannot be used as a correction either.
    const { context, chain } = fixture("contract");
    await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader());
    await confirmOrder(context, current(), { ...options, tx: TX });
    chain.receipt = receipt({ emitter: REPUTATION, blockHash: canonicalHash("orphaned") });
    chain.finalized = 42n;
    await assert.rejects(confirmOrder(context, current(), { ...options, abandon: true }),
      (error: unknown) => code("DASKI_CONFIRMATION_TX_UNFINALIZED")(error) && /not the chain's canonical block/.test((error as CliError).message));
    await assert.rejects(confirmOrder(context, current(), { ...options, tx: `0x${"bb".repeat(32)}` }), code("DASKI_CONFIRMATION_TX_UNFINALIZED"));
    assert.equal(current().confirmationTx?.txHash, TX);
  });
});

test("the signer is resolved before the order lock, so a prompt never holds it", async () => {
  await withStore(async (record) => {
    const { context } = fixture("contract");
    const home = process.env.DASKI_HOME!;
    const original = context.resolveSigner;
    let lockSeenDuringResolve: boolean | undefined;
    context.resolveSigner = async () => {
      const { existsSync } = await import("node:fs");
      lockSeenDuringResolve = existsSync(join(home, "orders.json.intent.lock"));
      return original();
    };
    await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader());
    assert.equal(lockSeenDuringResolve, false);
  });
});

test("the finalized view is established before any canonical read, so a reorganization between reads never yields an observed record", async () => {
  await withStore(async (record) => {
    // The rerun's scenario: the receipt and its attestation were read from fork A; the chain reorganizes to B
    // before the gateway answers from its finalized view of B, both reads truthful at their time.
    const active = { ...facts, currentUid: UID, submissionsUsed: 1 };
    const { context, chain, gateway, calls } = fixture("contract");
    gateway.prepared = { submissionsUsed: 1, revocationAvailable: true, finalAttestation: false, call: revokeCall(active) };
    await confirmOrder(context, record, { ...options, revoke: true }, factsReader(active));
    await confirmOrder(context, current(), { ...options, tx: TX });
    const FORK_A = canonicalHash("receipt fork A block 42");
    const FORK_B = canonicalHash("finalized fork B block 42");
    chain.receipt = receipt({ event: "Revoked", blockHash: FORK_A });
    chain.attestation = attestation({ revocationTime: 43n });
    chain.canonical.set(42n, FORK_A);
    chain.finalized = 41n;
    const original = context.client.callTool;
    context.client.callTool = async (name: string, args: Record<string, unknown>) => {
      if (args.authorization && (args.request as Record<string, unknown> | undefined)?.phase === "check") {
        chain.canonical.set(42n, FORK_B);
        chain.finalized = 42n;
        chain.attestation = attestation({ uid: ZERO_UID, revocationTime: 0n });
      }
      return original(name, args);
    };
    gateway.check = { confirmedCurrent: { state: "Pending", currentUid: ZERO_UID, submissionsUsed: 0 }, finalizedBlock: block(42, FORK_B) };
    // Block 42 is not finalized on the RPC yet: no canonical read is trusted and the gateway is not asked.
    const early = await confirmOrder(context, current(), { ...options, check: true });
    assert.equal(early.state, "submitted");
    assert.match(String(early.verification), /not final on the profile's RPC yet/);
    assert.equal(calls.filter((call) => call.request.phase === "check").length, 0);
    assert.ok(!chain.log.some((entry) => entry.startsWith("blockHash")), "no canonical read before the RPC reports the height final");
    // Once final on the RPC, the canonical block at 42 is B and the receipt belonged to A.
    chain.canonical.set(42n, FORK_B);
    chain.finalized = 42n;
    const later = await confirmOrder(context, current(), { ...options, check: true });
    assert.equal(later.receipt, "reorganized");
    assert.equal(current().confirmationTx?.state, "submitted");
  });
  await withStore(async (record) => {
    // An RPC that contradicts its own finalized view between two reads is caught by the second comparison.
    const active = { ...facts, currentUid: UID, submissionsUsed: 1 };
    const { context, chain, gateway } = fixture("contract");
    gateway.prepared = { submissionsUsed: 1, revocationAvailable: true, finalAttestation: false, call: revokeCall(active) };
    await confirmOrder(context, record, { ...options, revoke: true }, factsReader(active));
    await confirmOrder(context, current(), { ...options, tx: TX });
    const FORK_A = canonicalHash("A"); const FORK_B = canonicalHash("B");
    chain.receipt = receipt({ event: "Revoked", blockHash: FORK_A });
    chain.attestation = attestation({ revocationTime: 43n });
    chain.canonical.set(42n, FORK_A);
    const original = context.client.callTool;
    context.client.callTool = async (name: string, args: Record<string, unknown>) => {
      if (args.authorization && (args.request as Record<string, unknown> | undefined)?.phase === "check") chain.canonical.set(42n, FORK_B);
      return original(name, args);
    };
    gateway.check = { confirmedCurrent: { state: "Pending", currentUid: ZERO_UID, submissionsUsed: 0 }, finalizedBlock: block(42, FORK_B) };
    const result = await confirmOrder(context, current(), { ...options, check: true });
    assert.equal(result.receipt, "reorganized");
    assert.equal(current().confirmationTx?.state, "submitted");
  });
});

test("attestations are read pinned to the RPC's finalized height, after the finalized view is established", async () => {
  await withStore(async (record) => {
    const { context, chain, gateway } = fixture("contract");
    await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader());
    await confirmOrder(context, current(), { ...options, tx: TX });
    chain.receipt = receipt();
    chain.finalized = 77n;
    gateway.check = { confirmedCurrent: { state: "Confirmed", currentUid: UID, submissionsUsed: 1 }, finalizedBlock: block(80) };
    chain.log.length = 0;
    const observed = await confirmOrder(context, current(), { ...options, check: true });
    assert.equal(observed.state, "observed");
    assert.deepEqual(chain.log, ["receipt", "final", "blockHash:42", "getAttestation@77", "blockHash:80", "blockHash:42"]);
  });
  await withStore(async (record) => {
    // The correction predicate follows the same order: finality, canonical block, then the pinned binding.
    const { context, chain } = fixture("contract");
    await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader());
    await confirmOrder(context, current(), { ...options, tx: TX });
    chain.receipt = receipt({ emitter: REPUTATION });
    chain.finalized = 50n;
    chain.log.length = 0;
    const abandoned = await confirmOrder(context, current(), { ...options, abandon: true });
    assert.equal(abandoned.state, "abandoned");
    assert.deepEqual(chain.log, ["receipt", "final", "blockHash:42"]);
  });
  await withStore(async (record) => {
    // An unrelated receipt on a fork the RPC still followed when the block was not yet final is refused, not cleared.
    const { context, chain } = fixture("contract");
    await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader());
    await confirmOrder(context, current(), { ...options, tx: TX });
    const FORK_A = canonicalHash("A"); const FORK_B = canonicalHash("B");
    chain.receipt = { ...receipt(), logs: [], blockHash: FORK_A };
    chain.canonical.set(42n, FORK_A);
    chain.finalized = 41n;
    await assert.rejects(confirmOrder(context, current(), { ...options, abandon: true }),
      (error: unknown) => code("DASKI_CONFIRMATION_TX_UNFINALIZED")(error) && /not final yet/.test((error as CliError).message));
    chain.canonical.set(42n, FORK_B);
    chain.finalized = 42n;
    await assert.rejects(confirmOrder(context, current(), { ...options, abandon: true }),
      (error: unknown) => code("DASKI_CONFIRMATION_TX_UNFINALIZED")(error) && /not the chain's canonical block/.test((error as CliError).message));
    assert.equal(current().confirmationTx?.state, "submitted");
  });
});

test("a reverted transaction is abandoned only once its block is finalized and canonical", async () => {
  await withStore(async (record) => {
    const { context, chain } = fixture("contract");
    await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader());
    await confirmOrder(context, current(), { ...options, tx: TX });
    chain.receipt = receipt({ status: "reverted" });
    chain.finalized = 41n;
    const early = await confirmOrder(context, current(), { ...options, check: true });
    assert.equal(early.receipt, "reverted");
    assert.equal(early.revertFinal, false);
    await assert.rejects(confirmOrder(context, current(), { ...options, abandon: true }),
      (error: unknown) => code("DASKI_CONFIRMATION_TX_MAY_EXECUTE")(error) && /not final yet/.test((error as CliError).message));
    assert.equal(current().confirmationTx?.state, "submitted");
    // Finalized, but on a block the RPC no longer holds canonical: still refused.
    chain.finalized = 42n;
    chain.canonical.set(42n, canonicalHash("other block 42"));
    await assert.rejects(confirmOrder(context, current(), { ...options, abandon: true }),
      (error: unknown) => code("DASKI_CONFIRMATION_TX_MAY_EXECUTE")(error) && /not the chain's canonical block/.test((error as CliError).message));
    // Finalized and canonical: the revert is settled and the record can be cleared.
    chain.canonical.delete(42n);
    const settled = await confirmOrder(context, current(), { ...options, check: true });
    assert.equal(settled.revertFinal, true);
    assert.equal((await confirmOrder(context, current(), { ...options, abandon: true })).state, "abandoned");
  });
});

test("a finalized direct attestation closes even after the wallet revoked or replaced it; the review's current effect is reported separately", async () => {
  await withStore(async (record) => {
    const { context, chain, gateway } = fixture("contract");
    await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader());
    await confirmOrder(context, current(), { ...options, tx: TX });
    chain.receipt = receipt();
    // The wallet revoked the attestation before the CLI checked: the finalized read no longer shows it as current.
    gateway.check = { confirmedCurrent: { state: "Pending", currentUid: ZERO_UID, submissionsUsed: 1 }, finalizedBlock: block(60) };
    const observed = await confirmOrder(context, current(), { ...options, check: true });
    assert.equal(observed.state, "observed");
    assert.equal(observed.review, "superseded");
    assert.match(String(observed.note), /revoked or replaced/);
    assert.equal(current().confirmationTx?.state, "observed");
    // The journal is closed: a new preparation is possible.
    gateway.prepared = { submissionsUsed: 1, revocationAvailable: false, finalAttestation: false, call: attestCall({ ...facts, submissionsUsed: 1 }) };
    const again = await confirmOrder(context, current(), { ...options, confirmation: "NotConfirmed" }, factsReader({ ...facts, submissionsUsed: 1 }))
      .catch((error: unknown) => error);
    assert.ok(!(again instanceof CliError && again.code === "DASKI_CONFIRMATION_TX_PENDING"), "the closed journal no longer blocks");
  });
});

test("a pending direct submission blocks a sponsored preparation as well", async () => {
  await withStore(async (record) => {
    const { context, calls } = fixture("eoa");
    const prepared = await confirmOrder(context, record, { ...options, confirmation: "Confirmed", submission: "direct" }, factsReader());
    assert.equal(prepared.mode, "direct");
    await confirmOrder(context, current(), { ...options, tx: TX });
    const before = calls.length;
    await assert.rejects(confirmOrder(context, current(), { ...options, confirmation: "NotConfirmed" }, factsReader()), code("DASKI_CONFIRMATION_TX_PENDING"),
      "the default sponsored mode may not sign a second review while the direct one is unresolved");
    assert.equal(calls.length, before, "nothing was prepared at the gateway");
  });
});

test("--check without a direct record reports the gateway's finalized state for a sponsored review", async () => {
  await withStore(async (record) => {
    const { context, calls, gateway } = fixture("eoa");
    gateway.check = { lastObserved: { state: "Confirmed", currentUid: UID, submissionsUsed: 1 }, confirmedCurrent: { state: "Confirmed", currentUid: UID, submissionsUsed: 1 },
      submissionsUsed: 1, observedBlock: block(120), finalizedBlock: block(100) };
    const checked = await confirmOrder(context, record, { ...options, check: true });
    assert.equal(checked.mode, "sponsored");
    assert.equal(checked.state, "checked");
    assert.deepEqual(checked.confirmedCurrent, { state: "Confirmed", currentUid: UID, submissionsUsed: 1 });
    assert.equal(checked.finalizedBlock, "100");
    assert.deepEqual(calls.at(-1)!.request, { phase: "check", submission: "sponsored" });
  });
});

const LATER_UID = `0x${"77".repeat(32)}` as Hex;

/** Drive a direct review to `observed` through the fixture: prepare, record the hash, verify. */
async function observeDirect(fx: Fixture, record: OrderRecord, submission?: string): Promise<void> {
  await confirmOrder(fx.context, record, { ...options, confirmation: "Confirmed", ...(submission ? { submission } : {}) }, factsReader());
  await confirmOrder(fx.context, current(), { ...options, tx: TX });
  fx.chain.receipt = receipt();
  fx.gateway.check = { confirmedCurrent: { state: "Confirmed", currentUid: UID, submissionsUsed: 1 }, finalizedBlock: block(60) };
  const observed = await confirmOrder(fx.context, current(), { ...options, check: true });
  assert.equal(observed.state, "observed");
}

test("once a direct record is observed, --check asks the gateway for the current state and keeps the record as history", async () => {
  await withStore(async (record) => {
    const fx = fixture("contract");
    await observeDirect(fx, record);
    // A later review replaced the observed one; the gateway knows, the journal does not.
    fx.gateway.check = { lastObserved: { state: "NotConfirmed", currentUid: LATER_UID, submissionsUsed: 2 },
      confirmedCurrent: { state: "NotConfirmed", currentUid: LATER_UID, submissionsUsed: 2 }, submissionsUsed: 2,
      observedBlock: block(130), finalizedBlock: block(120) };
    const before = fx.calls.length;
    const checked = await confirmOrder(fx.context, current(), { ...options, check: true });
    assert.equal(checked.state, "checked");
    assert.equal(checked.mode, "direct", "a contract signer asks in its own mode");
    assert.deepEqual(fx.calls.at(-1)!.request, { phase: "check", submission: "direct" });
    assert.ok(fx.calls.length > before, "the gateway was asked");
    assert.deepEqual(checked.confirmedCurrent, { state: "NotConfirmed", currentUid: LATER_UID, submissionsUsed: 2 });
    assert.deepEqual(checked.directRecord, { action: "attest", state: "observed", callHash: current().confirmationTx!.callHash, txHash: TX, uid: UID });
    assert.match(String(checked.note), /kept as history/);
    assert.equal(current().confirmationTx?.state, "observed", "the journal is untouched");
  });
});

test("--check honors an explicit --submission: sponsored asks the gateway, direct re-verifies the record, and direct without a record is refused", async () => {
  await withStore(async (record) => {
    const fx = fixture("eoa");
    await observeDirect(fx, record, "direct");
    fx.gateway.check = { confirmedCurrent: { state: "Confirmed", currentUid: LATER_UID, submissionsUsed: 2 }, submissionsUsed: 2, finalizedBlock: block(120) };
    const sponsored = await confirmOrder(fx.context, current(), { ...options, check: true, submission: "sponsored" });
    assert.equal(sponsored.mode, "sponsored");
    assert.equal(sponsored.state, "checked");
    assert.deepEqual(fx.calls.at(-1)!.request, { phase: "check", submission: "sponsored" });
    assert.deepEqual(sponsored.confirmedCurrent, { state: "Confirmed", currentUid: LATER_UID, submissionsUsed: 2 });
    const before = fx.calls.length;
    const direct = await confirmOrder(fx.context, current(), { ...options, check: true, submission: "direct" });
    assert.equal(direct.mode, "direct");
    assert.equal(direct.state, "observed");
    assert.match(String(direct.note), /Already observed/);
    assert.equal(fx.calls.length, before, "re-verifying the observed record asks the gateway nothing");
    await assert.rejects(confirmOrder(fx.context, current(), { ...options, check: true, submission: "sponsored-ish" }),
      code("DASKI_CONFIRMATION_SUBMISSION_INVALID"));
  });
  await withStore(async (record) => {
    const fx = fixture("eoa");
    await assert.rejects(confirmOrder(fx.context, record, { ...options, check: true, submission: "direct" }),
      code("DASKI_CONFIRMATION_TX_NOT_PREPARED"), "an explicit direct check needs a tracked record");
  });
});

test("--check still verifies a direct record while it is prepared or submitted, without asking the gateway first", async () => {
  await withStore(async (record) => {
    const fx = fixture("contract");
    await confirmOrder(fx.context, record, { ...options, confirmation: "Confirmed" }, factsReader());
    const before = fx.calls.length;
    const prepared = await confirmOrder(fx.context, current(), { ...options, check: true }).catch((error: unknown) => error);
    assert.ok(prepared instanceof CliError && prepared.code === "DASKI_CONFIRMATION_TX_NOT_RECORDED", "a prepared record is the check's subject");
    assert.equal(fx.calls.length, before);
  });
});

test("Circle direct submit journals before vendor execution; timeout resume never executes again", async () => {
  await withStore(async record => {
    const { context, chain, gateway } = fixture("contract");
    context.metadata = async () => parseGatewayMetadata({ confirmation: {
      modes: ["direct"], directReview: { circleEstimate: true, circleExecute: true } } });
    let executions = 0, estimates = 0, lookups = 0, capturedKey = "";
    const adapter = () => ({
      packageVersion: "1.0.0",
      estimate: async () => { estimates++; return { gasLimit: "500000" }; },
      submit: async (request: import("../src/signers/circleReviewTransport.js").CircleReviewRequest) => {
        executions++;
        assert.equal(current().confirmationTx?.vendor?.idempotencyKey, request.idempotencyKey);
        assert.equal(current().confirmationTx?.state, "submitted");
        capturedKey = request.idempotencyKey;
        throw new Error("synthetic lost response");
      },
      lookup: async (request: import("../src/signers/circleReviewTransport.js").CircleReviewRequest) => {
        lookups++;
        assert.equal(request.idempotencyKey, capturedKey);
        return { transactionId: "vendor-id", hashes: [TX] };
      },
    });
    await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader(), adapter);
    assert.equal(executions, 0);
    const callHash = current().confirmationTx!.callHash;
    await confirmOrder(context, current(), { ...options, estimate: true }, factsReader(), adapter);
    assert.equal(estimates, 1);
    assert.equal(current().confirmationTx?.vendor, undefined);
    await assert.rejects(confirmOrder(context, current(), { ...options, submit: true, approveCallHash: "wrong" }, factsReader(), adapter),
      code("DASKI_CONFIRMATION_APPROVAL_REQUIRED"));
    await assert.rejects(confirmOrder(context, current(), { ...options, submit: true, approveCallHash: callHash }, factsReader(), adapter),
      /synthetic lost response/);
    assert.ok(current().confirmationTx?.vendor?.submissionStarted);
    await assert.rejects(confirmOrder(context, current(), { ...options, abandon: true }), code("DASKI_CONFIRMATION_TX_MAY_EXECUTE"));
    await assert.rejects(confirmOrder(context, current(), { ...options, submit: true, approveCallHash: callHash }, factsReader(), adapter),
      code("DASKI_CONFIRMATION_TX_PENDING"));
    chain.receipt = { ...receipt(), logs: [] }; // ERC-4337 outer success with no successful EAS inner call.
    const pending = await confirmOrder(context, current(), { ...options, resume: true }, factsReader(), adapter);
    assert.equal(pending.state, "submitted");
    chain.receipt = receipt();
    gateway.check = { confirmedCurrent: { state: "Confirmed", currentUid: UID }, finalizedBlock: block(50) };
    const final = await confirmOrder(context, current(), { ...options, resume: true }, factsReader(), adapter);
    assert.equal(final.state, "observed");
    assert.equal(lookups, 2);
    assert.equal(executions, 1);
  });
});

test("Circle execution qualification is separate from estimate and explicit approval", async () => {
  await withStore(async record => {
    const { context } = fixture("contract");
    context.metadata = async () => parseGatewayMetadata({ confirmation: {
      modes: ["direct"], directReview: { circleEstimate: true, circleExecute: false } } });
    const adapter = () => ({
      packageVersion: "1.0.0", estimate: async () => ({}),
      submit: async () => { throw new Error("unqualified execute must not run"); },
      lookup: async () => ({ hashes: [] }),
    });
    await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader(), adapter);
    await assert.rejects(confirmOrder(context, current(), { ...options, submit: true, approveCallHash: current().confirmationTx!.callHash }, factsReader(), adapter),
      code("DASKI_CIRCLE_EXECUTION_NOT_QUALIFIED"));
    assert.equal(current().confirmationTx?.vendor, undefined);
  });
});

test("sponsored operation IDs persist and recovery cannot reinterpret a chosen review or unknown success", async () => {
  await withStore(async record => {
    const { context, gateway, calls } = fixture("eoa");
    gateway.prepared = sponsoredAttestPreparation();
    const original = context.client.callTool;
    let response: Record<string, unknown> = { code: "CONFIRMATION_SUBMISSION_PENDING", expected: { operationId: "op-review" } };
    let isError = true;
    context.client.callTool = async (name, args) => {
      const request = args.request as Record<string, unknown>;
      if (args.authorization && request.phase === "submit") return { content: [], isError, structuredContent: response };
      if (args.authorization && request.phase === "reaffirm") {
        assert.deepEqual(request, { phase: "reaffirm", submission: "sponsored", reviewProtocol: 2, operationId: "op-review" });
        return { content: [], isError: true, structuredContent: { code: "CONFIRMATION_SUBMISSION_PENDING", expected: { operationId: "op-review" } } };
      }
      return original(name, args);
    };
    await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader());
    assert.equal(current().confirmationSubmission?.operationId, "op-review");
    const signature = current().confirmationSubmission!.request.signature;
    await confirmOrder(context, current(), { ...options, reaffirm: true }, factsReader());
    assert.equal(current().confirmationSubmission!.request.signature, signature);
    await assert.rejects(confirmOrder(context, current(), { ...options, reaffirm: true, confirmation: "NotConfirmed" }, factsReader()),
      code("DASKI_CONFIRMATION_FLAGS_INVALID"));
    isError = false; response = { state: "unexpected-failed" };
    await assert.rejects(confirmOrder(context, current(), { ...options, resume: true }, factsReader()), code("DASKI_CONFIRMATION_STATUS_UNKNOWN"));
    assert.equal(current().confirmationSubmission?.operationId, "op-review");
    isError = true; response = { code: "CONFIRMATION_SUBMISSION_FAILED", expected: { operationId: "another", safeRetired: true } };
    await assert.rejects(confirmOrder(context, current(), { ...options, resume: true }, factsReader()), code("DASKI_CONFIRMATION_MISMATCH"));
    assert.ok(current().confirmationSubmission);
    response = { code: "CONFIRMATION_SUBMISSION_PENDING", expected: { operationId: "op-replacement" } };
    await confirmOrder(context, current(), { ...options, confirmation: "Confirmed", supersedesOperationId: "op-review", acknowledgeSameNonce: true }, factsReader());
    assert.equal(current().confirmationSubmission?.operationId, "op-replacement");
    assert.equal(current().confirmationHistory?.[0]?.submission.request.signature, signature);
    assert.equal(calls.filter(call => call.request.phase === "prepare").at(-1)?.request.supersedesOperationId, "op-review");
  });
});

test("signed-before-admission recovery requires an explicit preparation supersession acknowledgement", async () => {
  await withStore(async record => {
    const { context, gateway, calls } = fixture("eoa");
    gateway.prepared = sponsoredAttestPreparation();
    const original = context.client.callTool;
    context.client.callTool = async (name, args) => args.authorization && (args.request as Record<string, unknown>).phase === "submit"
      ? { content: [], isError: true, structuredContent: { code: "CONFIRMATION_SPONSORSHIP_UNAVAILABLE" } } : original(name, args);
    await assert.rejects(confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader()));
    await assert.rejects(confirmOrder(context, current(), { ...options, confirmation: "Confirmed", supersedesPreparationId: "prep" }, factsReader()));
    await assert.rejects(confirmOrder(context, current(), { ...options, confirmation: "Confirmed", supersedesPreparationId: "prep", acknowledgeSameNonce: true }, factsReader()),
      code("CONFIRMATION_SPONSORSHIP_UNAVAILABLE"));
    assert.equal(calls.filter(call => call.request.phase === "prepare").at(-1)?.request.supersedesPreparationId, "prep");
    assert.equal(current().confirmationHistory?.[0]?.outcome.disposition, "explicitly-superseded-still-live");
  });
});

test("candidate Circle execution requires explicit testnet spend consent and never bypasses mainnet", async () => {
  const saved = process.env.DASKI_CONFORMANCE_SPEND_OK;
  try {
    delete process.env.DASKI_CONFORMANCE_SPEND_OK;
    await withStore(async record => {
      const { context } = fixture("contract");
      context.metadata = async () => parseGatewayMetadata({ confirmation: {
        modes: ["direct"], directReview: { circleEstimate: true, circleExecute: false } } });
      let executions = 0;
      const adapter = () => ({ packageVersion: "1.0.0", estimate: async () => ({}),
        submit: async () => { executions++; return { transactionId: "candidate", progress: { executionRequested: true, approvalSent: true, uncertain: false } }; },
        lookup: async () => ({ hashes: [] }) });
      await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader(), adapter);
      const submit = { ...options, submit: true, approveCallHash: current().confirmationTx!.callHash, qualifyCircleExecution: true };
      await assert.rejects(confirmOrder(context, current(), submit, factsReader(), adapter), code("DASKI_CIRCLE_CONFORMANCE_REFUSED"));
      process.env.DASKI_CONFORMANCE_SPEND_OK = "1";
      await assert.rejects(confirmOrder({ ...context, profile: { ...context.profile, chainId: 8453 } }, current(), submit, factsReader(), adapter),
        code("DASKI_CIRCLE_CONFORMANCE_REFUSED"));
      await confirmOrder(context, current(), submit, factsReader(), adapter);
      assert.equal(executions, 1);
      assert.equal(current().confirmationTx!.vendor!.conformanceCandidate, true);
    });
  } finally {
    if (saved === undefined) delete process.env.DASKI_CONFORMANCE_SPEND_OK; else process.env.DASKI_CONFORMANCE_SPEND_OK = saved;
  }
});

test("an upgraded buyer explicitly replaces an expired unadmitted pre-protocol journal and preserves its original signature", async () => {
  await withStore(async record => {
    const { context, gateway, calls } = fixture("eoa");
    const historicalId = "00000000-0000-4000-8000-000000000101";
    const replacementId = "00000000-0000-4000-8000-000000000201";
    const oldTyped = structuredClone(sponsoredAttestPreparation().signableTypedData) as TypedDataRequest;
    oldTyped.message.deadline = String(Math.floor(Date.now() / 1000) - 600);
    const oldSignature = await payer.signTypedData(oldTyped as never);
    // This is the persisted shape from the old buyer: no protocol, operation,
    // profile, or typed-data fields were recorded before the submit response.
    const historical = { action: "confirmation" as const, request: { phase: "submit" as const, submission: "sponsored" as const,
      preparationId: historicalId, signature: oldSignature } };
    upsertOrder({ ...record, confirmationSubmission: historical });
    gateway.prepared = { ...sponsoredAttestPreparation(), preparationId: replacementId };
    const originalCall = context.client.callTool;
    const originalSign = context.signer.signTypedData.bind(context.signer);
    const innerSignatures: TypedDataRequest[] = [];
    context.signer.signTypedData = async data => {
      if (data.primaryType === "Attest") innerSignatures.push(data);
      return originalSign(data);
    };
    const submissions: Record<string, unknown>[] = [];
    context.client.callTool = async (name, args) => {
      const request = args.request as Record<string, unknown>;
      if (args.authorization && request.phase === "prepare") {
        assert.deepEqual({ ...request }, { phase: "prepare", submission: "sponsored", reviewProtocol: 2,
          supersedesPreparationId: historicalId, acknowledgeSameNonce: true,
          confirmation: "Confirmed", acknowledgeFinalTransition: false });
        // The gateway separately proves final-chain expiry before returning
        // this replacement. The buyer never infers expiry from its own clock.
      }
      if (args.authorization && request.phase === "submit") {
        submissions.push(request);
        return request.preparationId === historicalId
          ? { content: [], isError: true, structuredContent: { code: "CONFIRMATION_CLIENT_UPGRADE_REQUIRED" } }
          : { content: [], isError: true, structuredContent: { code: "CONFIRMATION_SUBMISSION_PENDING",
            expected: { operationId: "replacement-operation" } } };
      }
      return originalCall(name, args);
    };
    await assert.rejects(confirmOrder(context, current(), { ...options, resume: true }, factsReader()),
      code("CONFIRMATION_CLIENT_UPGRADE_REQUIRED"));
    assert.deepEqual(submissions[0], historical.request, "resume does not rewrite the old signed request");
    assert.equal(current().confirmationSubmission!.request.signature, oldSignature);
    await assert.rejects(confirmOrder(context, current(), { ...options, confirmation: "Confirmed" }, factsReader()),
      code("DASKI_CONFIRMATION_PENDING"));
    await assert.rejects(confirmOrder(context, current(), { ...options, confirmation: "Confirmed",
      supersedesPreparationId: historicalId }, factsReader()));
    assert.equal(innerSignatures.length, 0, "a blocked legacy journal cannot silently obtain another signature");
    const replaced = await confirmOrder(context, current(), { ...options, confirmation: "Confirmed",
      supersedesPreparationId: historicalId, acknowledgeSameNonce: true }, factsReader());
    assert.equal(replaced.state, "pending");
    assert.equal(replaced.operationId, "replacement-operation");
    assert.equal(calls.filter(call => call.request.phase === "prepare").length, 1);
    assert.equal(innerSignatures.length, 1);
    assert.deepEqual(innerSignatures[0], gateway.prepared.signableTypedData);
    assert.equal(submissions[1]!.reviewProtocol, 2);
    assert.equal(submissions[1]!.preparationId, replacementId);
    assert.notEqual(submissions[1]!.signature, oldSignature);
    assert.equal(current().confirmationSubmission!.operationId, "replacement-operation");
    assert.equal(current().confirmationSubmission!.profileId, "eas-native-1.2.0");
    assert.deepEqual(current().confirmationHistory![0]!.submission.request, historical.request);
    assert.equal(current().confirmationHistory![0]!.submission.operationId, undefined);
  });
});

const circleExecution = () => parseGatewayMetadata({ confirmation: {
  modes: ["direct"], directReview: { circleEstimate: true, circleExecute: true } } });
/** A failed vendor run as the runner reports it: the code, and what the child recorded. */
const vendorFailure = (circleProgress: Record<string, unknown>) => new CliError({ code: "DASKI_CIRCLE_REVIEW_UNKNOWN",
  message: "Circle did not return a definitive review result.", remediation: "Keep the saved review journal.",
  details: { circleProgress: { executionRequested: true, approvalSent: false, uncertain: false, ...circleProgress } } });

test("a Circle run that never sent an approval restores the prepared review, which can then be submitted", async () => {
  await withStore(async record => {
    const { context } = fixture("contract");
    context.metadata = async () => circleExecution();
    let attempts = 0;
    const adapter = () => ({ packageVersion: "1.1.4", estimate: async () => ({}),
      submit: async () => {
        attempts++;
        if (attempts === 1) throw vendorFailure({ challengeId: "refused-challenge" });
        return { transactionId: "tx-1", txHash: TX, state: "COMPLETE",
          progress: { executionRequested: true, challengeId: "c-1", approvalSent: true, transactionId: "tx-1", uncertain: false } };
      },
      lookup: async () => ({ hashes: [] }) });
    await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader(), adapter);
    const prepared = current().confirmationTx!;
    await assert.rejects(confirmOrder(context, current(), { ...options, submit: true, approveCallHash: prepared.callHash }, factsReader(), adapter),
      code("DASKI_CIRCLE_REVIEW_NOT_STARTED"));
    assert.deepEqual(current().confirmationTx, prepared, "nothing could execute, so the prepared review is restored as it was");
    const submitted = await confirmOrder(context, current(), { ...options, submit: true, approveCallHash: prepared.callHash }, factsReader(), adapter);
    assert.equal(submitted.transactionId, "tx-1");
    assert.equal(current().confirmationTx?.vendor?.challengeId, "c-1");
    assert.equal(current().confirmationTx?.vendor?.fromBlock, "100");
    assert.deepEqual(current().confirmationTx?.vendor?.hashes, [TX]);
  });
});

test("a Circle run that cannot create its progress file starts nothing and restores the prepared review", async () => {
  await withStore(async record => {
    const { context } = fixture("contract");
    context.metadata = async () => circleExecution();
    // The real runner; it stops before any child, so the entry is never read.
    const adapter = () => createCircleReviewAdapter({ entry: join(tmpdir(), "no-circle-entry.js"), run: spawnCircleReview, packageVersion: "1.1.4" });
    await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader(), adapter);
    const prepared = current().confirmationTx!;
    const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
    const missing = join(tmpdir(), `daski-no-temp-${process.pid}`, "missing");
    for (const key of Object.keys(saved)) process.env[key] = missing;
    try {
      await assert.rejects(confirmOrder(context, current(), { ...options, submit: true, approveCallHash: prepared.callHash }, factsReader(), adapter),
        (error: unknown) => error instanceof CliError && error.code === "DASKI_CIRCLE_REVIEW_NOT_STARTED" &&
          /progress file/.test(String(error.details.reason)));
    } finally {
      for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.deepEqual(current().confirmationTx, prepared, "nothing reached Circle, so the review stays prepared and can be submitted again");
  });
});

test("an approved or uncertain Circle run keeps every identity, and --resume finds the review on chain when Circle cannot be read", async () => {
  await withStore(async record => {
    const { context, chain, gateway } = fixture("contract");
    context.metadata = async () => circleExecution();
    let lookups = 0;
    const adapter = () => ({ packageVersion: "1.1.4", estimate: async () => ({}),
      submit: async () => { throw vendorFailure({ challengeId: "c-1", approvalSent: true }); },
      lookup: async () => { lookups++; throw new CliError({ code: "DASKI_CIRCLE_REVIEW_UNKNOWN", message: "unreadable", remediation: "keep" }); } });
    await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader(), adapter);
    const callHash = current().confirmationTx!.callHash;
    chain.finalized = 40n;
    await assert.rejects(confirmOrder(context, current(), { ...options, submit: true, approveCallHash: callHash }, factsReader(), adapter),
      code("DASKI_CIRCLE_REVIEW_UNKNOWN"));
    assert.equal(current().confirmationTx?.state, "submitted");
    assert.equal(current().confirmationTx?.vendor?.challengeId, "c-1");
    assert.equal(current().confirmationTx?.vendor?.fromBlock, "40", "the final height before submission bounds the chain search");
    await assert.rejects(confirmOrder(context, current(), { ...options, abandon: true }), code("DASKI_CONFIRMATION_TX_MAY_EXECUTE"));
    await assert.rejects(confirmOrder(context, current(), { ...options, check: true }),
      (error: unknown) => error instanceof CliError && error.code === "DASKI_CONFIRMATION_TX_NOT_RECORDED" && /--resume/.test(error.remediation));
    chain.finalized = 100n;
    const nothing = await confirmOrder(context, current(), { ...options, resume: true }, factsReader(), adapter);
    assert.equal(nothing.state, "submitted");
    assert.equal(nothing.vendorLookup, "unavailable");
    assert.ok(chain.log.includes("logs:40-100"));
    // The review lands in block 42; the chain shows it while Circle still cannot be read.
    const topics = encodeEventTopics({ abi: EAS_ABI, eventName: "Attested",
      args: { recipient: RECIPIENT, attester: payer.address, schemaUID: facts.schemaUid } }) as Hex[];
    const stranger = encodeEventTopics({ abi: EAS_ABI, eventName: "Attested",
      args: { recipient: RECIPIENT, attester: "0x5555555555555555555555555555555555555555", schemaUID: facts.schemaUid } }) as Hex[];
    chain.logs = [{ address: EAS_PREDEPLOY, topics: stranger, data: canonicalHash("someone else"), transactionHash: `0x${"bb".repeat(32)}`, blockNumber: 41n },
      { address: EAS_PREDEPLOY, topics, data: UID, transactionHash: TX, blockNumber: 42n }];
    chain.receipt = receipt();
    gateway.check = { confirmedCurrent: { state: "Confirmed", currentUid: UID }, finalizedBlock: block(50) };
    const observed = await confirmOrder(context, current(), { ...options, resume: true }, factsReader(), adapter);
    assert.equal(observed.state, "observed");
    assert.equal(current().confirmationTx?.txHash, TX);
    assert.equal(lookups, 2);
  });
});

test("a started Circle execution takes the hash recorded with --tx and closes on --check", async () => {
  await withStore(async record => {
    const { context, chain, gateway } = fixture("contract");
    context.metadata = async () => circleExecution();
    const adapter = () => ({ packageVersion: "1.1.4", estimate: async () => ({}),
      submit: async () => { throw vendorFailure({ approvalSent: true }); }, lookup: async () => ({ hashes: [] }) });
    await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader(), adapter);
    await assert.rejects(confirmOrder(context, current(), { ...options, submit: true, approveCallHash: current().confirmationTx!.callHash }, factsReader(), adapter));
    const recorded = await confirmOrder(context, current(), { ...options, tx: TX });
    assert.equal(recorded.state, "submitted");
    assert.deepEqual(current().confirmationTx?.vendor?.hashes, [TX]);
    chain.receipt = receipt();
    gateway.check = { confirmedCurrent: { state: "Confirmed", currentUid: UID }, finalizedBlock: block(50) };
    const observed = await confirmOrder(context, current(), { ...options, check: true });
    assert.equal(observed.state, "observed");
  });
});

test("a started Circle execution is abandoned only once Circle reports its transaction failed", async () => {
  await withStore(async record => {
    const { context } = fixture("contract");
    context.metadata = async () => circleExecution();
    let state = "SENT";
    const adapter = () => ({ packageVersion: "1.1.4", estimate: async () => ({}),
      submit: async () => { throw vendorFailure({ approvalSent: true, challengeId: "c-1", transactionId: "tx-1", state: "SENT" }); },
      lookup: async () => ({ transactionId: "tx-1", hashes: [], state }) });
    await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader(), adapter);
    await assert.rejects(confirmOrder(context, current(), { ...options, submit: true, approveCallHash: current().confirmationTx!.callHash }, factsReader(), adapter));
    assert.equal(current().confirmationTx?.vendor?.state, "SENT");
    await assert.rejects(confirmOrder(context, current(), { ...options, abandon: true }), code("DASKI_CONFIRMATION_TX_MAY_EXECUTE"));
    state = "FAILED";
    const failed = await confirmOrder(context, current(), { ...options, resume: true }, factsReader(), adapter);
    assert.equal(failed.vendorState, "FAILED");
    assert.match(String(failed.next), /--abandon/);
    const abandoned = await confirmOrder(context, current(), { ...options, abandon: true });
    assert.equal(abandoned.state, "abandoned");
  });
});

test("a call prepared before 0.5.0 is restored by preparing the same choice; another choice is refused", async () => {
  await withStore(async record => {
    const { context, gateway } = fixture("contract");
    context.metadata = async () => circleExecution();
    let estimates = 0;
    const adapter = () => ({ packageVersion: "1.1.4", estimate: async () => { estimates++; return { gasLimit: "180000" }; },
      submit: async () => { throw new Error("not submitted in this test"); }, lookup: async () => ({ hashes: [] }) });
    await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader(), adapter);
    // What 0.4.x saved: the hash and binding, not the call or the choice.
    const { call: _call, choice: _choice, ...legacy } = current().confirmationTx!;
    updateOrder("intent", { confirmationTx: { ...legacy, preparedAt: "2026-09-29T20:28:19.981Z" } });
    await assert.rejects(confirmOrder(context, current(), { ...options, estimate: true }, factsReader(), adapter),
      (error: unknown) => error instanceof CliError && error.code === "DASKI_CONFIRMATION_NOT_PREPARED" && /earlier buyer/.test(error.remediation));
    gateway.prepared = { ...gateway.prepared, call: attestCall(facts, "NotConfirmed") };
    await assert.rejects(confirmOrder(context, current(), { ...options, confirmation: "NotConfirmed" }, factsReader(), adapter),
      code("DASKI_CONFIRMATION_TX_PENDING"));
    assert.equal(current().confirmationTx?.call, undefined, "a different call never replaces the saved one");
    gateway.prepared = { ...gateway.prepared, call: attestCall() };
    const restored = await confirmOrder(context, current(), { ...options, confirmation: "Confirmed" }, factsReader(), adapter);
    assert.equal(restored.restored, true);
    assert.equal(restored.callHash, legacy.callHash);
    assert.equal(current().confirmationTx?.preparedAt, "2026-09-29T20:28:19.981Z");
    assert.equal(current().confirmationTx?.choice, "Confirmed");
    await confirmOrder(context, current(), { ...options, estimate: true }, factsReader(), adapter);
    assert.equal(estimates, 1);
  });
});

test("the chain search stays within a public RPC's 500-block log range and a bounded window after submission", async () => {
  await withStore(async record => {
    const { context, chain } = fixture("contract");
    context.metadata = async () => circleExecution();
    const adapter = () => ({ packageVersion: "1.1.4", estimate: async () => ({}),
      submit: async () => { throw vendorFailure({ approvalSent: true }); }, lookup: async () => ({ hashes: [] }) });
    await confirmOrder(context, record, { ...options, confirmation: "Confirmed" }, factsReader(), adapter);
    chain.finalized = 1000n;
    await assert.rejects(confirmOrder(context, current(), { ...options, submit: true, approveCallHash: current().confirmationTx!.callHash }, factsReader(), adapter));
    chain.finalized = 9000n;
    chain.log.length = 0;
    const pending = await confirmOrder(context, current(), { ...options, resume: true }, factsReader(), adapter);
    assert.equal(pending.chainSearch, "searched");
    const ranges = chain.log.filter(entry => entry.startsWith("logs:")).map(entry => entry.slice(5).split("-").map(BigInt) as [bigint, bigint]);
    assert.ok(ranges.every(([from, to]) => to - from < 500n));
    assert.deepEqual(ranges[0], [1000n, 1499n]);
    assert.deepEqual(ranges.at(-1), [4000n, 4000n], "the window ends 3,000 blocks past the recorded height");
  });
});
