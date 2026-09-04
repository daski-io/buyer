/**
 * `daski buy` — the full purchase.
 *
 * The seven steps of §2, in order, with the approval gate between the quote
 * and the signature and the reconciliation gate between an ambiguous outcome
 * and any re-sign.
 */
import { readFileSync } from "node:fs";
import { canonicalHash, formatUsdc, PolicyRefusal } from "@daski/x402-scheme";
import { CliError } from "../cli/errors.js";
import { note } from "../cli/output.js";
import { createContext, type ContextOptions, type CommandContext } from "../context.js";
import { approvePurchase, nextPurchaseApproval } from "./approval.js";
import { GatewayClient } from "../gateway/client.js";
import {
  authorizePayment,
  challengeIntentId,
  isAmbiguousPurchaseAnswer,
  reconcileByIdentifier,
  recordIntent,
  requestChallenge,
  submitPayment,
} from "../gateway/purchase.js";
import { updateOrder } from "../store/orders.js";

export interface BuyOptions extends ContextOptions {
  providerAgentId: string;
  outcomeId: string;
  requestFile: string;
  payer?: string | undefined;
  json: boolean;
  legacyArg?: boolean;
  /** The identifier of the quote the user approved. */
  approved?: string | undefined;
}

export async function runBuy(options: BuyOptions, contextFactory: (options: ContextOptions) => Promise<CommandContext> = createContext): Promise<Record<string, unknown>> {
  const request = readRequestFile(options.requestFile);
  const context = await contextFactory(options);
  try {
    if (options.payer && options.payer.toLowerCase() !== context.payerAddress.toLowerCase()) {
      throw new CliError({
        code: "DASKI_PAYER_NOT_THIS_SIGNER",
        message:
          `--payer ${options.payer} is not the address this profile signs with ` +
          `(${context.payerAddress}).`,
        remediation:
          "The bridge can only authorize payments from the key it holds. Switch " +
          "profiles, or drop --payer.",
      });
    }

    // -- 1. challenge ------------------------------------------------------
    const challenge = await requestChallenge({
      client: context.client,
      providerAgentId: options.providerAgentId,
      outcomeId: options.outcomeId,
      request,
      payerAddress: context.payerAddress,
    });
    const amountAtomic = BigInt(challenge.requirement.amount);
    const preflight = challenge.preflight;
    const requestHash = canonicalHash({ method: "POST", resource: challenge.challenge.resource?.url,
      providerAgentId: options.providerAgentId, outcomeId: options.outcomeId, body: request });
    if (!challenge.binding || challenge.binding.canonicalRequestHash !== requestHash) {
      throw new CliError({ code: "DASKI_REQUEST_BINDING_MISMATCH",
        message: "The challenge does not match the requested purchase.",
        remediation: "Obtain a challenge for the same provider, outcome, and request." });
    }
    const approval = nextPurchaseApproval({ gatewayUrl: context.profile.gatewayUrl,
      payer: context.payerAddress, providerAgentId: options.providerAgentId, outcomeId: options.outcomeId,
      requirement: challenge.requirement, binding: challenge.binding }, context.profileName);
    const outcome = await context.catalog.getOutcome(options.providerAgentId, options.outcomeId);
    const summary = approvalSummary(challenge.challenge.extensions, outcome, amountAtomic, preflight);
    if (preflight?.sufficient === false) {
      // The gateway already read the payer's balance: a signature now would be
      // a doomed one. Say what is needed and stop; where the USDC comes from
      // is the operator's business.
      const network = String(preflight.network ?? context.profile.network);
      const balance = typeof preflight.usdcBalance === "string"
        ? formatUsdc(BigInt(preflight.usdcBalance))
        : "an unknown USDC balance";
      throw new CliError({
        code: "DASKI_INSUFFICIENT_USDC",
        message:
          `${context.payerAddress} holds ${balance} on ${network}; this purchase ` +
          `needs ${formatUsdc(amountAtomic)}.`,
        remediation:
          `Fund ${context.payerAddress} with USDC on ${network}, then re-run. Nothing was signed.`,
        details: { preflight, priceUsdc: formatUsdc(amountAtomic), approval, approvalSummary: summary,
          shortfallUsdc: typeof preflight.usdcBalance === "string"
            ? formatUsdc(amountAtomic > BigInt(preflight.usdcBalance) ? amountAtomic - BigInt(preflight.usdcBalance) : 0n) : null },
        exitCode: 2,
      });
    }

    // -- 2. approval -------------------------------------------------------
    await approvePurchase({ approval, approved: options.approved,
      threshold: context.profile.requireApprovalAboveUsdc, json: options.json, summary });

    // -- 3 & 4. validate, recompute, sign ----------------------------------
    // The gateway bound its own payment identifier to the challenge; the
    // submission must carry that one, so it is the ledger key as well.
    const intentId = challengeIntentId(challenge.challenge.extensions);
    // Recorded before the signature so an interruption is recoverable.
    recordIntent({
      intentId,
      profile: context.profileName,
      providerAgentId: options.providerAgentId,
      outcomeId: options.outcomeId,
      payer: context.payerAddress,
      amount: amountAtomic.toString(),
      approvalTermsHash: approval.termsHash,
      state: "INTENT_RECORDED",
      request,
    });

    const authorized = await authorizePayment({
      policy: context.policy,
      signer: context.signer,
      challenge,
      providerAgentId: options.providerAgentId,
      outcomeId: options.outcomeId,
      approvedQuoteAtomic: amountAtomic,
      intentId,
    });
    updateOrder(intentId, {
      state: "AUTHORIZED",
      authorizationNonce: authorized.nonce,
    });

    // -- 5. paid retry -----------------------------------------------------
    let result;
    try {
      result = await submitPayment({
        client: context.client,
        providerAgentId: options.providerAgentId,
        outcomeId: options.outcomeId,
        request,
        submission: authorized.submission,
        ...(options.legacyArg === undefined ? {} : { legacyArg: options.legacyArg }),
      });
    } catch (error) {
      // The signature left the process and the answer did not come back. This
      // is the ambiguous case: reconcile, never re-sign.
      return await reconcile(context, {
        intentId,
        cause: `transport failure after submit: ${(error as Error).message}`,
      });
    }

    const body = GatewayClient.json(result);
    const code = typeof body?.code === "string" ? body.code : undefined;
    if (result.isError && isAmbiguousPurchaseAnswer(code, body)) {
      return await reconcile(context, {
        intentId,
        cause: `gateway reported ${code ?? "an error"} with the payment outcome unknown`,
      });
    }
    if (GatewayClient.unreadable(result)) {
      // The paid call answered without an error and this client found no
      // payload. The signature is out and the outcome is unknown: that is the
      // ambiguous case, so reconcile — never report failure, never re-sign.
      return await reconcile(context, {
        intentId,
        cause: "the paid result carried no payload this CLI could read",
      });
    }
    if (result.isError || !body || typeof body.orderHandle !== "string") {
      // The gateway refused the submission and said nothing settled
      // (`paymentMayHaveSettled: false`): a definitive refusal, not an
      // unknown outcome. Recording it as pending reconciliation would send
      // the operator reconciling a payment the gateway says never existed.
      const refused = result.isError && body?.paymentMayHaveSettled === false;
      updateOrder(intentId, { state: refused ? "NOT_SETTLED" : "PENDING_RECONCILIATION" });
      const { purchaseFailure } = await import("../gateway/purchase.js");
      throw purchaseFailure(result, { afterSubmit: true, refused });
    }

    // -- 6 & 7. persist and report ----------------------------------------
    const record = updateOrder(intentId, {
      handle: body.orderHandle,
      state: normalizeState(body.status),
    });
    return {
      purchased: true,
      orderHandle: body.orderHandle,
      intentId,
      profile: context.profileName,
      provider: options.providerAgentId,
      outcome: options.outcomeId,
      price: formatUsdc(amountAtomic),
      state: record?.state ?? String(body.status ?? "unknown"),
      payer: context.payerAddress,
      authorizationNonce: authorized.nonce,
      challengeSource: challenge.viaChallengeTool
        ? "daski_get_payment_challenge"
        : "daski_buy_outcome (unpaid challenge fallback)",
      receipt: body.receipt ?? null,
      gatewayCalls: context.client.callCount,
    };
  } finally {
    await context.close();
  }
}

async function reconcile(
  context: Awaited<ReturnType<typeof createContext>>,
  args: {
    intentId: string;
    cause: string;
  },
): Promise<Record<string, unknown>> {
  updateOrder(args.intentId, { state: "PENDING_RECONCILIATION" });
  note(`payment outcome unclear (${args.cause}); reconciling before any re-sign...`);
  const record = updateOrder(args.intentId, {})!;
  const outcome = await reconcileByIdentifier({
    client: context.client,
    signer: context.signer,
    intentId: args.intentId,
    payer: context.payerAddress,
    chainId: context.profile.chainId,
    gatewayUrl: context.profile.gatewayUrl,
  });

  if (outcome.status === "settled") {
    const settled = updateOrder(args.intentId, {
      handle: outcome.orderHandle,
      state: normalizeState(outcome.gatewayState),
    });
    return {
      purchased: true,
      recovered: true,
      orderHandle: outcome.orderHandle,
      intentId: args.intentId,
      state: settled?.state ?? "unknown",
      price: formatUsdc(BigInt(record.amount)),
      reconciliation: outcome.evidence,
      cause: args.cause,
      gatewayCalls: context.client.callCount,
    };
  }

  if (outcome.status !== "absent") {
    throw new CliError({ code: "DASKI_PAYMENT_PENDING_RECONCILIATION",
      message: "The gateway is still resolving this payment.",
      remediation: `Check again with daski order reconcile ${args.intentId}.`,
      details: { intentId: args.intentId, status: outcome.status, reconciliation: outcome.evidence }, exitCode: 3 });
  }
  updateOrder(args.intentId, { state: "NOT_SETTLED" });
  throw new CliError({
    code: "DASKI_PAYMENT_UNRESOLVED_NO_ORDER",
    message:
      `The purchase was interrupted (${args.cause}) and no order exists for it: ` +
      `${outcome.evidence}.`,
    remediation:
      "Nothing settled, so a fresh purchase is safe: re-run the same `daski buy` " +
      `command. The unsettled intent is recorded as ${args.intentId}.`,
    details: { intentId: args.intentId, reconciliation: outcome.evidence },
    exitCode: 3,
  });
}

function normalizeState(status: unknown): "FULFILLED" | "INPUT_REQUIRED" | "PROVIDER_FAILED" | "SUBMITTED" {
  const value = String(status ?? "").toLowerCase();
  if (["completed", "fulfilled"].includes(value)) return "FULFILLED";
  if (["input-required", "input_required"].includes(value)) return "INPUT_REQUIRED";
  if (["failed", "canceled", "provider_failed"].includes(value)) return "PROVIDER_FAILED";
  return "SUBMITTED";
}

/**
 * The human-facing summary. The gateway's prepare tool ships a one-sentence
 * `approvalSummary` in its preflight; it leads when present, and the rest is
 * assembled from the order terms and the catalog, so the operator sees who is
 * being paid and under whose terms either way.
 */
function approvalSummary(
  extensions: Record<string, unknown> | undefined,
  outcome: { serviceName?: string | undefined; skillName?: string | undefined;
    payTo: string; commissionBps?: number | undefined; providerAudience?: string | undefined;
    terms?: Record<string, unknown> | undefined },
  amountAtomic: bigint,
  preflight?: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const supplied = preflight?.approvalSummary ?? extensions?.approvalSummary;
  if (supplied && typeof supplied === "object") return supplied as Record<string, unknown>;
  const terms = extensions?.["daski-order-terms"] as Record<string, unknown> | undefined ?? outcome.terms;
  return {
    ...(typeof supplied === "string" ? { gateway: supplied } : {}),
    what: [outcome.serviceName, outcome.skillName].filter(Boolean).join(" / ") || "Daski outcome",
    price: formatUsdc(amountAtomic),
    paysTo: outcome.payTo,
    provider: terms?.providerLegalName ?? outcome.providerAudience ?? "unknown",
    commissionBps: terms?.commissionBps ?? outcome.commissionBps ?? null,
    providerTerms: terms?.providerTermsUrl ?? null,
    marketplaceTerms: terms?.marketplaceTermsUrl ?? null,
  };
}

function readRequestFile(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new CliError({
      code: "DASKI_REQUEST_FILE_UNREADABLE",
      message: `Could not read the request file ${path}: ${(error as Error).message}`,
      remediation: "Pass --request with a path to a JSON file containing the outcome's request body.",
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliError({
      code: "DASKI_REQUEST_FILE_NOT_JSON",
      message: `${path} is not valid JSON: ${(error as Error).message}`,
      remediation: "Fix the file so it contains a single JSON object.",
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError({
      code: "DASKI_REQUEST_FILE_NOT_OBJECT",
      message: `${path} must contain a JSON object.`,
      remediation: "Wrap the request in an object, e.g. {\"address\": \"...\"}",
    });
  }
  return parsed as Record<string, unknown>;
}

export { PolicyRefusal };
