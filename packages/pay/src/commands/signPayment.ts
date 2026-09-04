/**
 * `daski sign-payment` — the purpose-scoped signer for advanced flows.
 *
 * This is the only signing entry point besides `buy` and the lifecycle
 * commands, and it is deliberately narrow. It accepts a Daski recipe/stock
 * challenge, runs the full §4 validation and recompute, and prints the exact
 * `paymentPayload` JSON. It is not a generic typed-data signer and must never
 * become one: an input it does not recognize is refused, not signed.
 */
import { readFileSync } from "node:fs";
import { bindingFromExtensions, formatUsdc } from "@daski/x402-scheme";
import { getAddress } from "viem";
import { CliError } from "../cli/errors.js";
import { createContext, type ContextOptions } from "../context.js";
import type { PaymentChallenge, PaymentRequirement } from "../gateway/client.js";
import {
  authorizePayment, challengeIntentId, recordIntent,
} from "../gateway/purchase.js";
import { updateOrder } from "../store/orders.js";

export interface SignPaymentOptions extends ContextOptions {
  challengeFile: string;
  /** The purchase this challenge belongs to; needed for splitter evidence. */
  providerAgentId?: string | undefined;
  outcomeId?: string | undefined;
  json: boolean;
}

export async function runSignPayment(
  options: SignPaymentOptions,
): Promise<Record<string, unknown>> {
  const challenge = readChallenge(options.challengeFile);
  const requirement = challenge.accepts[0]!;
  const binding = bindingFromExtensions(challenge.extensions);

  // A challenge with no Daski binding is a stock x402 challenge. Signing one
  // here would be blind signing: there is nothing to recompute against.
  if (!binding) {
    throw new CliError({
      code: "DASKI_SIGN_PAYMENT_NOT_A_DASKI_CHALLENGE",
      message:
        "This challenge carries no daski-order-binding, so its authorization " +
        "nonce cannot be recomputed and its deal cannot be verified.",
      remediation:
        "`daski sign-payment` signs Daski recipe-bound challenges only. For a " +
        "stock x402 payment, use a stock x402 client — this bridge will not " +
        "sign what it cannot check.",
    });
  }

  const { providerAgentId, outcomeId } = resolveTarget(challenge, options);
  const context = await createContext(options);
  try {
    // The splitter evidence resolves through the catalog, so the same §4.1.4
    // two-source check applies here as in `buy`.
    const outcome = await context.catalog.getOutcome(providerAgentId, outcomeId);
    if (getAddress(outcome.token) !== getAddress(context.profile.usdcAddress)) {
      throw new CliError({
        code: "DASKI_SIGN_PAYMENT_NON_CANONICAL_ASSET",
        message:
          `${providerAgentId}/${outcomeId} settles in ${outcome.token}, not this ` +
          `profile's canonical ${context.profile.usdcAddress}.`,
        remediation: "Switch to the profile that pins this asset, or refuse the purchase.",
      });
    }

    const amountAtomic = BigInt(requirement.amount);
    // The challenge was obtained by the caller, so the gateway has already
    // bound its own payment identifier to it; the local order record and the
    // signed payload both use that identifier. A fresh one would be refused by
    // the gateway before settlement (0.1.1, 2026-09-03). A challenge without
    // one gets a fresh identifier, as before.
    const intentId = challengeIntentId(challenge.extensions);
    recordIntent({
      intentId,
      profile: context.profileName,
      providerAgentId,
      outcomeId,
      payer: context.payerAddress,
      amount: amountAtomic.toString(),
      state: "INTENT_RECORDED",
    });

    const authorized = await authorizePayment({
      policy: context.policy,
      signer: context.signer,
      challenge: { challenge, requirement, binding, viaChallengeTool: false },
      providerAgentId,
      outcomeId,
      // The caller is the human here: presenting a challenge file to this
      // command is the approval, and the price is the challenge's own.
      approvedQuoteAtomic: amountAtomic,
      intentId,
    });
    updateOrder(intentId, { state: "AUTHORIZED", authorizationNonce: authorized.nonce });

    return {
      signed: true,
      intentId,
      price: formatUsdc(amountAtomic),
      payer: context.payerAddress,
      paysTo: requirement.payTo,
      authorizationNonce: authorized.nonce,
      paymentPayload: authorized.submission,
    };
  } finally {
    await context.close();
  }
}

/**
 * The provider and outcome must be known to resolve splitter evidence. The
 * challenge's resource URL carries them on Daski's own challenges; otherwise
 * the caller states them, and a mismatch is refused rather than guessed.
 */
function resolveTarget(
  challenge: PaymentChallenge,
  options: SignPaymentOptions,
): { providerAgentId: string; outcomeId: string } {
  const url = (challenge.resource as { url?: unknown }).url;
  const parsed = typeof url === "string"
    ? /\/outcomes\/(\d+)\/([^/?#]+)/.exec(url)
    : null;
  const providerAgentId = options.providerAgentId ?? parsed?.[1];
  const outcomeId = options.outcomeId ?? (parsed?.[2] ? decodeURIComponent(parsed[2]) : undefined);
  if (!providerAgentId || !outcomeId) {
    throw new CliError({
      code: "DASKI_SIGN_PAYMENT_TARGET_UNKNOWN",
      message:
        "Could not determine which provider and outcome this challenge is for.",
      remediation:
        "Pass --provider <id> --outcome <id>. Without them the splitter cannot " +
        "be corroborated against the catalog, and the payment will not be signed.",
    });
  }
  if (parsed) {
    const [, urlProvider, urlOutcome] = parsed;
    if (
      (options.providerAgentId && options.providerAgentId !== urlProvider) ||
      (options.outcomeId && options.outcomeId !== decodeURIComponent(urlOutcome!))
    ) {
      throw new CliError({
        code: "DASKI_SIGN_PAYMENT_TARGET_MISMATCH",
        message:
          `--provider/--outcome name ${providerAgentId}/${outcomeId}, but the ` +
          `challenge's resource URL names ${urlProvider}/${decodeURIComponent(urlOutcome!)}.`,
        remediation:
          "These must agree, or the splitter would be checked against the wrong " +
          "catalog entry. Drop the flags to use the challenge's own target.",
      });
    }
  }
  return { providerAgentId, outcomeId };
}

/** Parses and shape-checks the challenge file. Unknown layouts are refused. */
function readChallenge(path: string): PaymentChallenge {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CliError({
      code: "DASKI_CHALLENGE_FILE_UNREADABLE",
      message: `Could not read ${path} as JSON: ${(error as Error).message}`,
      remediation: "Pass --challenge with a file containing one PaymentRequired object.",
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError({
      code: "DASKI_CHALLENGE_FILE_NOT_OBJECT",
      message: `${path} must contain a JSON object.`,
      remediation: "Save the gateway's PaymentRequired response to the file verbatim.",
    });
  }
  // The prepare tool's saved output nests the challenge under `paymentRequired`
  // beside its preflight; accept that file as well as a bare PaymentRequired.
  const nested = (parsed as { paymentRequired?: unknown }).paymentRequired;
  const challenge = (
    nested && typeof nested === "object" && !Array.isArray(nested) ? nested : parsed
  ) as PaymentChallenge;
  const requirement = challenge.accepts?.[0] as PaymentRequirement | undefined;
  if (challenge.x402Version !== 2 || !requirement || !challenge.resource) {
    throw new CliError({
      code: "DASKI_CHALLENGE_UNRECOGNIZED",
      message: `${path} is not an x402 V2 PaymentRequired document.`,
      remediation:
        "This command signs Daski recipe/stock challenges only. Anything else " +
        "is refused rather than signed.",
    });
  }
  if (
    requirement.scheme !== "exact" ||
    requirement.extra?.assetTransferMethod !== "eip3009" ||
    !/^eip155:\d+$/.test(requirement.network)
  ) {
    throw new CliError({
      code: "DASKI_CHALLENGE_UNSUPPORTED_RAIL",
      message:
        `${path} asks for scheme "${requirement.scheme}" on network ` +
        `"${requirement.network}" via "${String(requirement.extra?.assetTransferMethod)}".`,
      remediation:
        "Only the standard Exact-EVM eip3009 rail on an eip155 network is " +
        "signable here. An unknown rail is refused, never signed.",
    });
  }
  return challenge;
}
