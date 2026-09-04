import { canonicalHash, type TypedDataRequest } from "@daski/x402-scheme";
import { createPublicClient, encodeAbiParameters, getAddress, http, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";
import { CliError } from "../cli/errors.js";
import type { CommandContext } from "../context.js";
import { callAuthorizedLifecycleTool } from "../gateway/lifecycle.js";
import { updateOrder, type OrderRecord } from "../store/orders.js";
import { readWithCapability, withOrder, type OrderOptions } from "./order.js";

export interface ConfirmationOptions extends OrderOptions {
  confirmation?: string | undefined;
  revoke?: boolean | undefined;
  resume?: boolean | undefined;
  acknowledgeFinalTransition?: boolean | undefined;
}
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
export interface ConfirmationFacts {
  chainId: number; eas: Address; schemaUid: Hex; orderKey: Hex; recipient: Address;
  currentUid: Hex; nonce: string; transitionsUsed: number;
}

/** Rebuild the narrow EAS review message from chain facts and the user's choice. */
export function validateConfirmationPreparation(prepared: Record<string, unknown>, facts: ConfirmationFacts,
  choice: "Confirmed" | "NotConfirmed" | "revoke", acknowledged: boolean, now = Math.floor(Date.now() / 1000)): TypedDataRequest {
  const proposed = prepared.signableTypedData as TypedDataRequest | undefined;
  const deadline = Number(proposed?.message?.deadline);
  if (!proposed || prepared.orderKey !== facts.orderKey || prepared.currentRefUid !== facts.currentUid ||
      prepared.transitionsUsed !== facts.transitionsUsed || facts.transitionsUsed >= 3 ||
      (facts.transitionsUsed === 2 && !acknowledged) || !Number.isSafeInteger(deadline) || deadline <= now || deadline > now + 330) {
    throw invalidPreparation();
  }
  const common = { schema: facts.schemaUid, value: "0", nonce: facts.nonce, deadline: String(deadline) };
  const expected: TypedDataRequest = { domain: { name: "EAS", version: "1.2.0", chainId: facts.chainId, verifyingContract: facts.eas },
    types: choice === "revoke" ? revokeTypes : attestTypes, primaryType: choice === "revoke" ? "Revoke" : "Attest",
    message: choice === "revoke" ? { ...common, uid: facts.currentUid } : { ...common, recipient: facts.recipient,
      expirationTime: "0", revocable: true, refUID: facts.currentUid,
      data: encodeAbiParameters(parseAbiParameters("bytes32 orderKey,uint8 confirmation"), [facts.orderKey, choice === "Confirmed" ? 1 : 2]) } };
  if (canonicalHash(proposed) !== canonicalHash(expected)) throw invalidPreparation();
  return expected;
}

function invalidPreparation() {
  return new CliError({ code: "DASKI_CONFIRMATION_MISMATCH", message: "The review preparation does not match this order and choice.",
    remediation: "Check the order and request a fresh review preparation." });
}

export async function runConfirmation(options: ConfirmationOptions): Promise<Record<string, unknown>> {
  return withOrder(options, (context, record) => confirmOrder(context, record, options));
}

export async function confirmOrder(context: CommandContext, record: OrderRecord, options: ConfirmationOptions,
  factsReader = readConfirmationFacts): Promise<Record<string, unknown>> {
  if (!options.resume && !options.revoke && !["Confirmed", "NotConfirmed"].includes(options.confirmation ?? "")) {
    throw new CliError({ code: "DASKI_CONFIRMATION_CHOICE_REQUIRED", message: "Choose the delivery confirmation for this order.",
      remediation: "After the user's choice, pass --choice Confirmed or --choice NotConfirmed. Leaving it Pending requires no action." });
  }
  if (record.confirmationSubmission && !options.resume) throw new CliError({ code: "DASKI_CONFIRMATION_PENDING",
    message: "A review submission for this order is awaiting reconciliation.", remediation: `Run daski order confirm ${options.handle} --resume.` });
  const call = (action: "confirmation" | "revoke-confirmation", request: Record<string, unknown>) => callAuthorizedLifecycleTool({
    client: context.client, signer: context.signer, toolName: action === "confirmation" ? "daski_confirm_delivery" : "daski_revoke_delivery_confirmation",
    action, orderHandle: record.handle ?? options.handle, request, chainId: context.profile.chainId, gatewayUrl: context.profile.gatewayUrl });
  let submission = record.confirmationSubmission;
  if (!submission) {
    if (options.resume) throw new CliError({ code: "DASKI_CONFIRMATION_NOT_PENDING", message: "There is no pending review submission.",
      remediation: "Check order status, then supply the user's review choice if a new review is wanted." });
    const action = options.revoke ? "revoke-confirmation" : "confirmation";
    const facts = await factsReader(context, record);
    const prepared = await call(action, { phase: "prepare", acknowledgeFinalTransition: options.acknowledgeFinalTransition === true,
      ...(options.revoke ? {} : { confirmation: options.confirmation }) });
    if (!prepared.signableTypedData) {
      if ((prepared.warning as { code?: string } | undefined)?.code !== "FINAL_CONFIRMATION_TRANSITION") throw invalidPreparation();
      return { orderHandle: record.handle, ...prepared,
        next: "Show the final-transition warning to the user. After explicit acceptance, repeat with --acknowledge-final-transition." };
    }
    const typedData = validateConfirmationPreparation(prepared, facts,
      options.revoke ? "revoke" : options.confirmation as "Confirmed" | "NotConfirmed", options.acknowledgeFinalTransition === true);
    if (typeof prepared.preparationId !== "string") throw invalidPreparation();
    const signature = await context.signer.signTypedData(typedData);
    submission = { action, request: { phase: "submit", preparationId: prepared.preparationId, signature } };
    updateOrder(record.intentId, { confirmationSubmission: submission, readCapability: undefined });
  }
  try {
    const result = await call(submission.action, submission.request);
    updateOrder(record.intentId, { confirmationSubmission: undefined, readCapability: undefined });
    return { orderHandle: record.handle, ...result };
  } catch (error) {
    if (error instanceof CliError && error.code === "CONFIRMATION_SUBMISSION_PENDING") return {
      orderHandle: record.handle, status: "pending", preparationId: submission.request.preparationId,
      next: `Run daski order confirm ${options.handle} --resume to check the same submission.` };
    if (error instanceof CliError && error.code === "CONFIRMATION_PREPARATION_STALE") {
      updateOrder(record.intentId, { confirmationSubmission: undefined });
    }
    throw error;
  }
}

/** Read the deployment pins separately, then verify the selected order and EAS nonce on chain. */
async function readConfirmationFacts(context: CommandContext, record: OrderRecord): Promise<ConfirmationFacts> {
  const status = await readWithCapability(context, record, { toolName: "daski_get_order_status", action: "status", request: {} });
  if (typeof status.orderKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(status.orderKey)) throw invalidPreparation();
  const response = await fetch(`${context.profile.gatewayUrl.replace(/\/$/, "")}/.well-known/mcp.json`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw invalidPreparation();
  const metadata = await response.json() as { confirmationSigning?: { chainId: number; eas: string; schemaUid: Hex; reputationStorage: string } };
  const pins = metadata.confirmationSigning;
  if (!pins || pins.chainId !== context.profile.chainId || !/^0x[0-9a-fA-F]{64}$/.test(pins.schemaUid)) throw invalidPreparation();
  const client = createPublicClient({ transport: http(context.profile.rpcUrl) });
  const abi = parseAbi([
    "function getNonce(address account) view returns (uint256)",
    "function getRecord(bytes32 orderKey) view returns ((bytes32 orderKey,bytes32 authorizationKey,uint256 providerAgentId,bytes32 serviceId,address payer,address providerOwner,address providerAgentWallet,address providerPayee,address canonicalToken,uint256 grossAmount,uint64 paidAt,bytes32 providerIdentitySnapshotHash,bytes32 listingManifestHash,bytes32 releaseEvidenceHash,uint8 outcome,uint8 confirmation,uint64 outcomeAttestationDelay,uint64 outcomeTimestamp,uint64 confirmationTimestamp,uint8 confirmationTransitions,bool outcomeRecorded,bool reputationEligible,bytes32 currentConfirmationUid))",
  ]);
  const orderKey = status.orderKey as Hex;
  const [current, nonce] = await Promise.all([
    client.readContract({ address: getAddress(pins.reputationStorage), abi, functionName: "getRecord", args: [orderKey] }),
    client.readContract({ address: getAddress(pins.eas), abi, functionName: "getNonce", args: [context.payerAddress] }),
  ]);
  if (current.orderKey !== orderKey || getAddress(current.payer) !== context.payerAddress ||
      String(current.providerAgentId) !== record.providerAgentId || !current.outcomeRecorded || !current.reputationEligible) throw invalidPreparation();
  return { chainId: pins.chainId, eas: getAddress(pins.eas), schemaUid: pins.schemaUid, orderKey,
    recipient: getAddress(current.providerAgentWallet === "0x0000000000000000000000000000000000000000" ? current.providerOwner : current.providerAgentWallet),
    currentUid: current.currentConfirmationUid, nonce: nonce.toString(), transitionsUsed: Number(current.confirmationTransitions) };
}
