/**
 * `daski buy` — the full purchase.
 *
 * The seven steps of §2, in order, with the approval gate between the quote
 * and the signature and the reconciliation gate between an ambiguous outcome
 * and any re-sign.
 */
import { readFileSync } from "node:fs";
import { formatUsdc, PolicyRefusal } from "@daski/x402-scheme";
import { CliError } from "../cli/errors.js";
import { confirm, isInteractive } from "../cli/prompt.js";
import { note } from "../cli/output.js";
import { atomicUsdc } from "../config.js";
import { createContext, type ContextOptions } from "../context.js";
import { GatewayClient } from "../gateway/client.js";
import {
  authorizePayment,
  newIntentId,
  reconcileAmbiguousPurchase,
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
  /** Skips only the interactive prompt, never the policy validator. */
  yes?: boolean;
}

/** Gateway states that mean "authorized, outcome unknown" rather than "failed". */
const AMBIGUOUS_CODES = new Set([
  "PAYMENT_PENDING_RECONCILIATION",
  "PAYMENT_OUTCOME_PENDING",
]);

export async function runBuy(options: BuyOptions): Promise<Record<string, unknown>> {
  const request = readRequestFile(options.requestFile);
  const context = await createContext(options);
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
    if (preflight?.sufficient === false) {
      // The gateway already read the payer's balance: a signature now would be
      // a doomed one. Say what is needed and stop; where the USDC comes from
      // is the operator's business.
      const network = String(preflight.network ?? context.profile.network);
      const balance = typeof preflight.usdcBalance === "string"
        ? `${formatUsdc(BigInt(preflight.usdcBalance))} USDC`
        : "an unknown USDC balance";
      throw new CliError({
        code: "DASKI_INSUFFICIENT_USDC",
        message:
          `${context.payerAddress} holds ${balance} on ${network}; this purchase ` +
          `needs ${formatUsdc(amountAtomic)}.`,
        remediation:
          `Fund ${context.payerAddress} with USDC on ${network}, then re-run. Nothing was signed.`,
        details: { preflight, priceUsdc: formatUsdc(amountAtomic) },
        exitCode: 2,
      });
    }

    // -- 2. approval -------------------------------------------------------
    const outcome = await context.catalog.getOutcome(options.providerAgentId, options.outcomeId);
    const summary = approvalSummary(challenge.challenge.extensions, outcome, amountAtomic, preflight);
    const threshold = atomicUsdc(context.profile.requireApprovalAboveUsdc);
    if (amountAtomic > threshold && !options.yes) {
      if (options.json || !isInteractive()) {
        throw new CliError({
          code: "DASKI_HUMAN_APPROVAL_REQUIRED",
          message:
            `${formatUsdc(amountAtomic)} is above this profile's ` +
            `requireApprovalAboveUsdc of ${context.profile.requireApprovalAboveUsdc} USDC, ` +
            "and this session cannot ask a human.",
          remediation:
            "Have a human run this command in an interactive terminal and confirm " +
            "the prompt, or — if a human has already approved this exact purchase " +
            "— re-run with --yes. Raising the threshold is a manual config edit.",
          details: { approvalSummary: summary, priceUsdc: formatUsdc(amountAtomic) },
          exitCode: 2,
        });
      }
      note(renderApproval(summary, amountAtomic));
      if (!await confirm("Authorize this payment?")) {
        throw new CliError({
          code: "DASKI_PURCHASE_DECLINED",
          message: "The purchase was not approved.",
          remediation: "Nothing was signed and no money moved. Re-run when ready.",
          exitCode: 2,
        });
      }
    }

    // -- 3 & 4. validate, recompute, sign ----------------------------------
    const intentId = newIntentId();
    // Recorded before the signature so an interruption is recoverable.
    recordIntent({
      intentId,
      profile: context.profileName,
      providerAgentId: options.providerAgentId,
      outcomeId: options.outcomeId,
      payer: context.payerAddress,
      amount: amountAtomic.toString(),
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
        intentId, options, request, authorized,
        cause: `transport failure after submit: ${(error as Error).message}`,
      });
    }

    const body = GatewayClient.json(result);
    const code = typeof body?.code === "string" ? body.code : undefined;
    if (result.isError && code && AMBIGUOUS_CODES.has(code)) {
      return await reconcile(context, {
        intentId, options, request, authorized,
        cause: `gateway reported ${code}`,
      });
    }
    if (GatewayClient.unreadable(result)) {
      // The paid call answered without an error and this client found no
      // payload. The signature is out and the outcome is unknown: that is the
      // ambiguous case, so reconcile — never report failure, never re-sign.
      return await reconcile(context, {
        intentId, options, request, authorized,
        cause: "the paid result carried no payload this CLI could read",
      });
    }
    if (result.isError || !body || typeof body.orderHandle !== "string") {
      updateOrder(intentId, { state: "PENDING_RECONCILIATION" });
      const { purchaseFailure } = await import("../gateway/purchase.js");
      throw purchaseFailure(result, { afterSubmit: true });
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
    options: BuyOptions;
    request: Record<string, unknown>;
    authorized: Awaited<ReturnType<typeof authorizePayment>>;
    cause: string;
  },
): Promise<Record<string, unknown>> {
  updateOrder(args.intentId, { state: "PENDING_RECONCILIATION" });
  note(`payment outcome unclear (${args.cause}); reconciling before any re-sign...`);
  const record = updateOrder(args.intentId, {})!;
  const outcome = await reconcileAmbiguousPurchase({
    client: context.client,
    signer: context.signer,
    record,
    payer: context.payerAddress,
    chainId: context.profile.chainId,
    gatewayUrl: context.profile.gatewayUrl,
    submission: args.authorized.submission,
    request: args.request,
    ...(args.options.legacyArg === undefined ? {} : { legacyArg: args.options.legacyArg }),
  });

  if (outcome.status === "settled") {
    const settled = updateOrder(args.intentId, {
      handle: outcome.orderHandle,
      state: normalizeState(outcome.body?.status),
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

  // Provably absent: the caller may safely start over with a fresh challenge.
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
    payTo: string; commissionBps?: number | undefined; providerAudience?: string | undefined },
  amountAtomic: bigint,
  preflight?: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const supplied = preflight?.approvalSummary ?? extensions?.approvalSummary;
  if (supplied && typeof supplied === "object") return supplied as Record<string, unknown>;
  const terms = extensions?.["daski-order-terms"] as Record<string, unknown> | undefined;
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

function renderApproval(summary: Record<string, unknown>, amountAtomic: bigint): string {
  const lines = ["", "  ─ Purchase approval ─────────────────────────────"];
  for (const [key, value] of Object.entries(summary)) {
    if (value === null || value === undefined) continue;
    lines.push(`  ${key.padEnd(18)} ${String(value)}`);
  }
  lines.push(`  ${"you will pay".padEnd(18)} ${formatUsdc(amountAtomic)}`);
  lines.push("  ─────────────────────────────────────────────────", "");
  return lines.join("\n");
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
