/**
 * `daski order confirm` and `daski order revoke-confirmation` — the payer's
 * delivery confirmation, in one of two modes chosen by the signer.
 *
 * Sponsored (plain wallets): the gateway prepares a delegated EAS request,
 * this CLI rebuilds the narrow review message from deployment pins, chain
 * state and the user's choice, the wallet signs only when both agree, and
 * Daski's relayer submits it. Direct (contract accounts, or an EOA that asks
 * for it): the gateway prepares the closed `attest` or `revoke` call, this
 * CLI validates every field of it against the same chain facts and the
 * profile's pinned EAS address, re-encodes the calldata, and prints the call
 * for the wallet's own tool to submit. The CLI never sends a transaction in
 * either mode, and never constructs anything that could.
 *
 * A direct submission is tracked in `orders.json`: `--tx <hash>` records the
 * hash immediately as `submitted` (recorded, unverified) so a restart never
 * loses the association; `--check` advances it to `observed` only when the
 * receipt succeeded, the pinned EAS emitted the matching event with the payer
 * as attester, `getAttestation` binds the attestation to what was prepared,
 * and the gateway's finalized read, anchored at or past the receipt's block,
 * shows the result. Evidence is bound to one finalized view: the profile's
 * RPC must report the receipt's height as finalized before its canonical
 * block at that height is compared with the receipt's block (a read below
 * the RPC's own finalized height cannot change afterwards), attestations are
 * read pinned to that finalized height, and the gateway's finalized block
 * must be that RPC's canonical block at its height, so the receipt's block is
 * a finalized ancestor of the anchor. The RPC is taken as one consistent
 * node. A batched receipt may carry other orders' events first; every
 * candidate event is tried and the one whose attestation binds is taken.
 * `--abandon` clears the local record when no hash is recorded or the receipt
 * is a revert in a finalized canonical block, and cancels nothing at the
 * wallet. A hash recorded by mistake is corrected (replaced with `--tx`, or
 * cleared with `--abandon`) only once its transaction is finalized and
 * canonical and no candidate event binds to this call; a missing, pending,
 * unfinalized, or matching receipt keeps the record.
 *
 * One order's journal is updated under a per-order lock: the read-check-write
 * of a preparation spans gateway and chain calls, and two concurrent
 * preparations must not both find nothing pending. The signer is resolved
 * before the lock, so no passphrase prompt runs inside it.
 */
import { canonicalHash, type SignerDescription, type TypedDataRequest } from "@daski/x402-scheme";
import {
  decodeEventLog, encodeAbiParameters, encodeFunctionData, getAddress, isAddressEqual, keccak256,
  parseAbi, parseAbiParameters, type Address, type Hex,
} from "viem";
import type { ChainReader, TransactionReceiptLike } from "../chain/reader.js";
import { CliError } from "../cli/errors.js";
import type { CommandContext } from "../context.js";
import { callAuthorizedLifecycleTool } from "../gateway/lifecycle.js";
import { easAddressMismatch } from "../gateway/metadata.js";
import {
  findByIntent, updateOrder, withOrderLock,
  type ConfirmationTxExpected, type ConfirmationTxRecord, type OrderRecord,
} from "../store/orders.js";
import { readWithCapability, type OrderOptions } from "./order.js";

export interface ConfirmationOptions extends OrderOptions {
  confirmation?: string | undefined;
  revoke?: boolean | undefined;
  resume?: boolean | undefined;
  acknowledgeFinalTransition?: boolean | undefined;
  /** `sponsored` or `direct`; defaults by signer. */
  submission?: string | undefined;
  /** Direct mode: record the hash the wallet's tool reported. */
  tx?: string | undefined;
  /** Direct mode: verify the recorded transaction and the finalized state. */
  check?: boolean | undefined;
  /** Direct mode: drop a record that has no executable transaction behind it. */
  abandon?: boolean | undefined;
}

export type ConfirmationMode = "sponsored" | "direct";
type Choice = "Confirmed" | "NotConfirmed" | "revoke";

export const FINAL_ATTESTATION_WARNING =
  "this is the last confirmation you can submit; it can still be revoked";
export const ATTESTATION_CAP = 3;
const ZERO_UID: Hex = `0x${"00".repeat(32)}`;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

const attestTypes = { Attest: [
  { name: "schema", type: "bytes32" }, { name: "recipient", type: "address" },
  { name: "expirationTime", type: "uint64" }, { name: "revocable", type: "bool" },
  { name: "refUID", type: "bytes32" }, { name: "data", type: "bytes" },
  { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" },
] };
const revokeTypes = { Revoke: [
  { name: "schema", type: "bytes32" }, { name: "uid", type: "bytes32" },
  { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" },
] };

/** EAS 1.2.0: the two calls direct mode validates, the read that binds a receipt, and the events. */
export const EAS_ABI = parseAbi([
  "function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data) request) payable returns (bytes32)",
  "function revoke((bytes32 schema,(bytes32 uid,uint256 value) data) request) payable",
  "function getAttestation(bytes32 uid) view returns ((bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))",
  "function getNonce(address account) view returns (uint256)",
  "event Attested(address indexed recipient,address indexed attester,bytes32 uid,bytes32 indexed schemaUID)",
  "event Revoked(address indexed recipient,address indexed attester,bytes32 uid,bytes32 indexed schemaUID)",
]);

export const REPUTATION_ABI = parseAbi([
  "function getRecord(bytes32 orderKey) view returns ((bytes32 orderKey,bytes32 authorizationKey,uint256 providerAgentId,bytes32 serviceId,address payer,address providerOwner,address providerAgentWallet,address providerPayee,address canonicalToken,uint256 grossAmount,uint64 paidAt,bytes32 providerIdentitySnapshotHash,bytes32 listingManifestHash,bytes32 releaseEvidenceHash,uint8 outcome,uint8 confirmation,uint64 outcomeAttestationDelay,uint64 outcomeTimestamp,uint64 confirmationTimestamp,uint8 confirmationSubmissions,bool outcomeRecorded,bool reputationEligible,bytes32 currentConfirmationUid))",
]);

export interface ConfirmationFacts {
  chainId: number;
  eas: Address;
  schemaUid: Hex;
  reputationStorage: Address;
  orderKey: Hex;
  recipient: Address;
  currentUid: Hex;
  nonce: string;
  /** Attestations submitted for the order so far; three is the cap. */
  submissionsUsed: number;
}

interface Attestation {
  uid: Hex; schema: Hex; time: bigint; expirationTime: bigint; revocationTime: bigint;
  refUID: Hex; recipient: Address; attester: Address; revocable: boolean; data: Hex;
}

/** The closed call the gateway returns in direct mode. */
export interface DirectCall {
  chainId: number;
  to: Address;
  function: "attest" | "revoke";
  request: Record<string, unknown>;
  calldata: Hex;
}

/** The attestation payload for an order and label. */
export function confirmationData(orderKey: Hex, choice: "Confirmed" | "NotConfirmed"): Hex {
  return encodeAbiParameters(parseAbiParameters("bytes32 orderKey,uint8 confirmation"),
    [orderKey, choice === "Confirmed" ? 1 : 2]);
}

/** Mode by signer: a contract account submits directly; a plain wallet is sponsored unless it asks otherwise. */
export function selectConfirmationMode(
  description: SignerDescription,
  requested: string | undefined,
): ConfirmationMode {
  const contract = description.accountType === "contract";
  if (requested === undefined) return contract ? "direct" : "sponsored";
  if (requested !== "sponsored" && requested !== "direct") {
    throw new CliError({
      code: "DASKI_CONFIRMATION_SUBMISSION_INVALID",
      message: `--submission must be sponsored or direct, not "${requested}".`,
      remediation: "Omit the flag to let the signer decide, or pass --submission direct.",
    });
  }
  if (requested === "sponsored" && contract) {
    throw new CliError({
      code: "DASKI_CONFIRMATION_SPONSORED_REQUIRES_EOA",
      message:
        `The ${description.provider} signer is a contract account; Daski sponsors attestations ` +
        "for plain wallets only.",
      remediation:
        "Omit --submission (or pass --submission direct): the CLI prints a validated call for " +
        "the wallet's own tool to submit.",
    });
  }
  return requested;
}

/** Rebuild the narrow EAS review message from chain facts and the user's choice. */
export function validateConfirmationPreparation(prepared: Record<string, unknown>, facts: ConfirmationFacts,
  choice: Choice, acknowledged: boolean, now = Math.floor(Date.now() / 1000)): TypedDataRequest {
  const proposed = prepared.signableTypedData as TypedDataRequest | undefined;
  const deadline = Number(proposed?.message?.deadline);
  const final = choice !== "revoke" && facts.submissionsUsed === ATTESTATION_CAP - 1;
  if (!proposed || prepared.orderKey !== facts.orderKey || prepared.currentRefUid !== facts.currentUid ||
      prepared.submissionsUsed !== facts.submissionsUsed || Boolean(prepared.finalAttestation) !== final ||
      (choice !== "revoke" && facts.submissionsUsed >= ATTESTATION_CAP) ||
      (choice === "revoke" && facts.currentUid === ZERO_UID) || (final && !acknowledged) ||
      !Number.isSafeInteger(deadline) || deadline <= now || deadline > now + 330) {
    throw invalidPreparation();
  }
  const common = { schema: facts.schemaUid, value: "0", nonce: facts.nonce, deadline: String(deadline) };
  const expected: TypedDataRequest = { domain: { name: "EAS", version: "1.2.0", chainId: facts.chainId, verifyingContract: facts.eas },
    types: choice === "revoke" ? revokeTypes : attestTypes, primaryType: choice === "revoke" ? "Revoke" : "Attest",
    message: choice === "revoke" ? { ...common, uid: facts.currentUid } : { ...common, recipient: facts.recipient,
      expirationTime: "0", revocable: true, refUID: facts.currentUid, data: confirmationData(facts.orderKey, choice) } };
  if (canonicalHash(proposed) !== canonicalHash(expected)) throw invalidPreparation();
  return expected;
}

function invalidPreparation(): CliError {
  return new CliError({ code: "DASKI_CONFIRMATION_MISMATCH", message: "The review preparation does not match this order and choice.",
    remediation: "Check the order and request a fresh review preparation." });
}

function invalidCall(reason: string): CliError {
  return new CliError({
    code: "DASKI_CONFIRMATION_PREPARATION_INVALID",
    message: `The prepared call does not match this order's chain facts: ${reason}.`,
    remediation:
      "Nothing was shown or submitted. Run daski doctor --json to check the gateway's " +
      "confirmation pins, then request a fresh preparation.",
  });
}

function sameHex(a: unknown, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as object).sort();
  return actual.join(",") === [...keys].sort().join(",");
}

/**
 * Validates a direct-mode call against chain facts exactly as the sponsored
 * path validates its typed data: chain id, the pinned EAS as target, the
 * pinned schema, the recipient, refUID, data and zero value derived from
 * `getRecord` and the label, and calldata that re-encodes identically. Any
 * mismatch aborts before the call is shown.
 */
export function validateDirectCall(
  value: unknown,
  facts: ConfirmationFacts,
  choice: Choice,
  easAddress: Address,
): { action: "attest" | "revoke"; call: DirectCall; data: Hex | undefined } {
  if (!exactKeys(value, ["chainId", "to", "function", "request", "calldata"])) throw invalidCall("unexpected call shape");
  const call = value;
  if (call.chainId !== facts.chainId) throw invalidCall(`chain ${String(call.chainId)} is not ${facts.chainId}`);
  if (typeof call.to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(call.to) ||
      !isAddressEqual(getAddress(call.to), easAddress) || !isAddressEqual(easAddress, facts.eas)) {
    throw invalidCall(`target ${String(call.to)} is not the pinned EAS ${easAddress}`);
  }
  const action = choice === "revoke" ? "revoke" : "attest";
  if (call.function !== action) throw invalidCall(`function ${String(call.function)} is not ${action}`);
  if (!exactKeys(call.request, ["schema", "data"]) || !sameHex(call.request.schema, facts.schemaUid)) {
    throw invalidCall("the request does not name the pinned confirmation schema");
  }
  const fields = call.request.data;
  let calldata: Hex;
  let data: Hex | undefined;
  if (action === "attest") {
    if (!exactKeys(fields, ["recipient", "expirationTime", "revocable", "refUID", "data", "value"])) {
      throw invalidCall("unexpected attest request shape");
    }
    data = confirmationData(facts.orderKey, choice as "Confirmed" | "NotConfirmed");
    if (typeof fields.recipient !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(fields.recipient) ||
        !isAddressEqual(getAddress(fields.recipient), facts.recipient)) throw invalidCall("recipient differs from the provider on record");
    if (fields.expirationTime !== "0" || fields.revocable !== true || fields.value !== "0") throw invalidCall("expirationTime, revocable or value differ from the confirmation profile");
    if (!sameHex(fields.refUID, facts.currentUid)) throw invalidCall("refUID differs from the current confirmation");
    if (!sameHex(fields.data, data)) throw invalidCall("data differs from the order key and label");
    if (facts.submissionsUsed >= ATTESTATION_CAP) throw invalidCall("all attestations for this order are used");
    calldata = encodeFunctionData({ abi: EAS_ABI, functionName: "attest", args: [{
      schema: facts.schemaUid, data: { recipient: facts.recipient, expirationTime: 0n, revocable: true,
        refUID: facts.currentUid, data, value: 0n } }] });
  } else {
    if (!exactKeys(fields, ["uid", "value"])) throw invalidCall("unexpected revoke request shape");
    if (facts.currentUid === ZERO_UID) throw invalidCall("no confirmation is active to revoke");
    if (!sameHex(fields.uid, facts.currentUid)) throw invalidCall("uid differs from the current confirmation");
    if (fields.value !== "0") throw invalidCall("value is not zero");
    calldata = encodeFunctionData({ abi: EAS_ABI, functionName: "revoke", args: [{
      schema: facts.schemaUid, data: { uid: facts.currentUid, value: 0n } }] });
  }
  if (!sameHex(call.calldata, calldata)) throw invalidCall("calldata does not re-encode from the request");
  return {
    action,
    call: {
      chainId: facts.chainId, to: easAddress, function: action,
      request: call.request, calldata: (call.calldata as string).toLowerCase() as Hex,
    },
    data,
  };
}

export async function runConfirmation(options: ConfirmationOptions): Promise<Record<string, unknown>> {
  const { withOrder } = await import("./order.js");
  return withOrder(options, (context, record) => confirmOrder(context, record, options));
}

/**
 * Gateway refusals the submit phase raises before any sponsorship is reserved
 * (request shape, mode, signature, stale preparation, exhausted budget): the
 * signed request was never admitted, so the retained submission is cleared and
 * another mode can be prepared. Anything else (an unavailable chain read, a
 * transport failure) may have been admitted and keeps the record for --resume.
 */
const REFUSED_BEFORE_ADMISSION: ReadonlySet<string> = new Set([
  "CONFIRMATION_REQUEST_INVALID",
  "CONFIRMATION_SPONSORED_REQUIRES_EOA",
  "CONFIRMATION_SIGNATURE_INVALID",
  "CONFIRMATION_PREPARATION_STALE",
  "CONFIRMATION_SPONSORSHIP_LIMIT",
]);

/** The record as the store holds it now; the caller's copy may predate another process's write. */
function latest(record: OrderRecord): OrderRecord {
  return findByIntent(record.intentId) ?? record;
}

export async function confirmOrder(context: CommandContext, record: OrderRecord, options: ConfirmationOptions,
  factsReader = readConfirmationFacts): Promise<Record<string, unknown>> {
  const handle = record.handle ?? options.handle;
  if (options.tx !== undefined || options.check || options.abandon) {
    // Only --check signs (the gateway's check authorization); the signer is
    // resolved before the lock so a passphrase prompt never runs inside it.
    if (options.check) await context.resolveSigner();
    return withOrderLock(record.intentId, () => manageDirectRecord(context, latest(record), options));
  }
  const choice: Choice | undefined = options.revoke ? "revoke"
    : options.confirmation === "Confirmed" || options.confirmation === "NotConfirmed" ? options.confirmation : undefined;
  if (!options.resume && choice === undefined) {
    throw new CliError({ code: "DASKI_CONFIRMATION_CHOICE_REQUIRED", message: "Choose the delivery confirmation for this order.",
      remediation: "After the user's choice, pass --choice Confirmed or --choice NotConfirmed. Leaving it Pending requires no action." });
  }
  const call = (action: "confirmation" | "revoke-confirmation", request: Record<string, unknown>) => callAuthorizedLifecycleTool({
    client: context.client, signer: context.signer, toolName: action === "confirmation" ? "daski_confirm_delivery" : "daski_revoke_delivery_confirmation",
    action, orderHandle: handle, request, chainId: context.profile.chainId, gatewayUrl: context.profile.gatewayUrl });
  // Every path below signs something; building the signer may prompt a
  // person, which must not happen while the order's lock is held.
  const signer = await context.resolveSigner();

  return withOrderLock(record.intentId, async () => {
    record = latest(record);
    if (record.confirmationSubmission && !options.resume) throw new CliError({ code: "DASKI_CONFIRMATION_PENDING",
      message: "A review submission for this order is awaiting reconciliation.", remediation: `Run daski order confirm ${options.handle} --resume.` });
    let submission = record.confirmationSubmission;
    if (!submission) {
      if (options.resume) throw new CliError({ code: "DASKI_CONFIRMATION_NOT_PENDING", message: "There is no pending review submission.",
        remediation: "Check order status, then supply the user's review choice if a new review is wanted." });
      const action = options.revoke ? "revoke-confirmation" : "confirmation";
      const mode = selectConfirmationMode(signer.describe(), options.submission);
      if (mode === "direct" && isPendingDirect(record.confirmationTx)) throw directPending(handle, record.confirmationTx!);
      const facts = await factsReader(context, record);
      assertCapacity(facts, choice!, handle);
      const acknowledged = options.acknowledgeFinalTransition === true;
      // Revocation preparation carries no acknowledgement: only an attestation
      // can be final, and the gateway's closed request shape rejects the key.
      const prepared = await call(action, { phase: "prepare", submission: mode,
        ...(options.revoke ? {} : { confirmation: options.confirmation, acknowledgeFinalTransition: acknowledged }) });
      // Whether this attestation is the final one is a chain fact, decided here
      // for both modes; the gateway's count and flag must agree with it, and
      // the signable or call is withheld only for the unacknowledged final one.
      const final = choice !== "revoke" && facts.submissionsUsed === ATTESTATION_CAP - 1;
      if (prepared.submissionsUsed !== facts.submissionsUsed || Boolean(prepared.finalAttestation) !== final) {
        throw invalidPreparation();
      }
      const summary = { submissionsUsed: facts.submissionsUsed, revocationAvailable: facts.currentUid !== ZERO_UID, finalAttestation: final };
      const withheld = mode === "sponsored" ? !prepared.signableTypedData : !prepared.call;
      if (withheld) {
        if (!final || acknowledged) throw invalidPreparation();
        return { orderHandle: record.handle, mode, ...summary,
          warning: { code: "FINAL_ATTESTATION", message: FINAL_ATTESTATION_WARNING },
          next: "Show the warning to the user. After explicit acceptance, repeat with --acknowledge-final-transition." };
      }
      if (final && !acknowledged) throw invalidPreparation();
      const warning = final ? { code: "FINAL_ATTESTATION", message: FINAL_ATTESTATION_WARNING } : undefined;

      if (mode === "direct") {
        const validated = validateDirectCall(prepared.call, facts, choice!, context.profile.easAddress);
        const expected = await expectedBinding(context, facts, validated, signer);
        const tracked: ConfirmationTxRecord = {
          action: validated.action,
          callHash: canonicalHash(validated.call),
          expected,
          state: "prepared",
          preparedAt: new Date().toISOString(),
        };
        updateOrder(record.intentId, { confirmationTx: tracked });
        return { orderHandle: record.handle, mode, action: validated.action, ...summary,
          ...(warning ? { warning } : {}),
          call: validated.call,
          callHash: tracked.callHash,
          note: "This CLI validated the call against chain facts and sends no transaction.",
          next: "Submit the call with the wallet's own tool (for the Circle agent wallet, the circle CLI). " +
            `Then record the hash: daski order confirm ${handle} --tx <hash>, and verify it: ` +
            `daski order confirm ${handle} --check.` };
      }

      const typedData = validateConfirmationPreparation(prepared, facts, choice!, acknowledged);
      if (typeof prepared.preparationId !== "string") throw invalidPreparation();
      const signature = await signer.signTypedData(typedData);
      submission = { action, request: { phase: "submit", submission: "sponsored", preparationId: prepared.preparationId, signature } };
      updateOrder(record.intentId, { confirmationSubmission: submission, readCapability: undefined });
    }
    try {
      const result = await call(submission.action, submission.request);
      updateOrder(record.intentId, { confirmationSubmission: undefined, readCapability: undefined });
      return { orderHandle: record.handle, mode: "sponsored", ...result };
    } catch (error) {
      if (error instanceof CliError && error.code === "CONFIRMATION_SUBMISSION_PENDING") return {
        orderHandle: record.handle, mode: "sponsored", status: "pending", preparationId: submission.request.preparationId,
        next: `Run daski order confirm ${options.handle} --resume to check the same submission.` };
      if (error instanceof CliError && REFUSED_BEFORE_ADMISSION.has(error.code)) {
        updateOrder(record.intentId, { confirmationSubmission: undefined });
      }
      throw error;
    }
  });
}

function assertCapacity(facts: ConfirmationFacts, choice: Choice, handle: string): void {
  if (choice === "revoke") {
    if (facts.currentUid === ZERO_UID) throw new CliError({
      code: "DASKI_CONFIRMATION_NOT_ACTIVE",
      message: "No confirmation is active for this order, so there is nothing to revoke.",
      remediation: `Submit one with daski order confirm ${handle} --choice Confirmed|NotConfirmed.`,
    });
    return;
  }
  if (facts.submissionsUsed >= ATTESTATION_CAP) throw new CliError({
    code: "DASKI_CONFIRMATION_CAP_REACHED",
    message: `All ${ATTESTATION_CAP} confirmations for this order have been submitted; none can be added.`,
    remediation: facts.currentUid === ZERO_UID
      ? "No confirmation is active and no further one can be submitted for this order."
      : `The current confirmation can still be revoked: daski order revoke-confirmation ${handle}.`,
  });
}

function isPendingDirect(tracked: ConfirmationTxRecord | undefined): boolean {
  return tracked !== undefined && (tracked.state === "prepared" || tracked.state === "submitted");
}

function directPending(handle: string, tracked: ConfirmationTxRecord): CliError {
  return new CliError({
    code: "DASKI_CONFIRMATION_TX_PENDING",
    message: `A direct ${tracked.action} for this order is ${tracked.state}` +
      (tracked.txHash ? ` (transaction ${tracked.txHash})` : "") + "; a new preparation is refused until it is resolved.",
    remediation: tracked.txHash
      ? `Verify it with daski order confirm ${handle} --check. If the transaction reverted, clear it with --abandon.`
      : `Submit the prepared call and record it with daski order confirm ${handle} --tx <hash>, or clear it with --abandon.`,
  });
}

/** What a receipt must later bind to: the values the prepared call commits to. */
async function expectedBinding(
  context: CommandContext,
  facts: ConfirmationFacts,
  validated: ReturnType<typeof validateDirectCall>,
  signer: { getAddress(): Promise<Address> },
): Promise<ConfirmationTxExpected> {
  if (validated.action === "attest") {
    return { schema: facts.schemaUid, recipient: facts.recipient, refUID: facts.currentUid, dataHash: keccak256(validated.data!) };
  }
  // A revocation binds to the attestation it revokes, read now so the receipt
  // can be matched later without trusting the event alone.
  const current = await readAttestation(context.chain, facts.eas, facts.currentUid);
  const payer = getAddress(await signer.getAddress());
  if (!sameHex(current.uid, facts.currentUid) || !sameHex(current.schema, facts.schemaUid) ||
      !isAddressEqual(current.attester, payer)) throw invalidCall("the current confirmation is not this payer's");
  return { schema: facts.schemaUid, recipient: getAddress(current.recipient), refUID: current.refUID,
    dataHash: keccak256(current.data), uid: facts.currentUid };
}

async function readAttestation(chain: ChainReader, eas: Address, uid: Hex, blockNumber?: bigint): Promise<Attestation> {
  return chain.readContract<Attestation>({ address: eas, abi: EAS_ABI, functionName: "getAttestation", args: [uid],
    ...(blockNumber === undefined ? {} : { blockNumber }) });
}

// -- direct record management: --tx, --check, --abandon -------------------------

async function manageDirectRecord(context: CommandContext, record: OrderRecord, options: ConfirmationOptions): Promise<Record<string, unknown>> {
  const handle = record.handle ?? options.handle;
  const tracked = record.confirmationTx;
  const flags = [options.tx !== undefined, options.check === true, options.abandon === true].filter(Boolean).length;
  if (flags > 1 || options.resume || options.confirmation !== undefined) {
    throw new CliError({ code: "DASKI_CONFIRMATION_FLAGS_CONFLICT",
      message: "--tx, --check and --abandon each stand alone.",
      remediation: "Pass exactly one of them, without --choice or --resume." });
  }
  if (!tracked || tracked.state === "abandoned") {
    throw new CliError({ code: "DASKI_CONFIRMATION_TX_NOT_PREPARED",
      message: "No direct confirmation is being tracked for this order.",
      remediation: `Prepare one first: daski order confirm ${handle} --choice Confirmed|NotConfirmed (or daski order revoke-confirmation ${handle}).` });
  }
  const base = { orderHandle: record.handle, mode: "direct", action: tracked.action, callHash: tracked.callHash };
  const cancelsNothing = "This cancels nothing at the wallet: a transaction already sent is unaffected.";

  if (options.tx !== undefined) {
    if (!HEX32.test(options.tx)) throw new CliError({ code: "DASKI_CONFIRMATION_TX_MALFORMED",
      message: `--tx expects a 32-byte transaction hash, got "${options.tx}".`,
      remediation: "Pass the hash the wallet's tool reported, e.g. --tx 0x<64 hex characters>." });
    const txHash = options.tx.toLowerCase() as Hex;
    if (tracked.state === "observed") throw new CliError({ code: "DASKI_CONFIRMATION_TX_ALREADY_RECORDED",
      message: `This confirmation was already observed as ${tracked.txHash}.`,
      remediation: "Nothing to record. Prepare a new confirmation if another submission is wanted." });
    let corrected: { previousTxHash: Hex; reason: string } | undefined;
    if (tracked.state === "submitted" && tracked.txHash !== txHash) {
      // Replacing a recorded hash is a journal correction, allowed only once the
      // recorded transaction is canonical, finalized, and provably not the
      // prepared call.
      const unrelated = await provenUnrelated(context, tracked, handle);
      if (!unrelated) throw new CliError({ code: "DASKI_CONFIRMATION_TX_ALREADY_RECORDED",
        message: `Transaction ${tracked.txHash} is already recorded for this confirmation.`,
        remediation: `Verify it with daski order confirm ${handle} --check. A recorded hash is replaced only once its ` +
          "transaction is finalized and carries no event that binds to the prepared call; if it reverted, --abandon clears it first." });
      corrected = { previousTxHash: tracked.txHash!, reason: unrelated };
    }
    updateOrder(record.intentId, { confirmationTx: { ...tracked, txHash, state: "submitted" } });
    return { ...base, txHash, state: "submitted", verification: "recorded, not yet verified",
      ...(corrected ? { corrected, note: `The previously recorded transaction is finalized and unrelated to the prepared call (${corrected.reason}); the record now tracks the new hash. ${cancelsNothing}` } : {}),
      next: `Run daski order confirm ${handle} --check once the transaction is mined. Finality on Base takes minutes to tens of minutes.` };
  }

  if (options.check) return checkDirectRecord(context, record, tracked, handle, base);

  // --abandon: only when nothing recorded can still execute: no hash, a
  // revert in a finalized canonical block, or a finalized canonical
  // transaction provably not this call. A revert in an unfinalized block
  // settles nothing: a reorganization can re-include the transaction against
  // different state.
  let unrelatedReceipt: string | undefined;
  if (tracked.txHash) {
    const receipt = await context.chain.getTransactionReceipt(tracked.txHash);
    if (!receipt) throw new CliError({ code: "DASKI_CONFIRMATION_TX_MAY_EXECUTE",
      message: `Transaction ${tracked.txHash} has no receipt yet and may still execute.`,
      remediation: `Wait for it to be mined, then run daski order confirm ${handle} --check. Abandon is allowed only when the receipt is a finalized revert or the transaction is finalized and unrelated to this call.` });
    if (receipt.status === "success") {
      const unrelated = await provenUnrelated(context, tracked, handle, receipt);
      if (!unrelated) throw new CliError({ code: "DASKI_CONFIRMATION_TX_MAY_EXECUTE",
        message: `Transaction ${tracked.txHash} executed; the record cannot be abandoned.`,
        remediation: `Verify it with daski order confirm ${handle} --check.` });
      unrelatedReceipt = unrelated;
    } else {
      const view = await receiptView(context, receipt);
      if (!view.final || !view.canonical) throw new CliError({ code: "DASKI_CONFIRMATION_TX_MAY_EXECUTE",
        message: `Transaction ${tracked.txHash} reverted in ${view.final
          ? "a block that is not the chain's canonical block at its height"
          : `block ${receipt.blockNumber}, which is not finalized yet (finalized ${view.finalized})`}; it may still be re-included.`,
        remediation: `Wait for finality (minutes to tens of minutes on Base), then run daski order confirm ${handle} --check and --abandon.` });
    }
  }
  updateOrder(record.intentId, { confirmationTx: { ...tracked, state: "abandoned" } });
  return { ...base, ...(tracked.txHash ? { txHash: tracked.txHash } : {}), state: "abandoned",
    ...(unrelatedReceipt ? { unrelatedReceipt } : {}),
    note: `Local tracking was cleared. ${cancelsNothing}` +
      (unrelatedReceipt ? " If the prepared call was sent under another hash, prepare nothing new: record that hash instead." : ""),
    next: `Prepare again when ready: daski order confirm ${handle} --choice Confirmed|NotConfirmed.` };
}

/** The receipt's block in the profile RPC's finalized view. */
interface ReceiptView {
  /** The RPC's own finalized height. */
  finalized: bigint;
  /** The receipt's height is at or below that, so the RPC's canonical block at it cannot change. */
  final: boolean;
  /** Read only when final: the RPC's canonical block at the receipt's height is the receipt's block. */
  canonical: boolean;
}

/**
 * The one finalized view every canonical read uses (R04): the RPC's finalized
 * height is read first, and the canonical block at the receipt's height is
 * compared only when that height is already final there, so the comparison
 * cannot be overtaken by a reorganization. The RPC is one consistent node;
 * a balancer over unsynchronized nodes is outside this guarantee.
 */
async function receiptView(context: CommandContext, receipt: TransactionReceiptLike): Promise<ReceiptView> {
  const finalized = await context.chain.getFinalizedBlockNumber();
  if (receipt.blockNumber > finalized) return { finalized, final: false, canonical: false };
  const canonical = sameHex(await context.chain.getBlockHash(receipt.blockNumber), receipt.blockHash);
  return { finalized, final: true, canonical };
}

/**
 * The reason a recorded, successful transaction is provably not the prepared
 * call, or null when it is (or may be) this call. The finalized view is
 * established first; only a finalized canonical receipt none of whose
 * candidate events binds is unrelated. A related receipt keeps the record;
 * an unrelated one that is not yet finalized and canonical is refused until
 * it is, so a reorganization cannot turn a correction into a lost call.
 */
async function provenUnrelated(context: CommandContext, tracked: ConfirmationTxRecord, handle: string,
  known?: TransactionReceiptLike): Promise<string | null> {
  if (!tracked.txHash) return null;
  const receipt = known ?? await context.chain.getTransactionReceipt(tracked.txHash);
  if (!receipt || receipt.status !== "success") return null;
  const view = await receiptView(context, receipt);
  if (!view.final) throw new CliError({ code: "DASKI_CONFIRMATION_TX_UNFINALIZED",
    message: `Transaction ${tracked.txHash} is not finalized yet (block ${receipt.blockNumber}, finalized ${view.finalized}); whether it carried this confirmation cannot be settled.`,
    remediation: `Wait for finality (minutes to tens of minutes on Base), then repeat the same daski order confirm ${handle} command.` });
  if (!view.canonical) throw new CliError({ code: "DASKI_CONFIRMATION_TX_UNFINALIZED",
    message: `Transaction ${tracked.txHash} was carried by a block that is not the chain's canonical block at height ${receipt.blockNumber}.`,
    remediation: `The transaction may be re-included or dropped. Wait, then repeat the same daski order confirm ${handle} command.` });
  try {
    await boundConfirmationUid(context, receipt, tracked, view.finalized);
    return null;
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "DASKI_CONFIRMATION_RECEIPT_UNRELATED") throw error;
    return error.message;
  }
}

async function checkDirectRecord(context: CommandContext, record: OrderRecord, tracked: ConfirmationTxRecord,
  handle: string, base: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (tracked.state === "observed") {
    return { ...base, txHash: tracked.txHash, uid: tracked.uid, state: "observed", note: "Already observed; nothing further to verify." };
  }
  if (!tracked.txHash) throw new CliError({ code: "DASKI_CONFIRMATION_TX_NOT_RECORDED",
    message: "The prepared call has no transaction hash recorded yet.",
    remediation: `Submit it with the wallet's own tool, then record the hash: daski order confirm ${handle} --tx <hash>.` });
  const receipt = await context.chain.getTransactionReceipt(tracked.txHash);
  if (!receipt) {
    return { ...base, txHash: tracked.txHash, state: "submitted", receipt: "pending",
      next: `The transaction is not mined yet. Run daski order confirm ${handle} --check again shortly.` };
  }
  const view = await receiptView(context, receipt);
  const later = `Finality on Base takes minutes to tens of minutes. Run daski order confirm ${handle} --check again later.`;
  if (receipt.status !== "success") {
    const settled = view.final && view.canonical;
    return { ...base, txHash: tracked.txHash, state: "submitted", receipt: "reverted", revertFinal: settled,
      next: settled
        ? `The transaction reverted in a finalized block. Clear the record with daski order confirm ${handle} --abandon, then prepare again.`
        : `The transaction reverted, but ${view.final ? "the block that carried it is not the chain's canonical block" : "its block is not finalized yet"}; it may still be re-included. Run daski order confirm ${handle} --check again later, then --abandon.` };
  }
  if (!view.final) {
    return { ...base, txHash: tracked.txHash, state: "submitted", receipt: "success",
      verification: `the receipt's block ${receipt.blockNumber} is not finalized on the profile's RPC yet (finalized ${view.finalized})`, next: later };
  }
  if (!view.canonical) {
    return { ...base, txHash: tracked.txHash, state: "submitted", receipt: "reorganized",
      verification: `the block that carried the transaction is not the chain's canonical block at height ${receipt.blockNumber}`,
      next: `The transaction may be re-included or dropped. Run daski order confirm ${handle} --check again later.` };
  }
  const uid = await boundConfirmationUid(context, receipt, tracked, view.finalized);
  const check = await callAuthorizedLifecycleTool({
    client: context.client, signer: context.signer,
    toolName: tracked.action === "attest" ? "daski_confirm_delivery" : "daski_revoke_delivery_confirmation",
    action: tracked.action === "attest" ? "confirmation" : "revoke-confirmation",
    orderHandle: handle, request: { phase: "check", submission: "direct" },
    chainId: context.profile.chainId, gatewayUrl: context.profile.gatewayUrl,
  });
  const notYet = (verification: string) => ({ ...base, txHash: tracked.txHash, uid, state: "submitted", receipt: "success",
    verification, check, next: later });
  const anchor = finalizedAnchor(check);
  if (!anchor || anchor.number < receipt.blockNumber) {
    return notYet("the receipt, the EAS event and the attestation match the prepared call; the gateway's finalized read is not past the receipt's block yet");
  }
  // The gateway's finalized block must be this RPC's canonical block at its
  // height; the receipt's block, final on this RPC at a lower or equal
  // height, is then its ancestor, so the receipt's effect is what the anchor
  // shows. The receipt's block is compared once more against the same view
  // so an RPC that contradicted itself between the reads cannot pass.
  if (!sameHex(await context.chain.getBlockHash(anchor.number), anchor.hash)) {
    return notYet(`the gateway's finalized block ${anchor.number} is not the chain's canonical block at that height as the profile's RPC reports it`);
  }
  if (!sameHex(await context.chain.getBlockHash(receipt.blockNumber), receipt.blockHash)) {
    return { ...base, txHash: tracked.txHash, uid, state: "submitted", receipt: "reorganized", check,
      verification: `the profile's RPC changed its canonical block at height ${receipt.blockNumber} between reads`,
      next: `Run daski order confirm ${handle} --check again later.` };
  }
  if (!finalizedReflects(check, tracked, uid)) {
    return notYet("the receipt, the EAS event and the attestation match the prepared call; the gateway's finalized read does not show it yet");
  }
  updateOrder(record.intentId, { confirmationTx: { ...tracked, uid, state: "observed" }, readCapability: undefined });
  return { ...base, txHash: tracked.txHash, uid, state: "observed", receipt: "success",
    observedBlock: receipt.blockNumber.toString(), finalizedBlock: anchor.number.toString(), check };
}

function unrelatedReceipt(reason: string): CliError {
  return new CliError({
    code: "DASKI_CONFIRMATION_RECEIPT_UNRELATED",
    message: `The recorded transaction does not carry this confirmation: ${reason}.`,
    remediation:
      "The record stays submitted. If the hash was recorded by mistake, record the right one with " +
      "--tx <hash> or clear the record with --abandon; a reverted transaction can be abandoned once its " +
      "block is finalized. Otherwise check the wallet's tool for the transaction that carried the prepared call.",
  });
}

/**
 * Every Attested or Revoked event the pinned EAS emitted in the receipt for
 * this payer and the confirmation schema (for a revocation, of the revoked
 * uid). A smart-wallet batch can carry several orders' events, so all are
 * candidates.
 */
function candidateEventUids(receipt: TransactionReceiptLike, easAddress: Address, tracked: ConfirmationTxRecord, payer: Address): { uids: Hex[]; sawEas: boolean } {
  const wanted = tracked.action === "attest" ? "Attested" : "Revoked";
  const uids: Hex[] = [];
  let sawEas = false;
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, easAddress)) continue;
    sawEas = true;
    let decoded;
    try {
      decoded = decodeEventLog({ abi: EAS_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    if (decoded.eventName !== wanted) continue;
    const args = decoded.args as { recipient: Address; attester: Address; uid: Hex; schemaUID: Hex };
    if (!sameHex(args.schemaUID, tracked.expected.schema) || !isAddressEqual(args.attester, payer)) continue;
    if (tracked.action === "revoke" && !sameHex(args.uid, tracked.expected.uid ?? "")) continue;
    uids.push(args.uid);
  }
  return { uids, sawEas };
}

/**
 * The uid among the receipt's candidate events whose attestation binds to
 * the prepared call, or DASKI_CONFIRMATION_RECEIPT_UNRELATED when none does.
 * Attestations are read pinned to the RPC's finalized height, the same view
 * the receipt was placed in; a uid commits to every field the binding checks,
 * and a revocation time only ever moves from zero, so that view is complete.
 */
async function boundConfirmationUid(context: CommandContext, receipt: TransactionReceiptLike, tracked: ConfirmationTxRecord,
  finalizedBlock: bigint): Promise<Hex> {
  const easAddress = context.profile.easAddress;
  const { uids, sawEas } = candidateEventUids(receipt, easAddress, tracked, context.payerAddress);
  const wanted = tracked.action === "attest" ? "Attested" : "Revoked";
  if (uids.length === 0) {
    throw unrelatedReceipt(sawEas
      ? `no ${wanted} event for the confirmation schema with the payer as attester`
      : `no log was emitted by the pinned EAS ${easAddress}`);
  }
  const mismatches: string[] = [];
  for (const uid of uids) {
    const mismatch = bindingMismatch(await readAttestation(context.chain, easAddress, uid, finalizedBlock), tracked, uid);
    if (!mismatch) return uid;
    mismatches.push(mismatch);
  }
  throw unrelatedReceipt(mismatches.length === 1
    ? mismatches[0]!
    : `none of the ${uids.length} candidate events binds to the prepared call (${mismatches.join("; ")})`);
}

/** Events do not carry refUID, recipient or data; the attestation itself must. Returns the first mismatch, or null. */
function bindingMismatch(attestation: Attestation, tracked: ConfirmationTxRecord, uid: Hex): string | null {
  const expected = tracked.expected;
  if (!sameHex(attestation.uid, uid)) return "the EAS holds no attestation for the event's uid";
  if (!sameHex(attestation.schema, expected.schema)) return "the attestation's schema differs";
  if (!sameHex(attestation.refUID, expected.refUID)) return "the attestation's refUID differs from the prepared call";
  if (!isAddressEqual(attestation.recipient, expected.recipient)) return "the attestation's recipient differs from the prepared call";
  if (!sameHex(keccak256(attestation.data), expected.dataHash)) return "the attestation's data differs from the prepared call";
  if (tracked.action === "revoke" && attestation.revocationTime === 0n) return "the attestation is not revoked";
  return null;
}

/** The gateway's finalized block view (`{ number, hash }`, number a decimal string), or null. */
function finalizedAnchor(check: Record<string, unknown>): { number: bigint; hash: Hex } | null {
  const anchor = check.finalizedBlock;
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return null;
  const { number, hash } = anchor as { number?: unknown; hash?: unknown };
  if (typeof number !== "string" || !/^\d+$/.test(number) || typeof hash !== "string" || !HEX32.test(hash)) return null;
  return { number: BigInt(number), hash: hash.toLowerCase() as Hex };
}

/**
 * The gateway's finalized read shows the transaction's effect: the current
 * uid is the new attestation (attest) or no longer the revoked one (revoke).
 * The caller has established that the anchor is at or past the receipt's
 * block and canonical on the profile's RPC.
 */
function finalizedReflects(check: Record<string, unknown>, tracked: ConfirmationTxRecord, uid: Hex): boolean {
  const finalized = check.confirmedCurrent;
  if (!finalized || typeof finalized !== "object" || Array.isArray(finalized)) return false;
  const current = (finalized as { currentUid?: unknown }).currentUid;
  if (typeof current !== "string") return false;
  return tracked.action === "attest" ? sameHex(current, uid) : !sameHex(current, tracked.expected.uid ?? "");
}

/** Read the deployment pins separately, then verify the selected order and EAS nonce on chain. */
export async function readConfirmationFacts(context: CommandContext, record: OrderRecord): Promise<ConfirmationFacts> {
  const status = await readWithCapability(context, record, { toolName: "daski_get_order_status", action: "status", request: {} });
  if (typeof status.orderKey !== "string" || !HEX32.test(status.orderKey)) throw invalidPreparation();
  const pins = (await context.metadata()).confirmationSigning;
  if (!pins || pins.chainId !== context.profile.chainId) throw invalidPreparation();
  if (!isAddressEqual(pins.eas, context.profile.easAddress)) throw easAddressMismatch(pins.eas, context.profile.easAddress, context.profile.chainId);
  const orderKey = status.orderKey as Hex;
  const [current, nonce] = await Promise.all([
    context.chain.readContract<{
      orderKey: Hex; providerAgentId: bigint; payer: Address; providerOwner: Address; providerAgentWallet: Address;
      confirmationSubmissions: number; outcomeRecorded: boolean; reputationEligible: boolean; currentConfirmationUid: Hex;
    }>({ address: pins.reputationStorage, abi: REPUTATION_ABI, functionName: "getRecord", args: [orderKey] }),
    context.chain.readContract<bigint>({ address: pins.eas, abi: EAS_ABI, functionName: "getNonce", args: [context.payerAddress] }),
  ]);
  if (current.orderKey !== orderKey || getAddress(current.payer) !== context.payerAddress ||
      String(current.providerAgentId) !== record.providerAgentId || !current.outcomeRecorded || !current.reputationEligible) throw invalidPreparation();
  return { chainId: pins.chainId, eas: pins.eas, schemaUid: pins.schemaUid, reputationStorage: pins.reputationStorage, orderKey,
    recipient: getAddress(current.providerAgentWallet === ZERO_ADDRESS ? current.providerOwner : current.providerAgentWallet),
    currentUid: current.currentConfirmationUid, nonce: nonce.toString(), submissionsUsed: Number(current.confirmationSubmissions) };
}
