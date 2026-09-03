/**
 * §4.1 check 8 — the lifecycle variant of the policy validator.
 *
 * Order actions and wallet queries are authorized with their own EIP-712
 * families. They move no money, but they do move *authority*, so they get the
 * same treatment: closed type sets, an orderId that matches the order we
 * meant to touch, method and URI hash inputs recomputed from what the CLI is
 * actually about to call, and a short expiry.
 *
 * Because the gateway derives the challenge's `absoluteResourceUri` and
 * `requestHash` deterministically, the bridge recomputes both rather than
 * accepting them. A challenge that hashes a different request than the one we
 * are about to send is a challenge for someone else's call.
 */
import { getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { canonicalHash } from "./canonical.js";
import { refuse } from "./errors.js";
import type { TypedDataRequest } from "./eip712.js";

const DOC = "https://github.com/daski-io/buyer/blob/main/docs/policy.md#lifecycle";
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

/** Order lifecycle actions, as the gateway names them. */
export type OrderAction =
  | "status" | "input" | "cancel" | "artifact" | "support"
  | "confirmation" | "revoke-confirmation";

/** The closed 9-field order-action family. */
export const ORDER_ACTION_TYPES = {
  OrderActionAuthorizationV1: [
    { name: "orderIdHash", type: "bytes32" },
    { name: "actionHash", type: "bytes32" },
    { name: "methodHash", type: "bytes32" },
    { name: "absoluteResourceUriHash", type: "bytes32" },
    { name: "requestHash", type: "bytes32" },
    { name: "audienceHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "validBefore", type: "uint64" },
  ],
} as const;

/** The closed 17-field wallet-action family, used by payer-scoped queries. */
export const WALLET_ACTION_TYPES = {
  WalletActionAuthorizationV1: [
    { name: "payer", type: "address" },
    { name: "providerAgentId", type: "uint256" },
    { name: "serviceId", type: "bytes32" },
    { name: "providerControlProfileHash", type: "bytes32" },
    { name: "servicingAdmissionHash", type: "bytes32" },
    { name: "actionCatalogHash", type: "bytes32" },
    { name: "actionCatalogSchemaHash", type: "bytes32" },
    { name: "actionDefinitionHash", type: "bytes32" },
    { name: "actionCatalogEpoch", type: "uint64" },
    { name: "actionHash", type: "bytes32" },
    { name: "methodHash", type: "bytes32" },
    { name: "absoluteResourceUriHash", type: "bytes32" },
    { name: "requestHash", type: "bytes32" },
    { name: "audienceHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "validBefore", type: "uint64" },
  ],
} as const;

const ORDER_CHALLENGE_FIELDS = [
  "orderId", "action", "method", "absoluteResourceUri", "requestHash",
  "nonce", "issuedAt", "validBefore",
] as const;

const WALLET_MESSAGE_FIELDS = WALLET_ACTION_TYPES.WalletActionAuthorizationV1
  .map((field) => field.name);

/** The longest lifecycle authorization this bridge will sign. */
export const MAX_LIFECYCLE_LIFETIME_SECONDS = 300;
/** Tolerance for a gateway clock running slightly ahead of ours. */
export const LIFECYCLE_CLOCK_SKEW_SECONDS = 30;

export interface OrderActionChallenge {
  orderId: string;
  action: OrderAction;
  method: "POST";
  absoluteResourceUri: string;
  requestHash: Hex;
  nonce: Hex;
  issuedAt: number;
  validBefore: number;
}

export interface OrderActionAuthorization extends OrderActionChallenge {
  signature: Hex;
}

/** What the CLI is about to do, stated before the challenge is read. */
export interface OrderActionExpectations {
  /** The handle the CLI resolved from its own order store. */
  orderHandle: string;
  /** The action the CLI is performing. */
  action: OrderAction;
  /** The gateway base URL from the active profile. */
  gatewayUrl: string;
  /** The exact request body the CLI will send. */
  request: Record<string, unknown>;
  nowSeconds?: number;
  /** The profile's chain id, so a server-proposed signRequest domain can be checked. */
  chainId?: number;
}

/**
 * The URI the gateway derives for an order action. Recomputing it is what
 * turns "the server said this URI" into "this URI is the one we would call".
 */
export function orderActionResourceUri(
  gatewayUrl: string,
  orderHandle: string,
  action: OrderAction,
): string {
  const base = gatewayUrl.replace(/\/$/, "");
  return `${base}/orders/${encodeURIComponent(orderHandle)}/actions/${action}`;
}

/** Parses and validates an order-action challenge against §4.1 check 8. */
export function validateOrderActionChallenge(
  value: unknown,
  expectations: OrderActionExpectations,
): OrderActionChallenge {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    refuse({
      check: "lifecycle-binding",
      code: "DASKI_LIFECYCLE_CHALLENGE_NOT_AN_OBJECT",
      expected: "an order-action challenge object",
      actual: Array.isArray(value) ? "an array" : typeof value,
      remediation: `Retry the lifecycle call; see ${DOC}`,
    });
  }
  // Sign-ready gateways attach the complete EIP-712 proposal as `signRequest`
  // beside the challenge fields. This bridge recomputes the typed data itself
  // and never signs the proposal, so it is set aside for the closed-shape check
  // and compared with the recomputation at the end. Refusing it as an open
  // shape failed every live lifecycle call and wallet query (2026-09-03).
  const { challenge, signRequest } = splitSignRequest(value as Record<string, unknown>);
  const keys = Object.keys(challenge).sort();
  if (keys.join(",") !== [...ORDER_CHALLENGE_FIELDS].sort().join(",")) {
    refuse({
      check: "lifecycle-binding",
      code: "DASKI_LIFECYCLE_CHALLENGE_OPEN_SHAPE",
      expected: `exactly [${[...ORDER_CHALLENGE_FIELDS].sort().join(", ")}]`,
      actual: `[${keys.join(", ")}]`,
      remediation: `Upgrade @daski/x402-scheme; see ${DOC}`,
    });
  }
  if (
    typeof challenge.orderId !== "string" || challenge.orderId.length === 0 ||
    typeof challenge.absoluteResourceUri !== "string" ||
    !HEX32.test(String(challenge.requestHash)) || !HEX32.test(String(challenge.nonce)) ||
    !Number.isSafeInteger(challenge.issuedAt) || !Number.isSafeInteger(challenge.validBefore)
  ) {
    refuse({
      check: "lifecycle-binding",
      code: "DASKI_LIFECYCLE_CHALLENGE_MALFORMED",
      expected: "well-formed orderId, URI, hashes and timestamps",
      actual: "one or more fields are malformed",
      remediation: `Retry the lifecycle call; see ${DOC}`,
    });
  }
  if (challenge.method !== "POST") {
    refuse({
      check: "lifecycle-binding",
      code: "DASKI_LIFECYCLE_METHOD_UNEXPECTED",
      expected: "method POST",
      actual: `method ${String(challenge.method)}`,
      remediation: `See ${DOC}`,
    });
  }
  if (challenge.action !== expectations.action) {
    refuse({
      check: "lifecycle-binding",
      code: "DASKI_LIFECYCLE_ACTION_MISMATCH",
      expected: `action ${expectations.action}`,
      actual: `action ${String(challenge.action)}`,
      remediation:
        "The challenge authorizes a different action than the one requested. " +
        `Do not sign it; see ${DOC}`,
    });
  }

  // The URI is derived, not declared: recompute and require equality. This is
  // the check that stops a challenge from pointing our signature at another
  // order or another host.
  const expectedUri = orderActionResourceUri(
    expectations.gatewayUrl,
    expectations.orderHandle,
    expectations.action,
  );
  if (challenge.absoluteResourceUri !== expectedUri) {
    refuse({
      check: "lifecycle-binding",
      code: "DASKI_LIFECYCLE_URI_MISMATCH",
      expected: expectedUri,
      actual: challenge.absoluteResourceUri,
      remediation:
        "The challenge binds a resource URI we did not ask to call — a " +
        `different order, action, or host. Do not sign it; see ${DOC}`,
    });
  }
  if (!/^https:\/\//.test(challenge.absoluteResourceUri)) {
    refuse({
      check: "lifecycle-binding",
      code: "DASKI_LIFECYCLE_URI_NOT_HTTPS",
      expected: "an https:// resource URI",
      actual: challenge.absoluteResourceUri,
      remediation: `See ${DOC}`,
    });
  }

  // Likewise the request hash: recompute it over the body we are about to send.
  const expectedRequestHash = canonicalHash(expectations.request);
  if (String(challenge.requestHash).toLowerCase() !== expectedRequestHash.toLowerCase()) {
    refuse({
      check: "lifecycle-binding",
      code: "DASKI_LIFECYCLE_REQUEST_HASH_MISMATCH",
      expected: `requestHash ${expectedRequestHash} (recomputed from the outgoing request)`,
      actual: `requestHash ${String(challenge.requestHash)}`,
      remediation:
        "The challenge commits to a different request body than the one we " +
        `are about to send. Do not sign it; see ${DOC}`,
    });
  }

  assertShortLived(Number(challenge.issuedAt), Number(challenge.validBefore),
    expectations.nowSeconds);

  const validated = challenge as unknown as OrderActionChallenge;
  if (signRequest) {
    const proposedDomain = signRequest.domain as Record<string, unknown> | undefined;
    const chainId = expectations.chainId ?? Number(proposedDomain?.chainId);
    assertSignRequestAgrees(
      signRequest,
      orderActionTypedData(validated, chainId, expectations.gatewayUrl),
      "order-action challenge",
    );
  }
  return validated;
}

/**
 * The typed-data payload for a validated order-action challenge. Every hash
 * input is computed here from the validated challenge — the signer is handed
 * a message this package built, not one the gateway sent.
 */
export function orderActionTypedData(
  challenge: OrderActionChallenge,
  chainId: number,
  audience: string,
): TypedDataRequest {
  return {
    domain: { name: "DaskiStandardOrder", version: "1", chainId } as never,
    types: ORDER_ACTION_TYPES,
    primaryType: "OrderActionAuthorizationV1",
    message: {
      orderIdHash: keccak256(stringToHex(challenge.orderId)),
      actionHash: keccak256(stringToHex(challenge.action)),
      methodHash: keccak256(stringToHex(challenge.method)),
      absoluteResourceUriHash: keccak256(stringToHex(challenge.absoluteResourceUri)),
      requestHash: challenge.requestHash,
      audienceHash: keccak256(stringToHex(audience)),
      nonce: challenge.nonce,
      issuedAt: BigInt(challenge.issuedAt),
      validBefore: BigInt(challenge.validBefore),
    },
  };
}

export interface WalletActionExpectations {
  /** The payer whose history is being read. */
  payer: Address;
  /** The wallet action, e.g. `list-orders`. */
  action: string;
  /** The gateway audience for the active profile. */
  audience: string;
  /** The exact request body the CLI will send. */
  request: Record<string, unknown>;
  /** True only for provider-scoped asset actions. */
  requireProviderBinding: boolean;
  nowSeconds?: number;
}

export interface WalletActionChallenge {
  domain: { name: string; version: string; chainId: number };
  primaryType: "WalletActionAuthorizationV1";
  message: Record<string, unknown>;
}

/**
 * Validates a wallet-action challenge: closed 17-field message, our payer,
 * our audience, our action, a short window, and — for the unbound variant —
 * proof that every provider slot really is zeroed.
 */
export function validateWalletActionChallenge(
  value: unknown,
  chainId: number,
  expectations: WalletActionExpectations,
): WalletActionChallenge {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    refuse({
      check: "lifecycle-binding",
      code: "DASKI_WALLET_CHALLENGE_NOT_AN_OBJECT",
      expected: "a wallet-action challenge object",
      actual: Array.isArray(value) ? "an array" : typeof value,
      remediation: `Retry the query; see ${DOC}`,
    });
  }
  const { challenge, signRequest } = splitSignRequest(value as Record<string, unknown>);
  assertExactKeys(challenge, ["domain", "primaryType", "message"], "wallet challenge");
  const domain = challenge.domain as Record<string, unknown>;
  assertExactKeys(domain, ["name", "version", "chainId"], "wallet challenge domain");
  const message = challenge.message as Record<string, unknown>;
  assertExactKeys(message, WALLET_MESSAGE_FIELDS, "wallet challenge message");

  if (
    domain.name !== "DaskiStandardWallet" || domain.version !== "1" ||
    domain.chainId !== chainId
  ) {
    refuse({
      check: "lifecycle-binding",
      code: "DASKI_WALLET_DOMAIN_MISMATCH",
      expected: `DaskiStandardWallet v1 on chain ${chainId}`,
      actual: `${String(domain.name)} v${String(domain.version)} on chain ${String(domain.chainId)}`,
      remediation: `See ${DOC}`,
    });
  }
  if (challenge.primaryType !== "WalletActionAuthorizationV1") {
    refuse({
      check: "lifecycle-binding",
      code: "DASKI_WALLET_PRIMARY_TYPE_MISMATCH",
      expected: "WalletActionAuthorizationV1",
      actual: String(challenge.primaryType),
      remediation: `See ${DOC}`,
    });
  }
  if (getAddress(String(message.payer)) !== getAddress(expectations.payer)) {
    refuse({
      check: "lifecycle-binding",
      code: "DASKI_WALLET_PAYER_MISMATCH",
      expected: `payer ${getAddress(expectations.payer)}`,
      actual: `payer ${String(message.payer)}`,
      remediation: `See ${DOC}`,
    });
  }
  const expectedAction = keccak256(stringToHex(expectations.action));
  if (String(message.actionHash).toLowerCase() !== expectedAction.toLowerCase()) {
    refuse({
      check: "lifecycle-binding",
      code: "DASKI_WALLET_ACTION_MISMATCH",
      expected: `actionHash for "${expectations.action}"`,
      actual: `actionHash ${String(message.actionHash)}`,
      remediation: `See ${DOC}`,
    });
  }
  const expectedAudience = keccak256(stringToHex(expectations.audience));
  if (String(message.audienceHash).toLowerCase() !== expectedAudience.toLowerCase()) {
    refuse({
      check: "lifecycle-binding",
      code: "DASKI_WALLET_AUDIENCE_MISMATCH",
      expected: `audienceHash for ${expectations.audience}`,
      actual: `audienceHash ${String(message.audienceHash)}`,
      remediation:
        "A signature bound to another audience could be replayed there. " +
        `Do not sign it; see ${DOC}`,
    });
  }
  const expectedRequestHash = canonicalHash(expectations.request);
  if (String(message.requestHash).toLowerCase() !== expectedRequestHash.toLowerCase()) {
    refuse({
      check: "lifecycle-binding",
      code: "DASKI_WALLET_REQUEST_HASH_MISMATCH",
      expected: `requestHash ${expectedRequestHash} (recomputed from the outgoing request)`,
      actual: `requestHash ${String(message.requestHash)}`,
      remediation: `See ${DOC}`,
    });
  }

  const zero = `0x${"00".repeat(32)}`;
  const providerSlots = [
    "serviceId", "providerControlProfileHash", "servicingAdmissionHash",
    "actionCatalogHash", "actionCatalogSchemaHash", "actionDefinitionHash",
  ] as const;
  if (expectations.requireProviderBinding) {
    if (String(message.providerAgentId) === "0" || message.serviceId === zero) {
      refuse({
        check: "lifecycle-binding",
        code: "DASKI_WALLET_PROVIDER_BINDING_MISSING",
        expected: "a provider-bound wallet challenge",
        actual: "provider slots are zeroed",
        remediation: `See ${DOC}`,
      });
    }
  } else if (
    String(message.providerAgentId) !== "0" ||
    providerSlots.some((slot) => message[slot] !== zero) ||
    Number(message.actionCatalogEpoch) !== 0
  ) {
    refuse({
      check: "lifecycle-binding",
      code: "DASKI_WALLET_UNEXPECTED_PROVIDER_BINDING",
      expected: "an unbound wallet challenge with zeroed provider slots",
      actual: "the challenge binds a provider we did not name",
      remediation:
        "This would authorize a provider-scoped action under cover of a " +
        `wallet query. Do not sign it; see ${DOC}`,
    });
  }

  assertShortLived(Number(message.issuedAt), Number(message.validBefore),
    expectations.nowSeconds);

  const validated = challenge as unknown as WalletActionChallenge;
  if (signRequest) {
    assertSignRequestAgrees(signRequest, walletActionTypedData(validated), "wallet challenge");
  }
  return validated;
}

/** The typed-data payload for a validated wallet-action challenge. */
export function walletActionTypedData(challenge: WalletActionChallenge): TypedDataRequest {
  const message = challenge.message;
  return {
    domain: challenge.domain as never,
    types: WALLET_ACTION_TYPES,
    primaryType: "WalletActionAuthorizationV1",
    message: {
      ...message,
      providerAgentId: BigInt(String(message.providerAgentId)),
      actionCatalogEpoch: BigInt(String(message.actionCatalogEpoch)),
      issuedAt: BigInt(String(message.issuedAt)),
      validBefore: BigInt(String(message.validBefore)),
    },
  };
}

function assertShortLived(issuedAt: number, validBefore: number, nowSeconds?: number): void {
  const now = nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (
    issuedAt > now + LIFECYCLE_CLOCK_SKEW_SECONDS ||
    validBefore <= now ||
    validBefore <= issuedAt ||
    validBefore - issuedAt > MAX_LIFECYCLE_LIFETIME_SECONDS
  ) {
    refuse({
      check: "lifecycle-binding",
      code: "DASKI_LIFECYCLE_WINDOW_INVALID",
      expected:
        `issuedAt within ${LIFECYCLE_CLOCK_SKEW_SECONDS}s of now and a lifetime ` +
        `in (0, ${MAX_LIFECYCLE_LIFETIME_SECONDS}]s`,
      actual: `issuedAt=${issuedAt} validBefore=${validBefore} now=${now}`,
      remediation:
        "Expired, future-dated, or long-lived lifecycle challenges are refused. " +
        `Check the local clock, then retry; see ${DOC}`,
    });
  }
}

/** Sets a server-proposed `signRequest` aside so the closed-shape checks see only the challenge fields. */
function splitSignRequest(value: Record<string, unknown>): {
  challenge: Record<string, unknown>;
  signRequest: Record<string, unknown> | undefined;
} {
  const { signRequest, ...challenge } = value;
  const proposal = signRequest && typeof signRequest === "object" && !Array.isArray(signRequest)
    ? signRequest as Record<string, unknown>
    : undefined;
  return { challenge, signRequest: proposal };
}

/**
 * A server-proposed sign request is never signed as given; it must agree,
 * field for field, with the typed data this bridge recomputes from the
 * challenge. A difference means the server proposes one thing and binds
 * another, and the proposal is refused rather than reconciled.
 */
function assertSignRequestAgrees(
  signRequest: Record<string, unknown>,
  recomputed: TypedDataRequest,
  label: string,
): void {
  const proposedDomain = (signRequest.domain ?? {}) as Record<string, unknown>;
  const proposedMessage = (signRequest.message ?? {}) as Record<string, unknown>;
  const recomputedDomain = recomputed.domain as unknown as Record<string, unknown>;
  const recomputedMessage = recomputed.message as Record<string, unknown>;
  const same = (a: unknown, b: unknown): boolean =>
    String(a).toLowerCase() === String(b).toLowerCase();
  const differences: string[] = [];
  if (signRequest.primaryType !== recomputed.primaryType) differences.push("primaryType");
  for (const key of ["name", "version", "chainId"]) {
    if (!same(proposedDomain[key], recomputedDomain[key])) differences.push(`domain.${key}`);
  }
  for (const key of new Set([...Object.keys(proposedMessage), ...Object.keys(recomputedMessage)])) {
    if (!same(proposedMessage[key], recomputedMessage[key])) differences.push(`message.${key}`);
  }
  if (differences.length > 0) {
    refuse({
      check: "lifecycle-binding",
      code: "DASKI_LIFECYCLE_SIGN_REQUEST_MISMATCH",
      expected: `a signRequest equal to the typed data this bridge recomputes for the ${label}`,
      actual: `differs at ${differences.join(", ")}`,
      remediation:
        "The server proposed typed data that differs from the challenge it binds. " +
        `Do not sign it; see ${DOC}`,
    });
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.join(",") !== expected.join(",")) {
    refuse({
      check: "lifecycle-binding",
      code: "DASKI_LIFECYCLE_OPEN_SHAPE",
      expected: `${label} to be exactly [${expected.join(", ")}]`,
      actual: `[${actual.join(", ")}]`,
      remediation: `Upgrade @daski/x402-scheme; see ${DOC}`,
    });
  }
}
