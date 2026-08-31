/**
 * §4 — the policy validator.
 *
 * The one rule: the server proposes, the bridge validates against its *own*
 * expectations, recomputes what it can derive, and only then signs. Every
 * expectation in `PolicyConfig` is config- or catalog-sourced. Nothing in
 * here may be read out of the challenge being validated — that would be
 * asking the counterparty to grade its own homework.
 */
import { getAddress, parseUnits, type Address, type Hex } from "viem";
import { parseOrderBinding, type OrderBinding } from "./binding.js";
import {
  AUTHORIZATION_FIELDS,
  isClosedTransferWithAuthorizationTypes,
  TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE,
  type TransferAuthorization,
  type TypedDataRequest,
} from "./eip712.js";
import { refuse } from "./errors.js";
import { deriveBindingNonce } from "./recipe.js";

/** USDC and every asset this rail settles in carry 6 decimals. */
export const USDC_DECIMALS = 6;

/** Defaults for §4.1 check 6. Config may tighten these, never loosen them. */
export const DEFAULT_MAX_AUTHORIZATION_LIFETIME_SECONDS = 900;
export const DEFAULT_MIN_AUTHORIZATION_LIFETIME_SECONDS = 15;
export const DEFAULT_MAX_BACKDATE_SECONDS = 3600;

const DOC = "https://github.com/daski-io/buyer/blob/main/docs/policy.md";

/**
 * The splitter an outcome pays into, resolved independently of the challenge:
 * once from `daski_get_outcome`, once from `.well-known/daski-chain.json`.
 * Both must agree and both must name the address being paid (§4.1 check 4).
 */
export interface SplitterEvidence {
  /** `splitterAddress` / `payTo` from `daski_get_outcome`. */
  fromOutcome: Address;
  /** The matching outcome entry in `.well-known/daski-chain.json`. */
  fromChainManifest: Address;
}

/** Resolves splitter evidence for a provider+outcome pair. Implementations
 *  cache with a TTL; the validator itself holds no cache. */
export type SplitterResolver = (
  providerAgentId: string,
  outcomeId: string,
) => Promise<SplitterEvidence>;

/**
 * The running spend ledger. `@daski/pay` backs this with the on-disk order
 * store; a host app may back it with anything, but it must be real — the
 * session cap is meaningless if the total always reads zero.
 */
export interface SessionLedger {
  /** Atomic units already authorized in this session. */
  spentAtomic(): Promise<bigint> | bigint;
  /** True when an order already exists for this payment identifier. */
  hasOrderFor(paymentIdentifier: string): Promise<boolean> | boolean;
}

/**
 * The host-supplied policy. No config, no signing: both packages refuse to
 * construct a signer without one.
 *
 * The three caps are human-owned (§4.2). Nothing at runtime may raise them:
 * `@daski/pay` reads them only from `~/.daski/config.json`, and flags may
 * lower them for a single invocation but never raise them.
 */
export interface PolicyConfig {
  /** The address that must appear as `message.from`. */
  payerAddress: Address;
  /** Pinned chain id for the active profile (sandbox: 84532). */
  chainId: number;
  /** Pinned canonical token for the active profile (sandbox USDC). */
  canonicalToken: Address;
  /** Human-owned per-order ceiling, as a decimal USDC string. */
  maxPerOrderUsdc: string;
  /** Human-owned session ceiling, as a decimal USDC string. */
  sessionCapUsdc: string;
  /** Independent splitter evidence. Required for purchase authorizations. */
  resolveSplitter: SplitterResolver;
  /** Running spend and prior-order lookup. */
  session: SessionLedger;
  /** Tighter-than-default authorization window bounds, if desired. */
  maxAuthorizationLifetimeSeconds?: number;
  minAuthorizationLifetimeSeconds?: number;
  maxBackdateSeconds?: number;
}

/** The purchase-specific facts the validator checks a proposal against. */
export interface PurchaseExpectations {
  providerAgentId: string;
  outcomeId: string;
  /** `accepts[].amount` from the challenge, in atomic units. */
  challengeAmountAtomic: bigint;
  /** `accepts[].asset` from the challenge. */
  challengeAsset: Address;
  /** `accepts[].payTo` from the challenge. */
  challengePayTo: Address;
  /** `accepts[].network` from the challenge. */
  challengeNetwork: string;
  /** The quote a human actually approved, in atomic units. */
  approvedQuoteAtomic: bigint;
  /** The `payment-identifier` id this purchase carries, if any. */
  paymentIdentifier?: string | undefined;
  /** The parsed order binding, when the challenge carried one. */
  binding?: OrderBinding | undefined;
  /** Seconds since epoch; injectable so tests are not clock-dependent. */
  nowSeconds?: number;
}

export interface ValidatedPurchase {
  authorization: TransferAuthorization;
  binding: OrderBinding | undefined;
  amountAtomic: bigint;
  /** The nonce the bridge recomputed. Equal to the proposal's, or we refused. */
  recomputedNonce: Hex;
}

function atomic(usdc: string, field: string): bigint {
  try {
    return parseUnits(usdc, USDC_DECIMALS);
  } catch {
    return refuse({
      check: "amount-and-caps",
      code: "DASKI_POLICY_CAP_UNPARSEABLE",
      expected: `${field} to be a decimal USDC amount, e.g. "25.00"`,
      actual: `${field}=${usdc}`,
      remediation: `Fix ${field} in ~/.daski/config.json; see ${DOC}#caps`,
    });
  }
}

function formatUsdc(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const unit = 10n ** BigInt(USDC_DECIMALS);
  const whole = magnitude / unit;
  const fraction = (magnitude % unit).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""} USDC`;
}

/**
 * Validates a proposed purchase authorization against every §4.1 assertion,
 * then recomputes the recipe nonce and requires equality.
 *
 * Returns the authorization the caller may sign. Throws `PolicyRefusal` —
 * never a repaired payload — on any failure.
 */
export async function validatePurchaseAuthorization(
  config: PolicyConfig,
  proposal: TypedDataRequest,
  expectations: PurchaseExpectations,
): Promise<ValidatedPurchase> {
  const now = expectations.nowSeconds ?? Math.floor(Date.now() / 1_000);

  // -- §4.1.1 chain and verifying contract are pinned by profile ------------
  if (proposal.domain.chainId !== config.chainId) {
    refuse({
      check: "chain-pinning",
      code: "DASKI_POLICY_CHAIN_MISMATCH",
      expected: `chainId ${config.chainId}`,
      actual: `chainId ${String(proposal.domain.chainId)}`,
      remediation:
        "The challenge targets a different chain than the active profile. " +
        `Switch profiles or refuse the purchase; see ${DOC}#chain-pinning`,
    });
  }
  const verifyingContract = safeAddress(
    proposal.domain.verifyingContract,
    "domain.verifyingContract",
  );
  if (verifyingContract !== getAddress(config.canonicalToken)) {
    refuse({
      check: "chain-pinning",
      code: "DASKI_POLICY_TOKEN_NOT_CANONICAL",
      expected: `verifyingContract ${getAddress(config.canonicalToken)}`,
      actual: `verifyingContract ${verifyingContract}`,
      remediation:
        "Only the profile's canonical USDC contract may be signed against. " +
        `See ${DOC}#chain-pinning`,
    });
  }
  const challengeAsset = safeAddress(expectations.challengeAsset, "accepts[].asset");
  if (challengeAsset !== getAddress(config.canonicalToken)) {
    refuse({
      check: "chain-pinning",
      code: "DASKI_POLICY_ASSET_NOT_CANONICAL",
      expected: `asset ${getAddress(config.canonicalToken)}`,
      actual: `asset ${challengeAsset}`,
      remediation: `Non-canonical assets are never signed; see ${DOC}#chain-pinning`,
    });
  }
  if (expectations.challengeNetwork !== `eip155:${config.chainId}`) {
    refuse({
      check: "chain-pinning",
      code: "DASKI_POLICY_NETWORK_MISMATCH",
      expected: `network eip155:${config.chainId}`,
      actual: `network ${expectations.challengeNetwork}`,
      remediation: `See ${DOC}#chain-pinning`,
    });
  }

  // -- §4.1.2 the closed 6-field type set, and nothing else -----------------
  if (proposal.primaryType !== TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE) {
    refuse({
      check: "typed-data-shape",
      code: "DASKI_POLICY_PRIMARY_TYPE_MISMATCH",
      expected: TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE,
      actual: String(proposal.primaryType),
      remediation:
        "This bridge signs exactly one purchase type. Anything else must be " +
        `refused; see ${DOC}#typed-data-shape`,
    });
  }
  if (!isClosedTransferWithAuthorizationTypes(proposal.types)) {
    refuse({
      check: "typed-data-shape",
      code: "DASKI_POLICY_TYPES_NOT_CLOSED",
      expected: "the closed 6-field TransferWithAuthorization type set",
      actual: `types=${JSON.stringify(proposal.types)}`,
      remediation:
        "An altered or extended type set changes what the signature means. " +
        `See ${DOC}#typed-data-shape`,
    });
  }
  const messageKeys = Object.keys(proposal.message).sort();
  if (messageKeys.join(",") !== [...AUTHORIZATION_FIELDS].sort().join(",")) {
    refuse({
      check: "typed-data-shape",
      code: "DASKI_POLICY_MESSAGE_OPEN_SHAPE",
      expected: `exactly [${[...AUTHORIZATION_FIELDS].sort().join(", ")}]`,
      actual: `[${messageKeys.join(", ")}]`,
      remediation: `See ${DOC}#typed-data-shape`,
    });
  }

  // -- §4.1.3 the payer is our own configured address -----------------------
  const from = safeAddress(proposal.message.from, "message.from");
  if (from !== getAddress(config.payerAddress)) {
    refuse({
      check: "payer-match",
      code: "DASKI_POLICY_PAYER_MISMATCH",
      expected: `from ${getAddress(config.payerAddress)}`,
      actual: `from ${from}`,
      remediation:
        "The challenge names a different payer than the active signer. Run " +
        `\`daski doctor --json\` to see the active address; see ${DOC}#payer`,
    });
  }

  // -- §4.1.4 the recipient is an allowlisted splitter ----------------------
  const to = safeAddress(proposal.message.to, "message.to");
  const challengePayTo = safeAddress(expectations.challengePayTo, "accepts[].payTo");
  if (to !== challengePayTo) {
    refuse({
      check: "splitter-allowlist",
      code: "DASKI_POLICY_PAYTO_MISMATCH",
      expected: `to ${challengePayTo} (the challenge's accepts[].payTo)`,
      actual: `to ${to}`,
      remediation: `See ${DOC}#splitter-allowlist`,
    });
  }
  const evidence = await config.resolveSplitter(
    expectations.providerAgentId,
    expectations.outcomeId,
  );
  const fromOutcome = safeAddress(evidence.fromOutcome, "daski_get_outcome payTo");
  const fromManifest = safeAddress(evidence.fromChainManifest, "daski-chain.json payTo");
  if (fromOutcome !== fromManifest) {
    refuse({
      check: "splitter-allowlist",
      code: "DASKI_POLICY_SPLITTER_EVIDENCE_DISAGREES",
      expected: "daski_get_outcome and .well-known/daski-chain.json to name one splitter",
      actual: `outcome=${fromOutcome} manifest=${fromManifest}`,
      remediation:
        "Two independent sources disagree about who gets paid. Do not sign; " +
        `report this to the gateway operator. See ${DOC}#splitter-allowlist`,
    });
  }
  if (to !== fromOutcome) {
    refuse({
      check: "splitter-allowlist",
      code: "DASKI_POLICY_SPLITTER_NOT_ALLOWLISTED",
      expected: `to ${fromOutcome} for ${expectations.providerAgentId}/${expectations.outcomeId}`,
      actual: `to ${to}`,
      remediation:
        "The challenge pays an address the catalog does not list for this " +
        `outcome. Do not sign; see ${DOC}#splitter-allowlist`,
    });
  }

  // -- §4.1.5 amount matches the challenge, the approved quote, and the caps -
  const value = safeUint(proposal.message.value, "message.value");
  if (value !== expectations.challengeAmountAtomic) {
    refuse({
      check: "amount-and-caps",
      code: "DASKI_POLICY_VALUE_MISMATCH",
      expected: `value ${expectations.challengeAmountAtomic} (accepts[].amount)`,
      actual: `value ${value}`,
      remediation: `See ${DOC}#amount`,
    });
  }
  if (value !== expectations.approvedQuoteAtomic) {
    refuse({
      check: "amount-and-caps",
      code: "DASKI_POLICY_QUOTE_NOT_APPROVED",
      expected: `value ${expectations.approvedQuoteAtomic} (${formatUsdc(expectations.approvedQuoteAtomic)}, the approved quote)`,
      actual: `value ${value} (${formatUsdc(value)})`,
      remediation:
        "The price moved between approval and signing. Re-run the purchase to " +
        `approve the new quote; see ${DOC}#amount`,
    });
  }
  const maxPerOrder = atomic(config.maxPerOrderUsdc, "maxPerOrderUsdc");
  if (value > maxPerOrder) {
    refuse({
      check: "amount-and-caps",
      code: "DASKI_POLICY_PER_ORDER_CAP_EXCEEDED",
      expected: `at most ${formatUsdc(maxPerOrder)} per order`,
      actual: formatUsdc(value),
      remediation:
        "Caps are human-owned: raise `maxPerOrderUsdc` in ~/.daski/config.json " +
        `by hand, or buy something cheaper. See ${DOC}#caps`,
    });
  }
  const sessionCap = atomic(config.sessionCapUsdc, "sessionCapUsdc");
  const spent = BigInt(await config.session.spentAtomic());
  if (spent + value > sessionCap) {
    refuse({
      check: "amount-and-caps",
      code: "DASKI_POLICY_SESSION_CAP_EXCEEDED",
      expected: `session total at most ${formatUsdc(sessionCap)}`,
      actual: `${formatUsdc(spent)} already authorized plus ${formatUsdc(value)}`,
      remediation:
        "Caps are human-owned: raise `sessionCapUsdc` in ~/.daski/config.json " +
        `by hand. See ${DOC}#caps`,
    });
  }

  // -- §4.1.6 the authorization window is sane ------------------------------
  const validAfter = safeUint(proposal.message.validAfter, "message.validAfter");
  const validBefore = safeUint(proposal.message.validBefore, "message.validBefore");
  const maxBackdate = BigInt(config.maxBackdateSeconds ?? DEFAULT_MAX_BACKDATE_SECONDS);
  const maxLifetime = BigInt(
    config.maxAuthorizationLifetimeSeconds ?? DEFAULT_MAX_AUTHORIZATION_LIFETIME_SECONDS,
  );
  const minLifetime = BigInt(
    config.minAuthorizationLifetimeSeconds ?? DEFAULT_MIN_AUTHORIZATION_LIFETIME_SECONDS,
  );
  const nowBig = BigInt(now);
  if (validAfter !== 0n && (validAfter < nowBig - maxBackdate || validAfter > nowBig)) {
    refuse({
      check: "authorization-window",
      code: "DASKI_POLICY_VALID_AFTER_OUT_OF_RANGE",
      expected: `validAfter to be 0 or within [${nowBig - maxBackdate}, ${nowBig}]`,
      actual: `validAfter ${validAfter}`,
      remediation:
        "A back- or future-dated authorization is not one this bridge will " +
        `sign; request a fresh challenge. See ${DOC}#window`,
    });
  }
  const lifetime = validBefore - nowBig;
  if (lifetime > maxLifetime) {
    refuse({
      check: "authorization-window",
      code: "DASKI_POLICY_WINDOW_TOO_LONG",
      expected: `validBefore at most ${maxLifetime}s out`,
      actual: `${lifetime}s out`,
      remediation:
        "A long-lived authorization is a long-lived liability; request a " +
        `shorter challenge. See ${DOC}#window`,
    });
  }
  if (lifetime <= minLifetime) {
    refuse({
      check: "authorization-window",
      code: "DASKI_POLICY_WINDOW_TOO_SHORT",
      expected: `validBefore more than ${minLifetime}s out`,
      actual: `${lifetime}s out`,
      remediation:
        "This challenge expires too soon to settle safely; request a fresh " +
        `one. See ${DOC}#window`,
    });
  }

  // -- §4.1.7 the payment identifier is ours, and unspent -------------------
  if (expectations.paymentIdentifier !== undefined) {
    if (await config.session.hasOrderFor(expectations.paymentIdentifier)) {
      refuse({
        check: "payment-identifier",
        code: "DASKI_POLICY_IDENTIFIER_ALREADY_ORDERED",
        expected: "an unused payment identifier",
        actual: `identifier ${expectations.paymentIdentifier} already has a stored order`,
        remediation:
          "An order already exists for this intent. Reconcile before re-signing: " +
          `run \`daski order status <handle>\`. See ${DOC}#reconciliation`,
      });
    }
  }

  // -- §4.3 recompute the recipe nonce and require equality -----------------
  const nonce = safeHex32(proposal.message.nonce, "message.nonce");
  const binding = expectations.binding;
  let recomputedNonce = nonce;
  if (binding) {
    if (BigInt(binding.expiresAt) < validBefore) {
      refuse({
        check: "authorization-window",
        code: "DASKI_POLICY_WINDOW_OUTLIVES_BINDING",
        expected: `validBefore at most the binding's expiresAt ${binding.expiresAt}`,
        actual: `validBefore ${validBefore}`,
        remediation:
          "The authorization would outlive the deal it is bound to; request a " +
          `fresh challenge. See ${DOC}#window`,
      });
    }
    recomputedNonce = deriveBindingNonce(binding, {
      chainId: config.chainId,
      canonicalToken: getAddress(config.canonicalToken),
      payer: from,
      splitter: to,
      grossAmount: value,
    });
    if (recomputedNonce.toLowerCase() !== nonce.toLowerCase()) {
      refuse({
        check: "recipe-recompute",
        code: "DASKI_POLICY_RECIPE_NONCE_MISMATCH",
        expected: `nonce ${recomputedNonce} (recomputed from the ${binding.profile} binding)`,
        actual: `nonce ${nonce}`,
        remediation:
          "The proposed nonce does not commit to the deal we were shown. This " +
          "is exactly the case blind signing would miss. Do not retry; report " +
          `it to the gateway operator. See ${DOC}#recipe`,
      });
    }
  }

  return {
    authorization: {
      from,
      to,
      value: value.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    },
    binding,
    amountAtomic: value,
    recomputedNonce,
  };
}

/** Parses the binding out of a challenge's extensions, refusing open shapes. */
export function bindingFromExtensions(
  extensions: Record<string, unknown> | undefined,
): OrderBinding | undefined {
  return parseOrderBinding(extensions?.["daski-order-binding"]);
}

function safeAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    refuse({
      check: "typed-data-shape",
      code: "DASKI_POLICY_MALFORMED_ADDRESS",
      expected: `${field} to be a 20-byte hex address`,
      actual: `${field}=${String(value)}`,
      remediation: `Request a fresh challenge; see ${DOC}`,
    });
  }
  return getAddress(value);
}

function safeUint(value: unknown, field: string): bigint {
  const raw = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^\d+$/.test(raw)) {
    refuse({
      check: "typed-data-shape",
      code: "DASKI_POLICY_MALFORMED_UINT",
      expected: `${field} to be a non-negative integer`,
      actual: `${field}=${raw}`,
      remediation: `Request a fresh challenge; see ${DOC}`,
    });
  }
  return BigInt(raw);
}

function safeHex32(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    refuse({
      check: "typed-data-shape",
      code: "DASKI_POLICY_MALFORMED_BYTES32",
      expected: `${field} to be a 32-byte hex string`,
      actual: `${field}=${String(value)}`,
      remediation: `Request a fresh challenge; see ${DOC}`,
    });
  }
  return value as Hex;
}

export { formatUsdc, atomic as parseUsdcToAtomic };
