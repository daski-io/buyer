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
import type { ChainReader, TransactionReceiptLike } from "../src/chain/reader.js";
import { CliError } from "../src/cli/errors.js";
import {
  confirmOrder, confirmationData, EAS_ABI, FINAL_ATTESTATION_WARNING, readConfirmationFacts,
  selectConfirmationMode, validateDirectCall, type ConfirmationFacts, type DirectCall,
} from "../src/commands/confirmation.js";
import type { CommandContext } from "../src/context.js";
import { DEFAULT_CONFIG, EAS_PREDEPLOY } from "../src/config.js";
import { parseGatewayMetadata } from "../src/gateway/metadata.js";
import { findByIntent, upsertOrder, type OrderRecord } from "../src/store/orders.js";

const code = (wanted: string) => (error: unknown): boolean => error instanceof CliError && error.code === wanted;
const payer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const profile = { ...DEFAULT_CONFIG.profiles.sandbox! };
const ZERO_UID = `0x${"00".repeat(32)}` as Hex;
const RECIPIENT = "0x4444444444444444444444444444444444444444" as Address;
const REPUTATION = "0x3333333333333333333333333333333333333333" as Address;
const facts: ConfirmationFacts = {
  chainId: 84532, eas: EAS_PREDEPLOY, schemaUid: canonicalHash("schema"), reputationStorage: REPUTATION,
  orderKey: canonicalHash("order"), recipient: RECIPIENT, currentUid: ZERO_UID, nonce: "0", submissionsUsed: 0,
};
const TX = `0x${"aa".repeat(32)}` as Hex;
const UID = canonicalHash("new attestation");

function attestCall(f: ConfirmationFacts = facts, choice: "Confirmed" | "NotConfirmed" = "Confirmed"): DirectCall {
  const data = confirmationData(f.orderKey, choice);
  return {
    chainId: f.chainId, to: f.eas, function: "attest",
    request: { schema: f.schemaUid, data: { recipient: f.recipient, expirationTime: "0", revocable: true, refUID: f.currentUid, data, value: "0" } },
    calldata: encodeFunctionData({ abi: EAS_ABI, functionName: "attest", args: [{ schema: f.schemaUid,
      data: { recipient: f.recipient, expirationTime: 0n, revocable: true, refUID: f.currentUid, data, value: 0n } }] }),
  };
}

function revokeCall(f: ConfirmationFacts): DirectCall {
  return {
    chainId: f.chainId, to: f.eas, function: "revoke",
    request: { schema: f.schemaUid, data: { uid: f.currentUid, value: "0" } },
    calldata: encodeFunctionData({ abi: EAS_ABI, functionName: "revoke", args: [{ schema: f.schemaUid, data: { uid: f.currentUid, value: 0n } }] }),
  };
}

const description = (accountType: SignerDescription["accountType"]): SignerDescription =>
  ({ provider: accountType === "contract" ? "circle-agent" : "local", accountType, conformance: "verified" });

/** A receipt carrying one EAS event, optionally from another contract. */
function receipt(args: { event?: "Attested" | "Revoked"; emitter?: Address; attester?: Address; schema?: Hex; uid?: Hex; status?: "success" | "reverted" } = {}): TransactionReceiptLike {
  const topics = encodeEventTopics({ abi: EAS_ABI, eventName: args.event ?? "Attested",
    args: { recipient: RECIPIENT, attester: args.attester ?? payer.address, schemaUID: args.schema ?? facts.schemaUid } });
  return { status: args.status ?? "success", blockNumber: 42n, from: payer.address,
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
  chain: { receipt: TransactionReceiptLike | null; attestation: Attestation; record?: Record<string, unknown> };
  gateway: { prepared: Record<string, unknown>; check: Record<string, unknown>; eas: Address };
}

function fixture(accountType: SignerDescription["accountType"]): Fixture {
  const json = (structuredContent: Record<string, unknown>, isError = false) => ({ content: [], structuredContent, isError });
  const signer = { getAddress: async () => payer.address, describe: () => description(accountType),
    signTypedData: async (data: TypedDataRequest) => payer.signTypedData(data as never) };
  const calls: Fixture["calls"] = [];
  const chainState: Fixture["chain"] = { receipt: null, attestation: attestation() };
  const gateway: Fixture["gateway"] = { prepared: { submissionsUsed: 0, revocationAvailable: false, finalAttestation: false, call: attestCall() },
    check: { lastObserved: null, confirmedCurrent: null, submissionsUsed: 0, observedBlock: null, finalizedBlock: null }, eas: EAS_PREDEPLOY };
  const reader: ChainReader = {
    getCode: async () => "0x6080",
    call: async () => ({ data: undefined, reverted: true }),
    getTransactionReceipt: async (hash) => { assert.equal(hash, TX); return chainState.receipt; },
    readContract: async <T,>(args: { functionName: string; args: readonly unknown[] }): Promise<T> => {
      if (args.functionName === "getAttestation") return chainState.attestation as T;
      if (args.functionName === "getNonce") return 0n as T;
      if (args.functionName === "getRecord") return (chainState.record ?? {}) as T;
      throw new Error(`unexpected read ${args.functionName}`);
    },
  };
  const context = { profile, profileName: "sandbox", payerAddress: payer.address, signer, resolveSigner: async () => signer, chain: reader,
    metadata: async () => parseGatewayMetadata({ confirmationSigning: { chainId: 84532, eas: gateway.eas, schemaUid: facts.schemaUid, reputationStorage: REPUTATION } }),
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
const factsReader = (f: ConfirmationFacts = facts) => async () => f;
const options = { handle: "handle", json: true };

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
      submissionsUsed: 1, observedBlock: 50, finalizedBlock: 45 };
    const observed = await confirmOrder(context, current(), { ...options, check: true });
    assert.equal(observed.state, "observed");
    assert.equal(current().confirmationTx?.state, "observed");
    assert.equal(current().confirmationTx?.uid, UID);
    await assert.rejects(confirmOrder(context, current(), { ...options, tx: TX }), code("DASKI_CONFIRMATION_TX_ALREADY_RECORDED"));
    assert.equal((await confirmOrder(context, current(), { ...options, check: true })).state, "observed");

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
    gateway.check = { confirmedCurrent: { state: "Confirmed", currentUid: UID } };
    assert.equal((await confirmOrder(context, current(), { ...options, check: true })).state, "submitted", "still current on the finalized read");
    gateway.check = { confirmedCurrent: { state: "Pending", currentUid: ZERO_UID } };
    assert.equal((await confirmOrder(context, current(), { ...options, check: true })).state, "observed");
  });
});

test("an EOA signer may ask for direct mode; a contract signer cannot be sponsored; capacity is checked before the gateway is asked", async () => {
  await withStore(async (record) => {
    const eoa = fixture("eoa");
    const prepared = await confirmOrder(eoa.context, record, { ...options, confirmation: "Confirmed", submission: "direct" }, factsReader());
    assert.equal(prepared.mode, "direct");
    assert.equal(eoa.calls[0]!.request.submission, "direct");
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
    chain.record = { orderKey: facts.orderKey, providerAgentId: 1n, payer: payer.address, providerOwner: RECIPIENT,
      providerAgentWallet: "0x0000000000000000000000000000000000000000", confirmationSubmissions: 1, outcomeRecorded: true,
      reputationEligible: true, currentConfirmationUid: UID };
    const read = await readConfirmationFacts(context, record);
    assert.deepEqual(read, { ...facts, currentUid: UID, submissionsUsed: 1 });
    gateway.eas = REPUTATION;
    await assert.rejects(readConfirmationFacts(context, record), code("DASKI_EAS_ADDRESS_MISMATCH"));
    await assert.rejects(confirmOrder(context, record, { ...options, confirmation: "Confirmed" }), code("DASKI_EAS_ADDRESS_MISMATCH"));
    assert.equal(calls.length, 0);
  });
});
