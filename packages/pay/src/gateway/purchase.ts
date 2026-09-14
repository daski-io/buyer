/** Purchase authorization, submission, and exact-identifier reconciliation. */
import {
  bindingFromExtensions,
  formatUsdc,
  paymentEchoExtensions,
  transferWithAuthorizationTypedData,
  validatePurchaseAuthorization,
  withPaymentIdentifier,
  type OrderBinding,
  type PolicyConfig,
  type SignerAdapter,
} from "@daski/x402-scheme";
import { getAddress, type Address } from "viem";
import { CliError } from "../cli/errors.js";
import {
  findByIntent,
  updateOrder,
  upsertOrder,
  type OrderRecord,
  type OrderState,
} from "../store/orders.js";
import {
  describeResult,
  GatewayClient,
  gatewayRefusalRemediation,
  gatewayUnsupported,
  isRetryableGatewayCode,
  unreadableResultError,
  type McpToolResult,
  type PaymentChallenge,
  type PaymentRequirement,
  type PaymentSubmission,
} from "./client.js";
import { callWalletQuery } from "./lifecycle.js";

/** Prepares pricing and a draft without payment; the only source of a challenge. */
export const CHALLENGE_TOOL = "daski_get_payment_challenge";
export const BUY_TOOL = "daski_buy_outcome";

export interface ChallengeResult {
  challenge: PaymentChallenge;
  requirement: PaymentRequirement;
  binding: OrderBinding | undefined;
  /** The prepare tool's balance and eligibility preflight, when it served one. */
  preflight?: Record<string, unknown> | undefined;
}

/** A challenge without the gateway's identifier cannot be paid: the gateway looks a submission up by it. */
function paymentIdentifierMissing(): CliError {
  return new CliError({
    code: "DASKI_PAYMENT_IDENTIFIER_MISSING",
    message:
      "The challenge carries no payment-identifier extension, so there is no identifier the " +
      "gateway would look the paid submission up by.",
    remediation:
      "Do not sign: a submission under an identifier the gateway did not issue is refused before " +
      "settlement. Request a fresh challenge from daski_get_payment_challenge; every challenge a " +
      "supported gateway issues carries payment-identifier.info.id.",
  });
}

/** The identifier the gateway pinned in a challenge's `payment-identifier` extension, if any. */
export function issuedPaymentIdentifier(
  extensions: Record<string, unknown> | undefined,
): string | undefined {
  const issued = extensions?.["payment-identifier"] as { info?: { id?: unknown } } | undefined;
  const id = issued?.info?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * The payment identifier a submission must carry: the one the gateway bound
 * to the challenge, since the gateway looks a paid submission up by it and
 * nothing else exists server-side. A challenge that carries none is refused,
 * never given a minted identifier (0.1.1 minted one and every such
 * submission was refused with `PAYMENT_IDENTIFIER_CONFLICT` before
 * settlement, 2026-09-03); a challenge bound to a different identifier than
 * the one a purchase recorded is refused too.
 */
export function resolvePaymentIdentifier(
  extensions: Record<string, unknown> | undefined,
  proposed: string | undefined,
): string {
  const issued = issuedPaymentIdentifier(extensions);
  if (issued === undefined) throw paymentIdentifierMissing();
  if (proposed !== undefined && issued !== proposed) {
    throw new CliError({
      code: "DASKI_PAYMENT_IDENTIFIER_MISMATCH",
      message:
        `The gateway bound this challenge to payment identifier ${issued}, not to ` +
        `the ${proposed} this purchase proposed.`,
      remediation:
        "Do not sign: a payment carrying a different identifier than the challenge " +
        "is refused by the gateway. Request a fresh challenge and retry.",
    });
  }
  return issued;
}

/**
 * The reconciliation key for a purchase: the identifier the gateway bound to
 * the challenge, which is also what the submission must carry, so the local
 * ledger and the gateway's `daski_list_my_orders` filter agree. The gateway
 * never accepted a proposal, so there is nothing to propose; a challenge
 * without an identifier is refused.
 */
export function challengeIntentId(extensions: Record<string, unknown> | undefined): string {
  return resolvePaymentIdentifier(extensions, undefined);
}

/**
 * Whether a paid submission's error answer leaves the payment outcome unknown.
 * Only the gateway's own `paymentMayHaveSettled: false` says nothing settled;
 * `true`, a refusal without the flag, and a body this CLI cannot read are all
 * ambiguous, so the identifier is reconciled rather than signed for again. On
 * 2026-09-04 a code list missed PAYMENT_IDENTIFIER_CONFLICT and an agent
 * re-signed on the strength of a local ledger message.
 */
export function isAmbiguousPurchaseAnswer(body: Record<string, unknown> | undefined): boolean {
  return body?.paymentMayHaveSettled !== false;
}

/**
 * Step 1: obtain a payment challenge from `daski_get_payment_challenge`, the
 * only tool that issues one. A gateway without it is unsupported.
 */
export async function requestChallenge(options: {
  client: GatewayClient;
  providerAgentId: string;
  outcomeId: string;
  request: Record<string, unknown>;
  payerAddress: Address;
}): Promise<ChallengeResult> {
  const { client, providerAgentId, outcomeId, request, payerAddress } = options;
  if (!(await client.hasTool(CHALLENGE_TOOL))) throw gatewayUnsupported(client.gatewayUrl, CHALLENGE_TOOL);
  const result = await client.callTool(CHALLENGE_TOOL, { providerAgentId, outcomeId, request, payerAddress });

  const challenge = GatewayClient.challenge(result);
  if (!challenge) {
    // A success answer with no payload this client can read is a protocol
    // mismatch, not a refusal; say so instead of "the gateway rejected it".
    if (GatewayClient.unreadable(result)) throw unreadableResultError(CHALLENGE_TOOL, result);
    throw purchaseFailure(result);
  }
  const requirement = challenge.accepts[0];
  if (!requirement) {
    throw new CliError({
      code: "DASKI_CHALLENGE_NO_REQUIREMENTS",
      message: "The gateway returned a challenge with no payment requirements.",
      remediation: "Retry; if it persists, report it to the gateway operator.",
    });
  }
  return {
    challenge,
    requirement,
    binding: bindingFromExtensions(challenge.extensions),
    preflight: GatewayClient.preflight(result),
  };
}

export interface AuthorizeOptions {
  policy: PolicyConfig;
  signer: SignerAdapter;
  challenge: ChallengeResult;
  providerAgentId: string;
  outcomeId: string;
  /** What the human approved, in atomic units. */
  approvedQuoteAtomic: bigint;
  intentId: string;
  nowSeconds?: number;
}

export interface AuthorizedPayment {
  submission: PaymentSubmission;
  amountAtomic: bigint;
  nonce: string;
}

/**
 * Steps 3 and 4: validate, recompute, sign. The authorization is built here
 * rather than accepted, and the §4 validator sees it before the wallet does.
 */
export async function authorizePayment(options: AuthorizeOptions): Promise<AuthorizedPayment> {
  const { policy, challenge, signer } = options;
  const requirement = challenge.requirement;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const binding = challenge.binding;
  const payer = getAddress(policy.payerAddress);
  const splitter = getAddress(requirement.payTo);
  const amount = BigInt(requirement.amount);

  if (!binding) {
    throw new CliError({
      code: "DASKI_CHALLENGE_NOT_RECIPE_BOUND",
      message:
        "This challenge carries no daski-order-binding, so its authorization " +
        "nonce cannot be recomputed.",
      remediation:
        "Only recipe-bound Daski challenges are signable here. Use " +
        "`daski sign-payment` documentation to see the accepted shapes.",
    });
  }

  const validAfter = BigInt(Math.max(0, now - 30));
  const validBefore = BigInt(Math.min(now + requirement.maxTimeoutSeconds, binding.expiresAt));
  const { deriveBindingNonce } = await import("@daski/x402-scheme");
  const nonce = deriveBindingNonce(binding, {
    chainId: policy.chainId,
    canonicalToken: getAddress(policy.canonicalToken),
    payer,
    splitter,
    grossAmount: amount,
  });
  const domain = {
    name: requirement.extra!.name!,
    version: requirement.extra!.version!,
    chainId: policy.chainId,
    verifyingContract: getAddress(requirement.asset),
  };
  const proposal = transferWithAuthorizationTypedData(domain, {
    from: payer,
    to: splitter,
    value: amount.toString(),
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
  });

  // The identifier the submission carries is the gateway's, never a fresh one.
  const paymentIdentifier = resolvePaymentIdentifier(challenge.challenge.extensions, options.intentId);
  const validated = await validatePurchaseAuthorization(policy, proposal, {
    providerAgentId: options.providerAgentId,
    outcomeId: options.outcomeId,
    challengeAmountAtomic: amount,
    challengeAsset: getAddress(requirement.asset),
    challengePayTo: splitter,
    challengeNetwork: requirement.network,
    approvedQuoteAtomic: options.approvedQuoteAtomic,
    paymentIdentifier,
    binding,
    nowSeconds: now,
  });

  const signature = await signer.signTypedData(
    transferWithAuthorizationTypedData(domain, validated.authorization),
  );

  return {
    submission: {
      x402Version: challenge.challenge.x402Version,
      resource: challenge.challenge.resource,
      accepted: requirement,
      payload: { authorization: validated.authorization, signature },
      extensions: withPaymentIdentifier(
        paymentEchoExtensions(challenge.challenge.extensions),
        paymentIdentifier,
      ),
    },
    amountAtomic: validated.amountAtomic,
    nonce: validated.recomputedNonce,
  };
}

export interface SubmitOptions {
  client: GatewayClient;
  providerAgentId: string;
  outcomeId: string;
  request: Record<string, unknown>;
  submission: PaymentSubmission;
  timeoutMs?: number;
}

/** Step 5: the paid retry. The payload rides in `_meta["x402/payment"]`. */
export async function submitPayment(options: SubmitOptions): Promise<McpToolResult> {
  return options.client.callTool(BUY_TOOL, {
    providerAgentId: options.providerAgentId,
    outcomeId: options.outcomeId,
    request: options.request,
  }, {
    "x402/payment": options.submission,
  });
}

/** One row of the payer's order history, as `daski_list_my_orders` states it. */
export interface PayerOrderRow {
  orderHandle: string;
  /** The gateway's payment identifier: the buyer's ledger key. */
  paymentIdentifier: string;
  providerAgentId: string;
  outcomeId: string;
  /** Atomic USDC. */
  grossAmount: string;
  /** One of the gateway's order states. */
  state: string;
  createdAt?: string | undefined;
}

function orderHistoryUnreadable(reason: string): CliError {
  return new CliError({
    code: "DASKI_ORDER_HISTORY_UNREADABLE",
    message: `The gateway's order history cannot be read: ${reason}.`,
    remediation:
      "Nothing was signed and nothing was recorded from the unreadable answer. Run daski doctor " +
      "--json to check the gateway pin, then retry; a gateway whose history rows lack " +
      "paymentIdentifier or a decimal grossAmount is not one this release supports.",
  });
}

/**
 * The rows of a `daski_list_my_orders` answer. A row this CLI cannot read is
 * an error, never a guess: a missing identifier used to be matched on other
 * invariants and a missing amount recorded as zero, both of which put
 * something in the ledger the gateway never said.
 */
export function readPayerOrderRows(body: Record<string, unknown>): PayerOrderRow[] {
  if (!Array.isArray(body.orders)) throw orderHistoryUnreadable("the answer carries no orders array");
  return body.orders.map((value: unknown, index): PayerOrderRow => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw orderHistoryUnreadable(`row ${index} is not an object`);
    const row = value as Record<string, unknown>;
    const text = (field: "orderHandle" | "paymentIdentifier" | "providerAgentId" | "outcomeId" | "state"): string => {
      const candidate = row[field];
      if (typeof candidate !== "string" || candidate.length === 0) throw orderHistoryUnreadable(`row ${index} has no ${field}`);
      return candidate;
    };
    const grossAmount = row.grossAmount;
    if (typeof grossAmount !== "string" || !/^\d+$/.test(grossAmount)) throw orderHistoryUnreadable(`row ${index} has no decimal grossAmount`);
    return {
      orderHandle: text("orderHandle"),
      paymentIdentifier: text("paymentIdentifier"),
      providerAgentId: text("providerAgentId"),
      outcomeId: text("outcomeId"),
      grossAmount,
      state: text("state"),
      createdAt: typeof row.createdAt === "string" ? row.createdAt : undefined,
    };
  });
}

/**
 * The payer's order history, filtered by the payment identifier when one is
 * given: the gateway filters server-side, and the rows are narrowed again
 * here so a row for another identifier can never be read as this one's.
 */
export async function listPayerOrders(options: {
  client: GatewayClient;
  signer: SignerAdapter;
  payer: Address;
  chainId: number;
  gatewayUrl: string;
  intentId?: string | undefined;
}): Promise<PayerOrderRow[]> {
  const body = await callWalletQuery({
    client: options.client,
    signer: options.signer,
    toolName: "daski_list_my_orders",
    action: "list-orders",
    payer: options.payer,
    // The gateway filters by intent id server-side when asked; the wallet
    // challenge is bound to this exact request, so the filter rides in it.
    request: {
      limit: 25,
      cursor: null,
      ...(options.intentId ? { paymentIdentifier: options.intentId } : {}),
    },
    chainId: options.chainId,
    gatewayUrl: options.gatewayUrl,
  });
  const rows = readPayerOrderRows(body);
  return options.intentId ? rows.filter((row) => row.paymentIdentifier === options.intentId) : rows;
}

/** What a gateway order state says about the money. */
export type SettlementReading = "not_settled" | "in_flight" | "ambiguous" | "settled";

/**
 * The gateway's closed order states, read for two questions: did the
 * authorization settle, and what does the local ledger record. One table
 * answers both, so a state cannot be settled for the budget and unknown for
 * the record.
 */
const GATEWAY_ORDER_STATES: Readonly<Record<string, { settlement: SettlementReading; local: OrderState }>> = {
  DRAFT: { settlement: "not_settled", local: "NOT_SETTLED" },
  CHALLENGE_ISSUED: { settlement: "not_settled", local: "NOT_SETTLED" },
  VERIFY_REJECTED: { settlement: "not_settled", local: "NOT_SETTLED" },
  SETTLEMENT_FAILED: { settlement: "not_settled", local: "NOT_SETTLED" },
  NOT_SETTLED: { settlement: "not_settled", local: "NOT_SETTLED" },
  ATTEMPT_OPENED: { settlement: "in_flight", local: "PENDING_RECONCILIATION" },
  VERIFIED: { settlement: "in_flight", local: "PENDING_RECONCILIATION" },
  SETTLE_INVOKED: { settlement: "in_flight", local: "PENDING_RECONCILIATION" },
  SETTLEMENT_AMBIGUOUS: { settlement: "ambiguous", local: "PENDING_RECONCILIATION" },
  EXTERNAL_OR_UNPROVEN_DEPOSIT: { settlement: "ambiguous", local: "PENDING_RECONCILIATION" },
  // Dispatch ambiguity is not payment ambiguity: the order exists and was paid.
  DISPATCH_AMBIGUOUS: { settlement: "ambiguous", local: "SUBMITTED" },
  FACILITATOR_CONFIRMED: { settlement: "settled", local: "SUBMITTED" },
  DEPOSIT_FINAL: { settlement: "settled", local: "SUBMITTED" },
  RELEASE_FINAL: { settlement: "settled", local: "SUBMITTED" },
  DISPATCH_STARTED: { settlement: "settled", local: "SUBMITTED" },
  DISPATCHED: { settlement: "settled", local: "SUBMITTED" },
  LEGAL_HOLD: { settlement: "settled", local: "SUBMITTED" },
  FULFILLED: { settlement: "settled", local: "FULFILLED" },
  PROVIDER_FAILED: { settlement: "settled", local: "PROVIDER_FAILED" },
  INPUT_REQUIRED: { settlement: "settled", local: "INPUT_REQUIRED" },
};

/**
 * The money question. An unknown state is ambiguous, never absent: nothing
 * is signed again on the strength of a state this CLI does not understand.
 */
export function readSettlement(state: string): SettlementReading {
  return GATEWAY_ORDER_STATES[state]?.settlement ?? "ambiguous";
}

/** A gateway order state this release does not understand; the ledger records nothing for it. */
export function orderStateUnreadable(state: unknown, orderHandle?: string | undefined): CliError {
  return new CliError({
    code: "DASKI_ORDER_STATE_UNREADABLE",
    message: `The gateway reports order state ${JSON.stringify(state)}, which this release does not understand.`,
    remediation:
      (orderHandle ? `The order exists as ${orderHandle} and the local record keeps its previous state. ` : "") +
      "Upgrade to the @daski/pay release the gateway pins (daski doctor --json shows the pin), then " +
      `run daski order status ${orderHandle ?? "<handle>"}.`,
    details: { gatewayState: state, ...(orderHandle ? { orderHandle } : {}) },
  });
}

/**
 * The ledger question: the local state a gateway order state records as. An
 * unknown state is refused, never recorded as SUBMITTED; the caller decides
 * what else it has already learned (a handle, a receipt) and keeps that.
 */
export function localOrderState(state: unknown, orderHandle?: string | undefined): OrderState {
  const known = typeof state === "string" ? GATEWAY_ORDER_STATES[state] : undefined;
  if (!known) throw orderStateUnreadable(state, orderHandle);
  return known.local;
}

export interface IdentifierReconciliation {
  status: "settled" | "in_flight" | "ambiguous" | "absent";
  orderHandle?: string | undefined;
  gatewayState?: string | undefined;
  evidence: string;
}

/**
 * The gateway's own answer for one payment identifier, with nothing signed
 * but the read authorization: no replay, no balance reading, no local
 * ledger. This is the lookup buy.md names for every ambiguous outcome and
 * for PAYMENT_IDENTIFIER_CONFLICT. An identifier the gateway never issued
 * matches nothing, which is the truth: nothing could have settled under it.
 */
export function reconcileIdentifierRows(
  intentId: string,
  rows: readonly PayerOrderRow[],
): IdentifierReconciliation {
  const matches = rows.filter((row) => row.paymentIdentifier === intentId);
  if (matches.length > 1) {
    return { status: "ambiguous", evidence: "The gateway history lists more than one order for the identifier." };
  }
  if (matches.length === 0) {
    return {
      status: "absent",
      evidence:
        `the gateway lists no order for payment identifier ${intentId} under this payer`,
    };
  }
  const row = matches[0]!;
  const reading = readSettlement(row.state);
  const evidence = `the gateway lists order ${row.orderHandle} for ${intentId} in state ${row.state}`;
  if (reading === "not_settled") return { status: "absent", gatewayState: row.state, evidence };
  if (reading === "settled") {
    return { status: "settled", orderHandle: row.orderHandle, gatewayState: row.state, evidence };
  }
  return { status: reading, orderHandle: row.orderHandle, gatewayState: row.state, evidence };
}

export async function reconcileByIdentifier(options: {
  client: GatewayClient;
  signer: SignerAdapter;
  payer: Address;
  chainId: number;
  gatewayUrl: string;
  intentId: string;
}): Promise<IdentifierReconciliation> {
  const rows = await listPayerOrders(options);
  return reconcileIdentifierRows(options.intentId, rows);
}

/** Records the intent before signing, so an interruption is recoverable. */
export function recordIntent(record: Omit<OrderRecord, "createdAt" | "updatedAt">): OrderRecord {
  const existing = findByIntent(record.intentId);
  if (existing) return existing;
  const now = new Date().toISOString();
  return upsertOrder({ ...record, createdAt: now, updatedAt: now });
}

export { updateOrder };

/**
 * The gateway's answer to a purchase step, as an operator-facing error. An
 * unreadable success is reported as the protocol mismatch it is, and the
 * response is always attached — `gateway: null` sent operators in circles.
 */
export function purchaseFailure(
  result: McpToolResult,
  options: {
    afterSubmit?: boolean | undefined;
    /** The gateway refused the signed submission and said nothing settled. */
    refused?: boolean | undefined;
  } = {},
): CliError {
  if (GatewayClient.unreadable(result)) return unreadableResultError(BUY_TOOL, result, options);
  const body = GatewayClient.json(result);
  const code = typeof body?.code === "string" ? body.code : "DASKI_PURCHASE_FAILED";
  const fallbackRemediation = options.refused
    ? "The gateway refused the signed submission and reports that nothing settled, so " +
      "there is nothing to reconcile; fix the cause it names before any new purchase. " +
      "The gateway's response is under `gateway` in this error."
    : options.afterSubmit
      ? "The signature was submitted: do not re-run `daski buy` until the recorded intent " +
        "is reconciled with `daski order reconcile <intentId>`. The gateway's response is " +
        "under `gateway` in this error."
      : "Nothing was signed. The gateway's response is under `gateway` in this error.";
  return new CliError({
    code,
    message: typeof body?.message === "string"
      ? body.message
      : "The gateway rejected the purchase.",
    remediation: gatewayRefusalRemediation(code, body) ??
      (typeof body?.next_action === "string" ? body.next_action : fallbackRemediation),
    details: {
      gateway: body ?? describeResult(result),
      ...(isRetryableGatewayCode(code) ? { retryable: true } : {}),
    },
  });
}

/** Human-readable price, for approval prompts and receipts. */
export function priceLine(amountAtomic: bigint): string {
  return formatUsdc(amountAtomic);
}
