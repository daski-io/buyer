/**
 * §3 — the composite Exact-EVM client.
 *
 * This is a *wrapper*, not a replacement. The facilitator knows one scheme
 * name, `exact`, so inventing a second one would make our payments
 * unverifiable; and clobbering the stock handler for a network would silently
 * change the semantics of every non-Daski payment the host makes. So:
 *
 *   - `scheme` stays `"exact"`;
 *   - a challenge without `daski-order-binding` is handed to the stock
 *     handler untouched, context and all;
 *   - a challenge with one takes the Daski path, which validates and
 *     recomputes before it signs.
 *
 * Hooks and `findDefaultAsset` are forwarded so the host's spend controls and
 * money parsing keep working exactly as they did before registration.
 */
import { getAddress, type Address } from "viem";
import { bindingFromExtensions, validatePurchaseAuthorization, type PolicyConfig } from "./policy.js";
import { transferWithAuthorizationTypedData, type TransferAuthorization } from "./eip712.js";
import { refuse } from "./errors.js";
import {
  DASKI_ORDER_BINDING,
  DASKI_SIGN_REQUEST,
  issuedPaymentIdentifier,
  paymentEchoExtensions,
  withPaymentIdentifier,
} from "./extensions.js";
import { deriveBindingNonce } from "./recipe.js";
import { parseSignRequest } from "./signRequest.js";
import type { SignerAdapter } from "./signer.js";

/** Structural mirrors of the `@x402/core` types, so this package needs no
 *  value import from the SDK and stays usable with any 2.x host. */
export interface PaymentRequirementsLike {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: { assetTransferMethod?: string; name?: string; version?: string } | undefined;
}

export interface PaymentPayloadContextLike {
  extensions?: Record<string, unknown> | undefined;
}

export interface PaymentPayloadResultLike {
  x402Version: number;
  payload: unknown;
  extensions?: Record<string, unknown>;
}

/** The subset of `SchemeNetworkClient` this package produces and consumes. */
export interface SchemeNetworkClientLike {
  readonly scheme: string;
  readonly schemeHooks?: unknown;
  findDefaultAsset?: unknown;
  createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirementsLike,
    context?: PaymentPayloadContextLike,
  ): Promise<PaymentPayloadResultLike>;
}

/**
 * Resolves the purchase this challenge belongs to, and the quote a human
 * approved for it. The scheme cannot infer either from the challenge — that
 * would be the counterparty supplying its own expectations — so the host app
 * states them.
 */
export interface PurchaseContextResolver {
  (requirements: PaymentRequirementsLike, context: PaymentPayloadContextLike | undefined): Promise<{
    providerAgentId: string;
    outcomeId: string;
    /** Atomic units the human approved. */
    approvedQuoteAtomic: bigint;
    /** Idempotency key for this intent; also the reconciliation key. */
    paymentIdentifier?: string | undefined;
  }>;
}

export interface DaskiExactEvmSchemeOptions {
  /** The wallet. Never the gateway's. */
  signer: SignerAdapter;
  /** Resolved once so the stock handler's synchronous `address` works. */
  payerAddress: Address;
  /** §4 policy. Without it there is no signing. */
  policy: PolicyConfig;
  /** The stock handler this composite wraps. */
  stock: SchemeNetworkClientLike;
  /** How the host names the purchase and the approved quote. */
  resolvePurchaseContext: PurchaseContextResolver;
  /** Injectable clock, for tests. */
  now?: () => number;
}

/** Backdate tolerance applied to `validAfter` on the locally-computed path. */
const AUTHORIZATION_CLOCK_SKEW_SECONDS = 30;

export class DaskiExactEvmScheme implements SchemeNetworkClientLike {
  /** The facilitator knows exactly one name. We do not invent a second. */
  readonly scheme = "exact";

  readonly #options: DaskiExactEvmSchemeOptions;

  constructor(options: DaskiExactEvmSchemeOptions) {
    if (!options.policy) {
      refuse({
        check: "challenge-shape",
        code: "DASKI_SCHEME_POLICY_REQUIRED",
        expected: "a PolicyConfig",
        remediation:
          "No config, no signing. Supply a PolicyConfig when constructing " +
          "DaskiExactEvmScheme.",
      });
    }
    this.#options = options;
  }

  /** Forwarded so the host's spend controls keep resolving default assets. */
  get findDefaultAsset(): unknown {
    return this.#options.stock.findDefaultAsset;
  }

  /** Forwarded so registering the composite does not drop stock hooks. */
  get schemeHooks(): unknown {
    return this.#options.stock.schemeHooks;
  }

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirementsLike,
    context?: PaymentPayloadContextLike,
  ): Promise<PaymentPayloadResultLike> {
    const extensions = context?.extensions;
    // Not a Daski challenge: the stock handler owns this entirely.
    if (extensions?.[DASKI_ORDER_BINDING] === undefined) {
      return this.#options.stock.createPaymentPayload(x402Version, requirements, context);
    }
    return this.#createDaskiPayload(x402Version, requirements, context);
  }

  async #createDaskiPayload(
    x402Version: number,
    requirements: PaymentRequirementsLike,
    context: PaymentPayloadContextLike | undefined,
  ): Promise<PaymentPayloadResultLike> {
    const { policy, signer } = this.#options;
    if (x402Version !== 2) {
      refuse({
        check: "challenge-shape",
        code: "DASKI_SCHEME_VERSION_UNSUPPORTED",
        expected: "x402 version 2",
        actual: `version ${x402Version}`,
        remediation: "Daski settles on x402 V2 only.",
      });
    }
    assertExactEvmRequirement(requirements);

    const issued = context?.extensions ?? {};
    const binding = bindingFromExtensions(issued);
    const purchase = await this.#options.resolvePurchaseContext(requirements, context);
    const now = (this.#options.now ?? (() => Math.floor(Date.now() / 1_000)))();

    // The server may propose the whole document; we still recompute it and
    // require agreement, so the proposal is an input, never an authority.
    const proposed = parseSignRequest(issued[DASKI_SIGN_REQUEST]);
    const domain = {
      name: requirements.extra!.name!,
      version: requirements.extra!.version!,
      chainId: policy.chainId,
      verifyingContract: getAddress(requirements.asset),
    };
    const authorization = proposed
      ? authorizationFromProposal(proposed)
      : this.#computeAuthorization(requirements, binding, now);
    const typedData = proposed ?? transferWithAuthorizationTypedData(domain, authorization);

    const identifier = purchase.paymentIdentifier ?? issuedPaymentIdentifier(issued);
    const validated = await validatePurchaseAuthorization(policy, typedData, {
      providerAgentId: purchase.providerAgentId,
      outcomeId: purchase.outcomeId,
      challengeAmountAtomic: BigInt(requirements.amount),
      challengeAsset: getAddress(requirements.asset),
      challengePayTo: getAddress(requirements.payTo),
      challengeNetwork: requirements.network,
      approvedQuoteAtomic: purchase.approvedQuoteAtomic,
      paymentIdentifier: identifier,
      binding,
      nowSeconds: now,
    });

    const signature = await signer.signTypedData(
      transferWithAuthorizationTypedData(domain, validated.authorization),
    );

    return {
      x402Version,
      payload: { authorization: validated.authorization, signature },
      extensions: withPaymentIdentifier(paymentEchoExtensions(issued), identifier),
    };
  }

  /**
   * The verify-and-sign tier: build the authorization ourselves from the
   * binding, so a gateway that ships no `daski-sign-request` is fully
   * supported and the recompute path stays exercised.
   */
  #computeAuthorization(
    requirements: PaymentRequirementsLike,
    binding: ReturnType<typeof bindingFromExtensions>,
    now: number,
  ): TransferAuthorization {
    const { policy } = this.#options;
    const payer = getAddress(policy.payerAddress);
    const splitter = getAddress(requirements.payTo);
    const grossAmount = BigInt(requirements.amount);
    const validAfter = binding
      ? BigInt(Math.max(0, now - AUTHORIZATION_CLOCK_SKEW_SECONDS))
      : 0n;
    const validBefore = BigInt(Math.min(
      now + requirements.maxTimeoutSeconds,
      binding?.expiresAt ?? Number.MAX_SAFE_INTEGER,
    ));
    const nonce = binding
      ? deriveBindingNonce(binding, {
          chainId: policy.chainId,
          canonicalToken: getAddress(policy.canonicalToken),
          payer,
          splitter,
          grossAmount,
        })
      : refuse({
          check: "recipe-recompute",
          code: "DASKI_SCHEME_BINDING_REQUIRED",
          expected: "a daski-order-binding extension on the Daski path",
          remediation:
            "A Daski purchase without a binding cannot be recomputed. Request a " +
            "fresh challenge.",
        });
    return {
      from: payer,
      to: splitter,
      value: grossAmount.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    };
  }
}

function authorizationFromProposal(proposal: {
  message: Record<string, unknown>;
}): TransferAuthorization {
  const message = proposal.message;
  return {
    from: String(message.from) as Address,
    to: String(message.to) as Address,
    value: String(message.value),
    validAfter: String(message.validAfter),
    validBefore: String(message.validBefore),
    nonce: String(message.nonce) as `0x${string}`,
  };
}

function assertExactEvmRequirement(requirements: PaymentRequirementsLike): void {
  if (requirements.scheme !== "exact") {
    refuse({
      check: "challenge-shape",
      code: "DASKI_SCHEME_UNSUPPORTED_SCHEME",
      expected: "scheme exact",
      actual: `scheme ${requirements.scheme}`,
      remediation: "Daski settles only on the standard Exact-EVM rail.",
    });
  }
  const extra = requirements.extra;
  if (
    extra?.assetTransferMethod !== "eip3009" || !extra.name || !extra.version ||
    !/^\d+$/.test(requirements.amount) ||
    !Number.isSafeInteger(requirements.maxTimeoutSeconds) ||
    requirements.maxTimeoutSeconds <= 10
  ) {
    refuse({
      check: "challenge-shape",
      code: "DASKI_SCHEME_REQUIREMENT_INCOMPLETE",
      expected: "eip3009 transfer metadata, an integer amount, and a sane timeout",
      actual: `assetTransferMethod=${String(extra?.assetTransferMethod)} amount=${requirements.amount}`,
      remediation: "Request a fresh challenge from the gateway.",
    });
  }
}
