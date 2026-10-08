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
 * for the wallet's own tool to submit. Preparation sends no transaction. An explicit, callHash-approved direct
 * submission uses the separate bounded Circle adapter when qualified.
 *
 * A direct submission is tracked in `orders.json`: `--tx <hash>` records the
 * hash immediately as `submitted` (recorded, unverified) so a restart never
 * loses the association; `--check` advances it to `observed` only when the
 * receipt succeeded, the pinned EAS emitted the matching event with the payer
 * as attester, `getAttestation` binds the attestation to what was prepared,
 * and the gateway's final read, anchored at or past the receipt's block,
 * shows the result. "Final" is the profile chain's finality tag, `safe` on
 * the sandbox and `finalized` on Base mainnet, the rule the gateway applies
 * through CHAIN_FINALITY_TAG. Evidence is bound to one final view: the
 * profile's RPC must report the receipt's height as final before its
 * canonical block at that height is compared with the receipt's block (a
 * read below the RPC's own final height does not move without an L1
 * reorganization, which the sandbox accepts), attestations are read pinned
 * to that final height, and the gateway's final block must be that RPC's
 * canonical block at its height, so the receipt's block is a final ancestor
 * of the anchor. The RPC is taken as one consistent
 * node. A batched receipt may carry other orders' events first; every
 * candidate event is tried and the one whose attestation binds is taken.
 * `--abandon` clears the local record when no hash is recorded or the receipt
 * is a revert in a final canonical block, and cancels nothing at the
 * wallet. A hash recorded by mistake is corrected (replaced with `--tx`, or
 * cleared with `--abandon`) only once its transaction is final and
 * canonical and no candidate event binds to this call; a missing, pending,
 * not yet final, or matching receipt keeps the record.
 *
 * One order's journal is updated under a per-order lock: the read-check-write
 * of a preparation spans gateway and chain calls, and two concurrent
 * preparations must not both find nothing pending. The signer is resolved
 * before the lock, so no passphrase prompt runs inside it.
 */
import { randomUUID } from "node:crypto";
import {
  circleProgressOf, createCircleReviewAdapter, type CircleLookup, type DirectReviewSubmissionAdapter,
} from "../signers/circleReview.js";
import type { CircleReviewProgress } from "../signers/circleReviewTransport.js";
import { circleChainName, loginHint } from "../signers/circleAgent.js";
import { canonicalHash, type SignerDescription, type TypedDataRequest } from "@daski/x402-scheme";
import {
  decodeEventLog, encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, isAddressEqual, keccak256,
  parseAbi, parseAbiParameters, type Address, type Hex,
} from "viem";
import { discoverEasReviewProfile, type EasReviewProfile } from "../chain/easProfiles.js";
import type { ChainReader, TransactionReceiptLike } from "../chain/reader.js";
import { finalityTagFor, readContracts } from "../chain/reader.js";
import { CliError } from "../cli/errors.js";
import type { CommandContext } from "../context.js";
import { reviewNeedsOperator } from "../gateway/client.js";
import { callAuthorizedLifecycleTool } from "../gateway/lifecycle.js";
import { confirmationPinsMissing, easAddressMismatch } from "../gateway/metadata.js";
import {
  findByIntent, updateOrder, withOrderLock,
  type ConfirmationTxExpected, type ConfirmationTxRecord, type OrderRecord,
} from "../store/orders.js";
import { readWithCapability, type OrderOptions } from "./order.js";

export interface ConfirmationOptions extends OrderOptions {
  confirmation?: string | undefined;
  revoke?: boolean | undefined;
  resume?: boolean | undefined;
  reaffirm?: boolean | undefined;
  estimate?: boolean | undefined;
  submit?: boolean | undefined;
  approveCallHash?: string | undefined;
  qualifyCircleExecution?: boolean | undefined;
  supersedesOperationId?: string | undefined;
  supersedesPreparationId?: string | undefined;
  acknowledgeSameNonce?: boolean | undefined;
  acknowledgeFinalTransition?: boolean | undefined;
  /** `sponsored` or `direct`; defaults by signer. */
  submission?: string | undefined;
  /** Direct mode: record the hash the wallet's tool reported. */
  tx?: string | undefined;
  /** Direct mode: verify the recorded transaction and the final state. */
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
  /** Independently qualified deployment identity. */
  profile?: EasReviewProfile;
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

/** The closed call the gateway returns in direct mode: exactly these six fields, `value` always "0". */
export interface DirectCall {
  chainId: number;
  to: Address;
  function: "attest" | "revoke";
  request: Record<string, unknown>;
  calldata: Hex;
  value: "0";
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
  const profile = facts.profile;
  if (!profile) throw invalidPreparation();
  const deadline = Number(proposed?.message?.deadline);
  const admissionExpiry = typeof prepared.admissionExpiresAt === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(prepared.admissionExpiresAt)
    ? Date.parse(prepared.admissionExpiresAt) / 1000 : Number(prepared.admissionExpiresAt);
  if (prepared.profileId !== profile.id || prepared.domainVersion !== profile.domainVersion ||
      !Number.isSafeInteger(admissionExpiry) || admissionExpiry <= now || admissionExpiry > now + 330 ||
      (profile.signedDeadline ? prepared.signedDeadline !== String(deadline)
        : prepared.signedDeadline !== null || proposed?.message?.deadline !== undefined)) throw invalidPreparation();
  const final = choice !== "revoke" && facts.submissionsUsed === ATTESTATION_CAP - 1;
  if (!proposed || prepared.orderKey !== facts.orderKey || prepared.currentRefUid !== facts.currentUid ||
      prepared.submissionsUsed !== facts.submissionsUsed || Boolean(prepared.finalAttestation) !== final ||
      (choice !== "revoke" && facts.submissionsUsed >= ATTESTATION_CAP) ||
      (choice === "revoke" && facts.currentUid === ZERO_UID) || (final && !acknowledged) ||
      (profile.signedDeadline && (!Number.isSafeInteger(deadline) || deadline <= now || deadline > now + 330))) {
    throw invalidPreparation();
  }
  const common = { schema: facts.schemaUid, nonce: facts.nonce, ...(profile.signedDeadline ? { value: "0", deadline: String(deadline) } : {}) };
  const expected: TypedDataRequest = { domain: { name: "EAS", version: profile.domainVersion, chainId: facts.chainId, verifyingContract: facts.eas },
    types: choice === "revoke" ? { Revoke: revokeTypes.Revoke.filter(field => profile.signedDeadline || (field.name !== "deadline" && field.name !== "value")) }
      : { Attest: attestTypes.Attest.filter(field => profile.signedDeadline || (field.name !== "deadline" && field.name !== "value")) }, primaryType: choice === "revoke" ? "Revoke" : "Attest",
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
  if (!exactKeys(value, ["chainId", "to", "function", "request", "calldata", "value"])) throw invalidCall("unexpected call shape");
  const call = value;
  if (call.value !== "0") throw invalidCall(`value ${String(call.value)} is not zero`);
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
      request: call.request, calldata: (call.calldata as string).toLowerCase() as Hex, value: "0",
    },
    data,
  };
}

export async function runConfirmation(options: ConfirmationOptions): Promise<Record<string, unknown>> {
  const { withOrder } = await import("./order.js");
  return withOrder(options, (context, record) => confirmOrder(context, record, options));
}

/** The record as the store holds it now; the caller's copy may predate another process's write. */
function latest(record: OrderRecord): OrderRecord {
  return findByIntent(record.intentId) ?? record;
}

export async function confirmOrder(context: CommandContext, record: OrderRecord, options: ConfirmationOptions,
  factsReader = readConfirmationFacts,
  directAdapter: () => DirectReviewSubmissionAdapter = createCircleReviewAdapter): Promise<Record<string, unknown>> {
  const handle = record.handle ?? options.handle;
  if (options.qualifyCircleExecution && !options.submit) throw new CliError({
    code: "DASKI_CIRCLE_CONFORMANCE_REFUSED", message: "Circle conformance qualification requires explicit submission.",
    remediation: "Use only on testnet with DASKI_CONFORMANCE_SPEND_OK=1 and --submit --approve-call <callHash>." });
  const directAction = Boolean(options.estimate || options.submit || (options.resume && (options.submission === "direct" || record.confirmationTx?.vendor)));
  if (directAction) {
    const signer = await context.resolveSigner();
    return withOrderLock(record.intentId, () => manageCircleReview(context, latest(record), options, signer.describe(), factsReader, directAdapter));
  }
  if (options.tx !== undefined || options.check || options.abandon) {
    // Only --check signs (the gateway's check authorization); the signer is
    // resolved before the lock so a passphrase prompt never runs inside it.
    const signer = options.check ? await context.resolveSigner() : undefined;
    return withOrderLock(record.intentId, () => {
      const current = latest(record);
      if (options.check && !options.tx && !options.abandon) {
        const target = checkTarget(current.confirmationTx, options.submission, signer!.describe());
        if (target.kind === "gateway") return checkGatewayReview(context, current, handle, target.submission);
      }
      return manageDirectRecord(context, current, options);
    });
  }
  const choice: Choice | undefined = options.revoke ? "revoke"
    : options.confirmation === "Confirmed" || options.confirmation === "NotConfirmed" ? options.confirmation : undefined;
  if ((options.reaffirm || options.resume) && options.confirmation !== undefined) throw new CliError({
    code: "DASKI_CONFIRMATION_FLAGS_INVALID", message: "Resume or reaffirm uses the saved review; it cannot change your choice.",
    remediation: "Omit --choice/--revoke for recovery. To change a live authorization, explicitly supersede it with --acknowledge-same-nonce." });
  if (options.reaffirm && options.resume) throw new CliError({
    code: "DASKI_CONFIRMATION_FLAGS_INVALID", message: "Choose either resume or reaffirm.",
    remediation: "Resume checks the saved submission; reaffirm explicitly opens a new relay window." });
  if (!options.resume && !options.reaffirm && choice === undefined) {
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
    if (record.confirmationSubmission && !options.resume && !options.reaffirm && !options.acknowledgeSameNonce) throw new CliError({ code: "DASKI_CONFIRMATION_PENDING",
      message: "A review submission for this order is awaiting reconciliation.", remediation: `Run daski order confirm ${options.handle} --resume.` });
    let submission = record.confirmationSubmission;
    if (options.revoke && (options.resume || options.reaffirm) && submission?.action !== "revoke-confirmation") throw invalidPreparation();
    const superseding = options.supersedesOperationId !== undefined || options.supersedesPreparationId !== undefined;
    if (superseding !== Boolean(options.acknowledgeSameNonce) ||
        (options.supersedesOperationId && options.supersedesPreparationId) ||
        (superseding && (options.resume || options.reaffirm))) throw new CliError({
      code: "DASKI_CONFIRMATION_SUPERSESSION_INVALID", message: "Same-nonce replacement requires one prior operation or preparation and explicit acknowledgement.",
      remediation: "Pass --supersedes-operation <id> or --supersedes-preparation <id> with --acknowledge-same-nonce and your chosen review. Any previously signed alternative may execute first." });
    if (superseding && submission) {
      const matches = options.supersedesOperationId ? submission.operationId === options.supersedesOperationId
        : submission.request.preparationId === options.supersedesPreparationId;
      if (!matches) throw invalidPreparation();
      // Preserve the old signed alternative; it remains executable until its nonce is consumed.
      updateOrder(record.intentId, { confirmationHistory: [...(record.confirmationHistory ?? []),
        { submission, outcome: { disposition: "explicitly-superseded-still-live" }, archivedAt: new Date().toISOString() }] });
      submission = undefined;
    }
    if (options.reaffirm) {
      if (!submission?.operationId) throw new CliError({ code: "DASKI_CONFIRMATION_NOT_PENDING",
        message: "No admitted operation is saved for reaffirmation.", remediation: "Use --resume first to recover its operation ID." });
      // Fresh outer authorization binds the operation. Never create another inner signature.
      try {
        const result = await call(submission.action, { phase: "reaffirm", submission: "sponsored", reviewProtocol: 2, operationId: submission.operationId });
        return { orderHandle: handle, mode: "sponsored", ...result };
      } catch (error) {
        if (error instanceof CliError && error.code === "CONFIRMATION_SUBMISSION_PENDING") {
          const gateway = error.details.gateway as { expected?: Record<string, unknown> } | undefined;
          if (gateway?.expected?.operationId !== submission.operationId) throw invalidPreparation();
          return unfinishedSponsoredReview(handle, context.profile.chainId, gateway.expected,
            { operationId: submission.operationId },
            `The saved signature was reaffirmed. Use daski order confirm ${handle} --resume to reconcile its execution.`);
        }
        throw error;
      }
    }
    if (!submission) {
      if (options.resume) throw new CliError({ code: "DASKI_CONFIRMATION_NOT_PENDING", message: "There is no pending review submission.",
        remediation: "Check order status, then supply the user's review choice if a new review is wanted." });
      const action = options.revoke ? "revoke-confirmation" : "confirmation";
      const mode = selectConfirmationMode(signer.describe(), options.submission);
      // One review journal per order: a direct submission still prepared or
      // submitted blocks any new preparation, sponsored included, so a second
      // review cannot be signed while the first is unresolved on chain. The
      // one exception is a call an earlier buyer prepared without saving it:
      // preparing it again restores it, and only when it is the same call.
      const legacy = mode === "direct" && isLegacyPrepared(record.confirmationTx) ? record.confirmationTx : undefined;
      if (isPendingDirect(record.confirmationTx) && !legacy) throw directPending(handle, record.confirmationTx!);
      if (superseding && mode !== "sponsored") throw new CliError({
        code: "DASKI_CONFIRMATION_SUPERSESSION_INVALID", message: "Same-nonce supersession requires a sponsored delegated review.",
        remediation: "Direct attest/revoke does not consume the delegated nonce. Reconcile the live authorization first." });
      const facts = await factsReader(context, record);
      assertCapacity(facts, choice!, handle);
      const acknowledged = options.acknowledgeFinalTransition === true;
      // Revocation preparation carries no acknowledgement: only an attestation
      // can be final, and the gateway's closed request shape rejects the key.
      const prepared = await call(action, { phase: "prepare", submission: mode,
        ...(mode === "sponsored" ? { reviewProtocol: 2 } : {}),
        ...(superseding ? { ...(options.supersedesOperationId ? { supersedesOperationId: options.supersedesOperationId } : { supersedesPreparationId: options.supersedesPreparationId }), acknowledgeSameNonce: true } : {}),
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
        const callHash = canonicalHash(validated.call);
        if (legacy && legacy.callHash !== callHash) throw new CliError({ code: "DASKI_CONFIRMATION_TX_PENDING",
          message: "A direct review an earlier buyer prepared is still saved, and this choice prepares a different call.",
          remediation: `If that call was never sent, clear it with daski order confirm ${handle} --abandon and prepare again. ` +
            `If it was sent, record its hash with daski order confirm ${handle} --tx <hash>.` });
        const expected = await expectedBinding(context, facts, validated, signer);
        const tracked: ConfirmationTxRecord = {
          action: validated.action,
          callHash,
          expected,
          call: validated.call,
          choice: choice!,
          state: "prepared",
          preparedAt: legacy?.preparedAt ?? new Date().toISOString(),
        };
        updateOrder(record.intentId, { confirmationTx: tracked });
        const circle = signer.describe().provider === "circle-agent";
        return { orderHandle: record.handle, mode, action: validated.action, ...summary,
          ...(warning ? { warning } : {}),
          call: validated.call,
          callHash: tracked.callHash,
          ...(legacy ? { restored: true } : {}),
          note: "This call was validated against chain facts. Preparation sends no transaction." +
            (legacy ? " It is the call an earlier buyer prepared for this order, now saved so it can be estimated and submitted." : ""),
          next: circle
            ? `Show the call to the user. Estimate it with daski order confirm ${handle} --estimate. Once the user approves this exact call ` +
              "and the gateway advertises confirmation.directReview.circleExecute, submit it with " +
              `daski order confirm ${handle} --submit --approve-call <callHash>, then run --resume until it is observed.`
            : `Submit the call with the wallet's own tool, then record the hash: daski order confirm ${handle} --tx <hash>, ` +
              `and verify it: daski order confirm ${handle} --check.` };
      }

      const typedData = validateConfirmationPreparation(prepared, facts, choice!, acknowledged);
      if (typeof prepared.preparationId !== "string") throw invalidPreparation();
      const signature = await signer.signTypedData(typedData);
      submission = { action, profileId: facts.profile!.id, typedData, request: { phase: "submit", submission: "sponsored", reviewProtocol: 2, preparationId: prepared.preparationId, signature } };
      updateOrder(record.intentId, { confirmationSubmission: submission, readCapability: undefined });
    }
    try {
      const result = await call(submission.action, submission.request);
      if (result.state !== "final" && result.state !== "completed") throw new CliError({
        code: "DASKI_CONFIRMATION_STATUS_UNKNOWN", message: "The gateway returned a review state that does not prove completion.",
        remediation: "The signed journal is preserved. Use --resume after the gateway reconciles the operation.",
        details: { gateway: result } });
      updateOrder(record.intentId, { confirmationSubmission: undefined, readCapability: undefined,
        confirmationHistory: [...(latest(record).confirmationHistory ?? []), { submission, outcome: result, archivedAt: new Date().toISOString() }] });
      return { orderHandle: record.handle, mode: "sponsored", ...result };
    } catch (error) {
      if (error instanceof CliError) {
        const gateway = error.details.gateway as Record<string, unknown> | undefined;
        const detail = (gateway?.expected && typeof gateway.expected === "object" ? gateway.expected : gateway) as Record<string, unknown> | undefined;
        if (submission.operationId && typeof detail?.operationId === "string" && detail.operationId !== submission.operationId) throw new CliError({
          code: "DASKI_CONFIRMATION_MISMATCH", message: "The gateway response identifies a different review operation.",
          remediation: "Keep the saved journal and reconcile its original operation." });
        submission = { ...submission,
          ...(typeof detail?.operationId === "string" ? { operationId: detail.operationId } : {}),
          lastDisposition: { code: error.code, ...(detail ?? {}) } };
        updateOrder(record.intentId, { confirmationSubmission: submission });
        if (error.code === "CONFIRMATION_SUBMISSION_FAILED" && detail?.safeRetired === true && typeof detail.operationId === "string") {
          updateOrder(record.intentId, { confirmationSubmission: undefined,
            confirmationHistory: [...(latest(record).confirmationHistory ?? []), { submission, outcome: detail, archivedAt: new Date().toISOString() }] });
        }
        // A delegated signature without a deadline (EAS 1.0.1, Base mainnet)
        // stays live while parked, so the gateway answers still-live for it.
        if (error.code === "CONFIRMATION_SUBMISSION_PENDING" ||
            (error.code === "CONFIRMATION_AUTHORIZATION_STILL_LIVE" && detail?.disposition === "operator_attention")) return unfinishedSponsoredReview(handle,
          context.profile.chainId, detail,
          { preparationId: submission.request.preparationId, operationId: submission.operationId },
          `Run daski order confirm ${options.handle} --resume to check the same submission.`);
      }
      if (error instanceof CliError && error.code === "CONFIRMATION_PREPARATION_STALE") {
        throw new CliError({
          code: error.code,
          message: error.message,
          remediation:
            "The gateway may already have admitted this submission before its preparation expired, " +
            `so the signed submission is kept. Keep running daski order confirm ${options.handle} --resume ` +
            `(or --check) until the gateway reports the operation's state; a new preparation is refused ` +
            "while this one is pending.",
          details: error.details,
        });
      }
      throw error;
    }
  });
}

async function manageCircleReview(context: CommandContext, record: OrderRecord, options: ConfirmationOptions,
  signer: SignerDescription, factsReader: typeof readConfirmationFacts,
  adapterFactory: () => DirectReviewSubmissionAdapter): Promise<Record<string, unknown>> {
  const tracked = record.confirmationTx;
  const handle = record.handle ?? options.handle;
  if (options.qualifyCircleExecution && (context.profile.chainId !== 84532 || process.env.DASKI_CONFORMANCE_SPEND_OK !== "1")) throw new CliError({
    code: "DASKI_CIRCLE_CONFORMANCE_REFUSED", message: "Candidate Circle execution is restricted to explicitly authorized Base Sepolia conformance.",
    remediation: "After testnet spending approval, set DASKI_CONFORMANCE_SPEND_OK=1 and approve the exact saved call. This flag never bypasses mainnet qualification." });
  if (Number(Boolean(options.estimate)) + Number(Boolean(options.submit)) + Number(Boolean(options.resume)) !== 1 ||
      options.tx || options.check || options.abandon || options.reaffirm || options.confirmation !== undefined) throw new CliError({
    code: "DASKI_CONFIRMATION_FLAGS_INVALID", message: "Choose exactly one direct review action.",
    remediation: "Use --estimate, --submit --approve-call <callHash>, or --resume separately." });
  if (!tracked?.call || !tracked.choice || tracked.state === "abandoned") throw new CliError({
    code: "DASKI_CONFIRMATION_NOT_PREPARED", message: "There is no saved validated call for this direct review.",
    remediation: isLegacyPrepared(tracked)
      ? `An earlier buyer prepared this review without saving its call. Prepare the same choice again (daski order confirm ${handle} --choice <the same choice>) to restore it, then approve its displayed callHash.`
      : "Prepare the chosen review first, then approve its displayed callHash." });
  if (record.confirmationSubmission) throw new CliError({ code: "DASKI_CONFIRMATION_PENDING",
    message: "A sponsored authorization is still unresolved.", remediation: "Reconcile it before executing a direct review." });
  if (signer.provider !== "circle-agent" || signer.accountType !== "contract") throw new CliError({
    code: "DASKI_CONFIRMATION_ADAPTER_UNSUPPORTED", message: "Automatic direct review submission is qualified only for the Circle agent adapter.",
    remediation: "Use your wallet's own tool for the validated call, then record --tx and --check." });
  if (canonicalHash(tracked.call) !== tracked.callHash || tracked.call.chainId !== context.profile.chainId ||
      !isAddressEqual(tracked.call.to, context.profile.easAddress) ||
      (tracked.vendor && (!isAddressEqual(tracked.vendor.wallet, context.payerAddress) || tracked.vendor.chainId !== context.profile.chainId))) throw invalidCall("saved call binding differs");
  if (options.resume) return resumeCircleReview(context, record, tracked, handle, adapterFactory);
  const adapter = adapterFactory();
  if (tracked.vendor || tracked.txHash || tracked.state !== "prepared") throw directPending(handle, tracked);
  const capabilities = (await context.metadata()).confirmation?.directReview;
  if (options.submit && capabilities?.circleExecute !== true && !options.qualifyCircleExecution) throw new CliError({
    code: "DASKI_CIRCLE_EXECUTION_NOT_QUALIFIED",
    message: "This gateway does not advertise Circle review execution (confirmation.directReview.circleExecute) yet.",
    remediation: `Nothing was sent and the prepared review is kept. Repeat --submit --approve-call ${tracked.callHash} once ` +
      "daski doctor --json shows gateway.confirmation.directReview.circleExecute: true; estimation is separate and sends nothing. " +
      "Do not send this call with circle wallet execute: only the buyer CLI journals the submission, so it can be resumed and verified." });
  if (options.estimate && capabilities?.circleEstimate !== true) throw new CliError({
    code: "DASKI_CIRCLE_ESTIMATE_NOT_QUALIFIED", message: "This gateway does not advertise the Circle estimation capability.",
    remediation: "Update the buyer and gateway before estimating this saved review." });
  if (options.submit && options.approveCallHash !== tracked.callHash) throw new CliError({
    code: "DASKI_CONFIRMATION_APPROVAL_REQUIRED", message: "Explicit approval must name this prepared callHash.",
    remediation: "Show the prepared review to the user, then pass --submit --approve-call <callHash> for that exact call." });
  const walletCode = await context.chain.getCode(context.payerAddress);
  if (!walletCode || walletCode === "0x") throw invalidCall("payer wallet is not deployed");
  const facts = await factsReader(context, record);
  validateDirectCall(tracked.call, facts, tracked.choice, context.profile.easAddress);
  const idempotencyKey = randomUUID();
  const request = { mode: options.estimate ? "estimate" as const : "execute" as const, wallet: context.payerAddress, call: tracked.call, idempotencyKey };
  if (options.estimate) return { orderHandle: handle, mode: "direct", state: "prepared", callHash: tracked.callHash,
    estimate: await adapter.estimate(request), note: "Estimation did not submit the review." };
  // The final height before anything is sent: the review cannot land below
  // it, so a later --resume can find it on chain without the vendor.
  const fromBlock = await context.chain.getFinalBlockNumber();
  const started: ConfirmationTxRecord = { ...tracked, state: "submitted", vendor: {
    provider: "circle-agent", packageVersion: adapter.packageVersion, idempotencyKey, wallet: context.payerAddress,
    chainId: context.profile.chainId, conformanceCandidate: options.qualifyCircleExecution === true, submissionStarted: new Date().toISOString(),
    fromBlock: fromBlock.toString(), hashes: [] } };
  updateOrder(record.intentId, { confirmationTx: started });
  let result: Awaited<ReturnType<DirectReviewSubmissionAdapter["submit"]>>;
  try {
    result = await adapter.submit(request);
  } catch (error) {
    const progress = circleProgressOf(error);
    if (progress && !progress.approvalSent && !progress.uncertain) {
      // Circle executes only an approved challenge, and no approval left the
      // child: nothing can run, so the prepared review is restored as it was.
      updateOrder(record.intentId, { confirmationTx: tracked });
      throw new CliError({ code: "DASKI_CIRCLE_REVIEW_NOT_STARTED",
        message: progress.executionRequested
          ? "Circle refused or did not answer the review request before any approval; nothing was sent."
          : "The Circle review did not reach Circle; nothing was sent.",
        remediation: `The prepared review is kept. Check the Circle session with circle wallet status; if it expired, ${loginHint(circleChainName(context.profile.chainId))}. ` +
          `Then repeat daski order confirm ${handle} --submit --approve-call ${tracked.callHash}.`,
        details: { circleProgress: progress, reason: (error as CliError).message } });
    }
    // Possibly executing: keep the journal with every identity Circle gave.
    if (progress) updateOrder(record.intentId, { confirmationTx: withCircleProgress(started, progress) });
    throw error;
  }
  const updated = withCircleProgress(started, result.progress, result);
  updateOrder(record.intentId, { confirmationTx: updated });
  return { orderHandle: handle, mode: "direct", state: "submitted", transactionId: updated.vendor!.transactionId ?? null,
    txHash: updated.txHash ?? null, vendorState: updated.vendor!.state ?? null, conformanceCandidate: options.qualifyCircleExecution === true,
    next: `Use daski order confirm ${handle} --resume to verify final EAS evidence. Vendor completion alone is not review success.` };
}

/** Folds what a vendor run reported into the journal; identities only accumulate. */
function withCircleProgress(tracked: ConfirmationTxRecord, progress: CircleReviewProgress,
  result?: { transactionId?: string; txHash?: Hex; state?: string }): ConfirmationTxRecord {
  const vendor = tracked.vendor!;
  const transactionId = vendor.transactionId ?? result?.transactionId ?? progress.transactionId;
  const txHash = result?.txHash ?? progress.txHash;
  const state = result?.state ?? progress.state;
  const hashes = txHash ? [...new Set([...vendor.hashes, txHash])] : vendor.hashes;
  return { ...tracked, ...(hashes.length ? { txHash: hashes[hashes.length - 1]! } : {}),
    vendor: { ...vendor, ...(progress.challengeId ? { challengeId: progress.challengeId } : {}),
      ...(transactionId ? { transactionId } : {}), ...(state ? { state } : {}), hashes } };
}

/** Circle states after which its transaction never executes. */
const CIRCLE_FAILED_STATES: ReadonlySet<string> = new Set(["FAILED", "DENIED", "CANCELLED"]);

/**
 * `--resume` for a started Circle review: read-only. Circle's history is
 * asked for the transaction (by the challenge's transaction ID, the
 * idempotency key, or the exact call after the submission started), the
 * chain is searched for the review itself, and every candidate hash is
 * verified exactly as --check verifies one. It never executes, cancels or
 * accelerates anything.
 */
async function resumeCircleReview(context: CommandContext, record: OrderRecord, tracked: ConfirmationTxRecord, handle: string,
  adapterFactory: () => DirectReviewSubmissionAdapter): Promise<Record<string, unknown>> {
  const vendor = tracked.vendor;
  if (!vendor) throw new CliError({ code: "DASKI_CONFIRMATION_NOT_PENDING",
    message: "Circle submission has not started.", remediation: "Preparation is not approval; use --estimate or explicitly approve --submit." });
  const request = { mode: "lookup" as const, wallet: context.payerAddress, call: tracked.call!, idempotencyKey: vendor.idempotencyKey };
  let found: CircleLookup = { hashes: [] };
  let vendorLookup: "matched" | "unmatched" | "unavailable" = "unmatched";
  try {
    found = await adapterFactory().lookup(request, { transactionId: vendor.transactionId, notBefore: vendor.submissionStarted });
    if (found.transactionId || found.hashes.length) vendorLookup = "matched";
  } catch (error) {
    // The chain still answers when Circle cannot; a lookup failure decides nothing.
    if (!(error instanceof CliError)) throw error;
    vendorLookup = "unavailable";
  }
  let updated: ConfirmationTxRecord = { ...tracked,
    vendor: { ...vendor, ...(!vendor.transactionId && found.transactionId ? { transactionId: found.transactionId } : {}),
      ...(found.state ? { state: found.state } : {}), hashes: [...new Set([...vendor.hashes, ...found.hashes])] } };
  const verify = async (candidates: readonly Hex[]): Promise<Record<string, unknown> | undefined> => {
    if (!candidates.length) return undefined;
    updated = { ...updated, vendor: { ...updated.vendor!, hashes: [...new Set([...updated.vendor!.hashes, ...candidates])] } };
    updated = { ...updated, txHash: updated.vendor!.hashes[updated.vendor!.hashes.length - 1]! };
    updateOrder(record.intentId, { confirmationTx: updated });
    for (const txHash of candidates) {
      try {
        const result = await checkDirectRecord(context, record, { ...updated, txHash }, handle, { orderHandle: handle, mode: "direct" });
        if (result.state === "observed") return result;
      } catch (error) {
        if (!(error instanceof CliError) || error.code !== "DASKI_CONFIRMATION_RECEIPT_UNRELATED") throw error;
        // An ERC-4337 outer success can contain an inner revert. Keep the journal.
      }
    }
    return undefined;
  };
  updateOrder(record.intentId, { confirmationTx: updated });
  const byVendor = await verify(updated.vendor!.hashes);
  if (byVendor) return byVendor;
  // Circle's history may be unreadable or not name the hash; the review itself is on chain.
  let chainSearch: "searched" | "unavailable" | "not-recorded" = updated.vendor!.fromBlock === undefined ? "not-recorded" : "searched";
  let discovered: Hex[] = [];
  try {
    discovered = (await discoverReviewTransactions(context, tracked)).filter(hash => !updated.vendor!.hashes.includes(hash));
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    chainSearch = "unavailable";
  }
  const byChain = await verify(discovered);
  if (byChain) return byChain;
  const hashes = updated.vendor!.hashes;
  const failed = CIRCLE_FAILED_STATES.has(updated.vendor!.state ?? "");
  return { orderHandle: handle, mode: "direct", state: "submitted", transactionId: updated.vendor!.transactionId ?? null,
    vendorState: updated.vendor!.state ?? null, vendorLookup, chainSearch, hashes,
    next: failed && updated.vendor!.transactionId
      ? `Circle reports the transaction ${updated.vendor!.state}, and nothing observed on chain carries this review. ` +
        `Clear it with daski order confirm ${handle} --abandon, then prepare the review again.`
      : hashes.length ? "Wait for final EAS evidence, then use --resume again."
        : "Neither Circle nor the chain shows this review yet. Keep this journal; --resume only reads and never executes again." };
}

/**
 * How far past the final height recorded before submission the chain is
 * searched (about 100 minutes of Base blocks, covering mainnet's finality lag
 * and Circle's own polling), and in what steps: Base's public RPC refuses an
 * eth_getLogs range over 500 blocks. A later landing is found through Circle's
 * history or a hash recorded with --tx.
 */
const DISCOVERY_SPAN = 3_000n;
const DISCOVERY_STEP = 500n;

/**
 * Transactions that carry this review, found on chain without the vendor:
 * the pinned EAS's Attested (or Revoked) events for the payer as attester,
 * the prepared recipient and the confirmation schema, from the final height
 * recorded before submission, whose attestation binds to the prepared call
 * at the RPC's final height. --check then verifies each one in full.
 */
async function discoverReviewTransactions(context: CommandContext, tracked: ConfirmationTxRecord): Promise<Hex[]> {
  const from = tracked.vendor?.fromBlock;
  if (!context.chain.getLogs || from === undefined || !/^\d+$/.test(from)) return [];
  const finalBlock = await context.chain.getFinalBlockNumber();
  const start = BigInt(from);
  if (finalBlock < start) return [];
  const end = finalBlock < start + DISCOVERY_SPAN ? finalBlock : start + DISCOVERY_SPAN;
  const eventName = tracked.action === "attest" ? "Attested" : "Revoked";
  const topics = encodeEventTopics({ abi: EAS_ABI, eventName,
    args: { recipient: tracked.expected.recipient, attester: context.payerAddress, schemaUID: tracked.expected.schema } }) as Hex[];
  for (let low = start; low <= end; low += DISCOVERY_STEP) {
    const high = low + DISCOVERY_STEP - 1n < end ? low + DISCOVERY_STEP - 1n : end;
    for (const log of await context.chain.getLogs({ address: context.profile.easAddress, topics, fromBlock: low, toBlock: high })) {
      if (!isAddressEqual(log.address, context.profile.easAddress)) continue;
      let uid: Hex;
      try {
        uid = (decodeEventLog({ abi: EAS_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] }).args as { uid: Hex }).uid;
      } catch {
        continue;
      }
      if (tracked.action === "revoke" && !sameHex(uid, tracked.expected.uid ?? "")) continue;
      // One attestation binds to the prepared call: its refUID admits no second one.
      if (!bindingMismatch(await readAttestation(context.chain, context.profile.easAddress, uid, finalBlock), tracked, uid)) {
        return [log.transactionHash.toLowerCase() as Hex];
      }
    }
  }
  return [];
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

/**
 * A call prepared before 0.5.0, which saved only its hash and binding: nothing
 * was recorded as sent, and the call itself must be prepared again to be
 * estimated or submitted.
 */
function isLegacyPrepared(tracked: ConfirmationTxRecord | undefined): tracked is ConfirmationTxRecord {
  return tracked !== undefined && tracked.state === "prepared" && !tracked.call && !tracked.txHash && !tracked.vendor;
}

/** A direct record that --tx, --check, or --abandon can act on: anything but none or abandoned. */
function isDirectTracked(tracked: ConfirmationTxRecord | undefined): boolean {
  return tracked !== undefined && tracked.state !== "abandoned";
}

/**
 * What --check consults. An explicit --submission decides: `direct` verifies
 * the recorded transaction (refused when none is tracked), `sponsored` asks
 * the gateway. Otherwise a direct record still prepared or submitted is
 * verified, and anything else (no record, an abandoned one, or one already
 * observed) asks the gateway for the order's current state in the signer's
 * mode, so a review submitted after an observed direct one is never hidden
 * behind the retained receipt.
 */
function checkTarget(tracked: ConfirmationTxRecord | undefined, requested: string | undefined,
  description: SignerDescription): { kind: "record" } | { kind: "gateway"; submission: ConfirmationMode } {
  if (requested === "direct") return { kind: "record" };
  if (requested === "sponsored") return { kind: "gateway", submission: "sponsored" };
  if (requested !== undefined) {
    throw new CliError({
      code: "DASKI_CONFIRMATION_SUBMISSION_INVALID",
      message: `--submission must be sponsored or direct, not "${requested}".`,
      remediation: "Omit the flag to check the pending direct record or the gateway's state, or pass --submission direct|sponsored.",
    });
  }
  if (isPendingDirect(tracked)) return { kind: "record" };
  return { kind: "gateway", submission: selectConfirmationMode(description, undefined) };
}

/**
 * `--check` against the gateway: its final read of the order's confirmation
 * state, which its relayer reconciles after a sponsored submission mined and
 * which a direct submission moves once its receipt is covered. Nothing is
 * stored locally; an observed direct record is reported next to it as
 * history.
 */
async function checkGatewayReview(context: CommandContext, record: OrderRecord, handle: string,
  submission: ConfirmationMode): Promise<Record<string, unknown>> {
  const check = await callAuthorizedLifecycleTool({
    client: context.client, signer: context.signer, toolName: "daski_confirm_delivery", action: "confirmation",
    orderHandle: handle, request: { phase: "check", submission },
    chainId: context.profile.chainId, gatewayUrl: context.profile.gatewayUrl,
  });
  const anchor = finalizedAnchor(check);
  const tracked = record.confirmationTx;
  return { orderHandle: record.handle, mode: submission, state: "checked",
    confirmedCurrent: check.confirmedCurrent ?? null, lastObserved: check.lastObserved ?? null,
    submissionsUsed: check.submissionsUsed ?? null,
    finalizedBlock: anchor ? anchor.number.toString() : null,
    ...(record.confirmationSubmission ? { pendingSubmission: record.confirmationSubmission.request.preparationId } : {}),
    ...(tracked && isDirectTracked(tracked)
      ? { directRecord: { action: tracked.action, state: tracked.state, callHash: tracked.callHash,
        ...(tracked.txHash ? { txHash: tracked.txHash } : {}), ...(tracked.uid ? { uid: tracked.uid } : {}) } }
      : {}),
    note: `confirmedCurrent is the gateway's final state; lastObserved is its latest read. ${finalityNote(context.profile.chainId)}` +
      (tracked?.state === "observed" ? " The observed direct record is kept as history; --submission direct returns its recorded evidence." : ""),
    next: record.confirmationSubmission
      ? `A sponsored submission is still pending here: daski order confirm ${handle} --resume.`
      : `Run daski order confirm ${handle} --check again once the chain's final view has caught up.` };
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
    // A started Circle execution may carry several hashes (Circle replaces a
    // stuck transaction), so a hash is added to it, never swapped; each one is
    // still bound on chain before the journal closes.
    if (!tracked.vendor && tracked.state === "submitted" && tracked.txHash !== txHash) {
      // Replacing a recorded hash is a journal correction, allowed only once the
      // recorded transaction is canonical, final, and provably not the
      // prepared call.
      const unrelated = await provenUnrelated(context, tracked, handle);
      if (!unrelated) throw new CliError({ code: "DASKI_CONFIRMATION_TX_ALREADY_RECORDED",
        message: `Transaction ${tracked.txHash} is already recorded for this confirmation.`,
        remediation: `Verify it with daski order confirm ${handle} --check. A recorded hash is replaced only once its ` +
          "transaction is final and carries no event that binds to the prepared call; if it reverted, --abandon clears it first." });
      corrected = { previousTxHash: tracked.txHash!, reason: unrelated };
    }
    const vendor = tracked.vendor ? { vendor: { ...tracked.vendor, hashes: [...new Set([...tracked.vendor.hashes, txHash])] } } : {};
    updateOrder(record.intentId, { confirmationTx: { ...tracked, ...vendor, txHash, state: "submitted" } });
    return { ...base, txHash, state: "submitted", verification: "recorded, not yet verified",
      ...(corrected ? { corrected, note: `The previously recorded transaction is final and unrelated to the prepared call (${corrected.reason}); the record now tracks the new hash. ${cancelsNothing}` } : {}),
      next: `Run daski order confirm ${handle} --check once the transaction is mined. ${finalityNote(context.profile.chainId)}` };
  }

  if (options.check) return checkDirectRecord(context, record, tracked, handle, base);

  // --abandon: only when nothing recorded can still execute: no hash, a
  // revert in a final canonical block, or a final canonical
  // transaction provably not this call. A revert in a block that is not yet final
  // settles nothing: a reorganization can re-include the transaction against
  // different state.
  // A started Circle execution is abandoned only once Circle reports its
  // transaction failed, and then only on the same receipt rules as any hash.
  if (tracked.vendor && !(tracked.vendor.transactionId !== undefined && CIRCLE_FAILED_STATES.has(tracked.vendor.state ?? ""))) throw new CliError({
    code: "DASKI_CONFIRMATION_TX_MAY_EXECUTE", message: "Circle execution was started and Circle has not reported it failed.",
    remediation: `Use daski order confirm ${handle} --resume: it reads Circle's record of the transaction and searches the chain, ` +
      "and never executes. Keep the saved idempotency key; do not abandon or execute again." });
  const hashes = [...new Set([...(tracked.vendor?.hashes ?? []), ...(tracked.txHash ? [tracked.txHash] : [])])];
  let unrelatedReceipt: string | undefined;
  for (const txHash of hashes) {
    const pinned = { ...tracked, txHash };
    const receipt = await context.chain.getTransactionReceipt(txHash);
    if (!receipt) throw new CliError({ code: "DASKI_CONFIRMATION_TX_MAY_EXECUTE",
      message: `Transaction ${txHash} has no receipt yet and may still execute.`,
      remediation: `Wait for it to be mined, then run daski order confirm ${handle} --check. Abandon is allowed only when the receipt is a final revert or the transaction is final and unrelated to this call.` });
    if (receipt.status === "success") {
      const unrelated = await provenUnrelated(context, pinned, handle, receipt);
      if (!unrelated) throw new CliError({ code: "DASKI_CONFIRMATION_TX_MAY_EXECUTE",
        message: `Transaction ${txHash} executed; the record cannot be abandoned.`,
        remediation: `Verify it with daski order confirm ${handle} --check.` });
      unrelatedReceipt = unrelated;
    } else {
      const view = await receiptView(context, receipt);
      if (!view.final || !view.canonical) throw new CliError({ code: "DASKI_CONFIRMATION_TX_MAY_EXECUTE",
        message: `Transaction ${txHash} reverted in ${view.final
          ? "a block that is not the chain's canonical block at its height"
          : `block ${receipt.blockNumber}, which is not final yet (final block ${view.finalBlock})`}; it may still be re-included.`,
        remediation: `Wait for the block to become final. ${finalityNote(context.profile.chainId)} Then run daski order confirm ${handle} --check and --abandon.` });
    }
  }
  updateOrder(record.intentId, { confirmationTx: { ...tracked, state: "abandoned" } });
  return { ...base, ...(tracked.txHash ? { txHash: tracked.txHash } : {}), state: "abandoned",
    ...(unrelatedReceipt ? { unrelatedReceipt } : {}),
    note: `Local tracking was cleared. ${cancelsNothing}` +
      (unrelatedReceipt ? " If the prepared call was sent under another hash, prepare nothing new: record that hash instead." : ""),
    next: `Prepare again when ready: daski order confirm ${handle} --choice Confirmed|NotConfirmed.` };
}

/** How long "final" takes on the profile's chain, for the buyer's next step. */
function finalityNote(chainId: number): string {
  return finalityTagFor(chainId) === "finalized"
    ? "Finality on Base mainnet (the finalized tag) takes minutes to tens of minutes."
    : "The sandbox treats Base Sepolia's safe tag as final; it lags the head by minutes.";
}

/** How long to wait before resuming a pending sponsored review: a fraction of the chain's finality lag. */
function reviewPollSeconds(chainId: number): number {
  return finalityTagFor(chainId) === "finalized" ? 120 : 30;
}

/**
 * A sponsored review the gateway has not finished. `pending` waits for the
 * chain, so it says when to look again. `attention` means the gateway has
 * parked it for its operator: resuming does not move it, and the saved
 * signature must be kept, since the operator may find it can still execute.
 * Both use `state`, the key a final review reports too.
 */
function unfinishedSponsoredReview(handle: string, chainId: number, gateway: Record<string, unknown> | undefined,
  ids: { preparationId?: unknown; operationId?: string | undefined }, pendingNext: string): Record<string, unknown> {
  const disposition = typeof gateway?.disposition === "string" ? gateway.disposition : undefined;
  const base = { orderHandle: handle, mode: "sponsored",
    ...(ids.preparationId === undefined ? {} : { preparationId: ids.preparationId }),
    ...(ids.operationId ? { operationId: ids.operationId } : {}),
    ...(disposition ? { disposition } : {}) };
  if (disposition === "operator_attention") return { ...base, state: "attention",
    next: `${reviewNeedsOperator(ids.operationId)} Once it is resolved, daski order confirm ${handle} --resume reports the outcome.` };
  return { ...base, state: "pending", pollAfterSeconds: reviewPollSeconds(chainId),
    next: `${pendingNext} ${finalityNote(chainId)}` };
}

/** The receipt's block in the profile RPC's final view. */
interface ReceiptView {
  /** The RPC's own final height, at the profile chain's finality tag. */
  finalBlock: bigint;
  /** The receipt's height is at or below that, so the RPC's canonical block at it is settled. */
  final: boolean;
  /** Read only when final: the RPC's canonical block at the receipt's height is the receipt's block. */
  canonical: boolean;
}

/**
 * The one final view every canonical read uses (R04): the RPC's final height
 * is read first, and the canonical block at the receipt's height is compared
 * only when that height is already final there, so the comparison cannot be
 * overtaken by a reorganization. The RPC is one consistent node; a balancer
 * over unsynchronized nodes is outside this guarantee.
 */
async function receiptView(context: CommandContext, receipt: TransactionReceiptLike): Promise<ReceiptView> {
  const finalBlock = await context.chain.getFinalBlockNumber();
  if (receipt.blockNumber > finalBlock) return { finalBlock, final: false, canonical: false };
  const canonical = sameHex(await context.chain.getBlockHash(receipt.blockNumber), receipt.blockHash);
  return { finalBlock, final: true, canonical };
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
    message: `Transaction ${tracked.txHash} is not final yet (block ${receipt.blockNumber}, final block ${view.finalBlock}); whether it carried this confirmation cannot be settled.`,
    remediation: `Wait for the block to become final. ${finalityNote(context.profile.chainId)} Then repeat the same daski order confirm ${handle} command.` });
  if (!view.canonical) throw new CliError({ code: "DASKI_CONFIRMATION_TX_UNFINALIZED",
    message: `Transaction ${tracked.txHash} was carried by a block that is not the chain's canonical block at height ${receipt.blockNumber}.`,
    remediation: `The transaction may be re-included or dropped. Wait, then repeat the same daski order confirm ${handle} command.` });
  try {
    await boundConfirmationUid(context, receipt, tracked, view.finalBlock);
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
    remediation: tracked.vendor
      ? `Circle execution was started; use daski order confirm ${handle} --resume to find its transaction through Circle and the chain.`
      : `Submit it with the wallet's own tool, then record the hash: daski order confirm ${handle} --tx <hash>.` });
  const receipt = await context.chain.getTransactionReceipt(tracked.txHash);
  if (!receipt) {
    return { ...base, txHash: tracked.txHash, state: "submitted", receipt: "pending",
      next: `The transaction is not mined yet. Run daski order confirm ${handle} --check again shortly.` };
  }
  const view = await receiptView(context, receipt);
  const later = `${finalityNote(context.profile.chainId)} Run daski order confirm ${handle} --check again later.`;
  if (receipt.status !== "success") {
    const settled = view.final && view.canonical;
    return { ...base, txHash: tracked.txHash, state: "submitted", receipt: "reverted", revertFinal: settled,
      next: settled
        ? `The transaction reverted in a final block. Clear the record with daski order confirm ${handle} --abandon, then prepare again.`
        : `The transaction reverted, but ${view.final ? "the block that carried it is not the chain's canonical block" : "its block is not final yet"}; it may still be re-included. Run daski order confirm ${handle} --check again later, then --abandon.` };
  }
  if (!view.final) {
    return { ...base, txHash: tracked.txHash, state: "submitted", receipt: "success",
      verification: `the receipt's block ${receipt.blockNumber} is not final on the profile's RPC yet (final block ${view.finalBlock})`, next: later };
  }
  if (!view.canonical) {
    return { ...base, txHash: tracked.txHash, state: "submitted", receipt: "reorganized",
      verification: `the block that carried the transaction is not the chain's canonical block at height ${receipt.blockNumber}`,
      next: `The transaction may be re-included or dropped. Run daski order confirm ${handle} --check again later.` };
  }
  const uid = await boundConfirmationUid(context, receipt, tracked, view.finalBlock);
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
    return notYet("the receipt, the EAS event and the attestation match the prepared call; the gateway's final read is not past the receipt's block yet");
  }
  // The gateway's final block must be this RPC's canonical block at its
  // height; the receipt's block, final on this RPC at a lower or equal
  // height, is then its ancestor, so the receipt's effect is what the anchor
  // shows. The receipt's block is compared once more against the same view
  // so an RPC that contradicted itself between the reads cannot pass.
  if (!sameHex(await context.chain.getBlockHash(anchor.number), anchor.hash)) {
    return notYet(`the gateway's final block ${anchor.number} is not the chain's canonical block at that height as the profile's RPC reports it`);
  }
  if (!sameHex(await context.chain.getBlockHash(receipt.blockNumber), receipt.blockHash)) {
    return { ...base, txHash: tracked.txHash, uid, state: "submitted", receipt: "reorganized", check,
      verification: `the profile's RPC changed its canonical block at height ${receipt.blockNumber} between reads`,
      next: `Run daski order confirm ${handle} --check again later.` };
  }
  // Execution is proven: the final canonical receipt and the bound EAS
  // record close the transaction. Whether the review still stands is a
  // separate fact: the wallet may have revoked or replaced it since, and
  // that must never leave the journal pending.
  const review = reviewEffect(check, tracked, uid);
  updateOrder(record.intentId, { confirmationTx: { ...tracked, uid, state: "observed" }, readCapability: undefined });
  return { ...base, txHash: tracked.txHash, uid, state: "observed", receipt: "success", review,
    observedBlock: receipt.blockNumber.toString(), finalizedBlock: anchor.number.toString(), check,
    ...(review === "current" ? {} : {
      note: tracked.action === "attest"
        ? "The attestation executed but is no longer the order's current review: it was revoked or replaced afterwards."
        : "The revocation executed; a later review is current.",
    }) };
}

function unrelatedReceipt(reason: string): CliError {
  return new CliError({
    code: "DASKI_CONFIRMATION_RECEIPT_UNRELATED",
    message: `The recorded transaction does not carry this confirmation: ${reason}.`,
    remediation:
      "The record stays submitted. If the hash was recorded by mistake, record the right one with " +
      "--tx <hash> or clear the record with --abandon; a reverted transaction can be abandoned once its " +
      "block is final. Otherwise check the wallet's tool for the transaction that carried the prepared call.",
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
 * Attestations are read pinned to the RPC's final height, the same view
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

/** The gateway's final block view (wire field `finalizedBlock`: `{ number, hash }`, number a decimal string), or null. */
function finalizedAnchor(check: Record<string, unknown>): { number: bigint; hash: Hex } | null {
  const anchor = check.finalizedBlock;
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return null;
  const { number, hash } = anchor as { number?: unknown; hash?: unknown };
  if (typeof number !== "string" || !/^\d+$/.test(number) || typeof hash !== "string" || !HEX32.test(hash)) return null;
  return { number: BigInt(number), hash: hash.toLowerCase() as Hex };
}

/**
 * What the gateway's final read says about the executed review now: an
 * attestation is `current` while it is the order's current uid and
 * `superseded` once revoked or replaced; a revocation is `current` while the
 * revoked uid is no longer current. The caller has established that the
 * anchor is at or past the receipt's block and canonical on the profile's RPC.
 */
function reviewEffect(check: Record<string, unknown>, tracked: ConfirmationTxRecord, uid: Hex): "current" | "superseded" {
  const finalized = check.confirmedCurrent;
  if (!finalized || typeof finalized !== "object" || Array.isArray(finalized)) return "superseded";
  const current = (finalized as { currentUid?: unknown }).currentUid;
  if (typeof current !== "string") return "superseded";
  const stands = tracked.action === "attest" ? sameHex(current, uid) : !sameHex(current, tracked.expected.uid ?? "");
  return stands ? "current" : "superseded";
}

/** Read the deployment pins separately, then verify the selected order and EAS nonce on chain. */
export async function readConfirmationFacts(context: CommandContext, record: OrderRecord, profileReader = discoverEasReviewProfile): Promise<ConfirmationFacts> {
  const status = await readWithCapability(context, record, { toolName: "daski_get_order_status", action: "status", request: {} });
  if (typeof status.orderKey !== "string" || !HEX32.test(status.orderKey)) throw invalidPreparation();
  const pins = (await context.metadata()).confirmationSigning;
  if (!pins) throw confirmationPinsMissing(context.profile.gatewayUrl);
  if (pins.chainId !== context.profile.chainId) throw invalidPreparation();
  if (!isAddressEqual(pins.eas, context.profile.easAddress)) throw easAddressMismatch(pins.eas, context.profile.easAddress, context.profile.chainId);
  const orderKey = status.orderKey as Hex;
  // The record and nonce share one batched eth_call, and the profile check
  // another: a public RPC refuses a burst of separate ones.
  const [[current, nonce], profile] = await Promise.all([
    readContracts(context.chain, [
      { address: pins.reputationStorage, abi: REPUTATION_ABI, functionName: "getRecord", args: [orderKey] },
      { address: pins.eas, abi: EAS_ABI, functionName: "getNonce", args: [context.payerAddress] },
    ]) as Promise<readonly [{
      orderKey: Hex; providerAgentId: bigint; payer: Address; providerOwner: Address; providerAgentWallet: Address;
      confirmationSubmissions: number; outcomeRecorded: boolean; reputationEligible: boolean; currentConfirmationUid: Hex;
    }, bigint]>,
    profileReader(context.chain, pins.chainId, pins.eas),
  ]);
  if (current.orderKey !== orderKey || getAddress(current.payer) !== context.payerAddress ||
      String(current.providerAgentId) !== record.providerAgentId || !current.outcomeRecorded || !current.reputationEligible) throw invalidPreparation();
  // The record's provider agent wallet is the attestation recipient; the
  // contract refuses to register a zero wallet, so a zero here is a record
  // this CLI does not understand.
  if (current.providerAgentWallet === ZERO_ADDRESS) throw invalidPreparation();
  return { chainId: pins.chainId, profile, eas: pins.eas, schemaUid: pins.schemaUid, reputationStorage: pins.reputationStorage, orderKey,
    recipient: getAddress(current.providerAgentWallet),
    currentUid: current.currentConfirmationUid, nonce: nonce.toString(), submissionsUsed: Number(current.confirmationSubmissions) };
}
