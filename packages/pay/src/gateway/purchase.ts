/**
 * The purchase flow, and the ambiguous-outcome path.
 *
 * The dangerous moment in a buyer bridge is not the signature — it is the
 * silence after it. A timeout, a dropped socket, or a
 * `PAYMENT_PENDING_RECONCILIATION` leaves us unable to say whether money
 * moved. The rule (§2) is: reconcile before any re-sign. A second signature
 * over a fresh challenge is a second order, and a second charge.
 *
 * Two facts make reconciliation provable rather than heuristic:
 *
 *   1. The recipe nonce is deterministic, so an identical resubmission is
 *      byte-identical, and the gateway's published retry policy treats an
 *      identical signed authorization as `transport-retry-same-purchase`.
 *      Replaying what we already signed cannot create a second order.
 *   2. The payer's own order history corroborates it independently.
 *
 * So we replay first, corroborate second, and only request a fresh challenge
 * when both agree the order does not exist.
 */
import { randomBytes } from "node:crypto";
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
} from "../store/orders.js";
import {
  describeResult,
  GatewayClient,
  unreadableResultError,
  type McpToolResult,
  type PaymentChallenge,
  type PaymentRequirement,
  type PaymentSubmission,
} from "./client.js";
import { callWalletQuery } from "./lifecycle.js";

/** The read-only prepare tool. A gateway without it serves the same challenge through an unpaid buy call. */
export const CHALLENGE_TOOL = "daski_get_payment_challenge";
export const BUY_TOOL = "daski_buy_outcome";

export interface ChallengeResult {
  challenge: PaymentChallenge;
  requirement: PaymentRequirement;
  binding: OrderBinding | undefined;
  /** True when the spec-01 challenge tool served this. */
  viaChallengeTool: boolean;
  /** The prepare tool's balance and eligibility preflight, when it served one. */
  preflight?: Record<string, unknown> | undefined;
}

/** A fresh reconciliation key. Also the idempotency key the gateway echoes. */
export function newIntentId(): string {
  return `daski-${randomBytes(16).toString("hex")}`;
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
 * The payment identifier a submission must carry. The gateway looks a paid
 * submission up by this identifier, so it has to be the one the gateway bound
 * to the challenge: when we proposed one at challenge time (`buy`), the
 * gateway echoes it; when the challenge came from elsewhere (`sign-payment`
 * on a challenge the agent obtained itself), the gateway's own identifier is
 * the only one that exists server-side. 0.1.1 minted a fresh identifier in
 * that second case and every such submission was refused with
 * `PAYMENT_IDENTIFIER_CONFLICT` before settlement (2026-09-03).
 */
export function resolvePaymentIdentifier(
  extensions: Record<string, unknown> | undefined,
  proposed: string | undefined,
): string | undefined {
  const issued = issuedPaymentIdentifier(extensions);
  if (issued !== undefined && proposed !== undefined && issued !== proposed) {
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
  return issued ?? proposed;
}

/**
 * Step 1: obtain a payment challenge. Prefers `daski_get_payment_challenge`
 * and falls back to an unpaid `daski_buy_outcome`, which is the same challenge
 * by a longer road.
 */
export async function requestChallenge(options: {
  client: GatewayClient;
  providerAgentId: string;
  outcomeId: string;
  request: Record<string, unknown>;
  payerAddress: Address;
}): Promise<ChallengeResult> {
  const { client, providerAgentId, outcomeId, request, payerAddress } = options;
  const viaChallengeTool = await client.hasTool(CHALLENGE_TOOL);
  const result = viaChallengeTool
    ? await client.callTool(CHALLENGE_TOOL, {
        providerAgentId, outcomeId, request, payerAddress,
      })
    : await client.callTool(BUY_TOOL, { providerAgentId, outcomeId, request });

  const challenge = GatewayClient.challenge(result);
  if (!challenge) {
    // A success answer with no payload this client can read is a protocol
    // mismatch, not a refusal; say so instead of "the gateway rejected it".
    if (GatewayClient.unreadable(result)) {
      throw unreadableResultError(viaChallengeTool ? CHALLENGE_TOOL : BUY_TOOL, result);
    }
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
    viaChallengeTool,
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
  /** Pass the payload as a tool argument instead of `_meta`. */
  legacyArg?: boolean;
  timeoutMs?: number;
}

/**
 * Step 5: the paid retry. The payload rides in `_meta["x402/payment"]` unless
 * `--legacy-arg` asks for the argument form.
 */
export async function submitPayment(options: SubmitOptions): Promise<McpToolResult> {
  const args: Record<string, unknown> = {
    providerAgentId: options.providerAgentId,
    outcomeId: options.outcomeId,
    request: options.request,
  };
  if (options.legacyArg) {
    args.paymentPayload = options.submission;
    return options.client.callTool(BUY_TOOL, args);
  }
  return options.client.callTool(BUY_TOOL, args, {
    "x402/payment": options.submission,
  });
}

export interface ReconcileOptions {
  client: GatewayClient;
  signer: SignerAdapter;
  record: OrderRecord;
  payer: Address;
  chainId: number;
  gatewayUrl: string;
  submission: PaymentSubmission;
  request: Record<string, unknown>;
  legacyArg?: boolean;
}

export interface ReconcileOutcome {
  /** `settled` when an order exists; `absent` when provably none does. */
  status: "settled" | "absent";
  orderHandle?: string | undefined;
  body?: Record<string, unknown> | undefined;
  /** How the conclusion was reached, for the audit log. */
  evidence: string;
}

/**
 * The ambiguous-outcome path. Never signs anything: it replays what was
 * already signed, then corroborates against the payer's own history.
 */
export async function reconcileAmbiguousPurchase(
  options: ReconcileOptions,
): Promise<ReconcileOutcome> {
  const { client, record } = options;

  // 1. Replay the identical authorization. Idempotent by the gateway's own
  //    published retry policy, so this cannot create a second order.
  const replay = await submitPayment({
    client,
    providerAgentId: record.providerAgentId,
    outcomeId: record.outcomeId,
    request: options.request,
    submission: options.submission,
    ...(options.legacyArg === undefined ? {} : { legacyArg: options.legacyArg }),
  });
  const replayBody = GatewayClient.json(replay);
  if (!replay.isError && typeof replayBody?.orderHandle === "string") {
    return {
      status: "settled",
      orderHandle: replayBody.orderHandle,
      body: replayBody,
      evidence: "identical signed authorization replayed to the same order",
    };
  }

  // 2. Corroborate independently against the payer's own order history.
  const listed = await listPayerOrders(options);
  const match = listed.find((order) =>
    order.providerAgentId === record.providerAgentId &&
    order.outcomeId === record.outcomeId &&
    order.grossAmount === record.amount &&
    Date.parse(order.createdAt) >= Date.parse(record.createdAt) - 60_000);
  if (match) {
    return {
      status: "settled",
      orderHandle: match.orderHandle,
      evidence: "matched an order in the payer's own history",
    };
  }

  return {
    status: "absent",
    evidence:
      "the identical replay produced no order and the payer's history contains none",
  };
}

interface PayerOrderRow {
  orderHandle: string;
  providerAgentId: string;
  outcomeId: string;
  grossAmount: string;
  state: string;
  createdAt: string;
  /** Present once the gateway echoes the buyer's idempotency key. */
  paymentIdentifier?: string;
}

/**
 * The payer's order history. When the gateway echoes `paymentIdentifier` on a
 * row, we filter by it exactly as §2 specifies; until then the rows carry no
 * such field and the caller matches on the intent's other invariants.
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
    request: { limit: 25, cursor: null },
    chainId: options.chainId,
    gatewayUrl: options.gatewayUrl,
  });
  const rows = Array.isArray(body.orders) ? body.orders as PayerOrderRow[] : [];
  if (!options.intentId) return rows;
  const filtered = rows.filter((row) => row.paymentIdentifier === options.intentId);
  // Only narrow when the gateway actually echoes the key; an empty result from
  // a field that does not exist is not evidence of absence.
  return filtered.length > 0 || rows.some((row) => row.paymentIdentifier !== undefined)
    ? filtered
    : rows;
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
  options: { afterSubmit?: boolean | undefined } = {},
): CliError {
  if (GatewayClient.unreadable(result)) return unreadableResultError(BUY_TOOL, result, options);
  const body = GatewayClient.json(result);
  const code = typeof body?.code === "string" ? body.code : "DASKI_PURCHASE_FAILED";
  const fallbackRemediation = options.afterSubmit
    ? "The signature was submitted: do not re-run `daski buy` until the recorded intent " +
      "is reconciled. The gateway's response is under `gateway` in this error."
    : "Nothing was signed. The gateway's response is under `gateway` in this error.";
  return new CliError({
    code,
    message: typeof body?.message === "string"
      ? body.message
      : "The gateway rejected the purchase.",
    remediation: typeof body?.next_action === "string" ? body.next_action : fallbackRemediation,
    details: { gateway: body ?? describeResult(result) },
  });
}

/** Human-readable price, for approval prompts and receipts. */
export function priceLine(amountAtomic: bigint): string {
  return formatUsdc(amountAtomic);
}
