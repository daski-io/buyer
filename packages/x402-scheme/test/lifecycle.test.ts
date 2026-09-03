/**
 * §4.1 check 8. Lifecycle signatures move authority rather than money, so the
 * failure they must prevent is a signature aimed at an order, action, host, or
 * request body other than the one the operator asked for.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, keccak256, stringToHex } from "viem";
import { canonicalHash } from "../src/canonical.js";
import { PolicyRefusal } from "../src/errors.js";
import {
  orderActionResourceUri,
  orderActionTypedData,
  validateOrderActionChallenge,
  validateWalletActionChallenge,
  walletActionTypedData,
  type OrderActionExpectations,
  type WalletActionExpectations,
} from "../src/lifecycle.js";

const GATEWAY = "https://sandbox-gateway.daski.io";
const HANDLE = "ord_01H8XKJ9";
const NOW = 1_788_200_000;
const REQUEST = { note: "hello" };
const ZERO = `0x${"00".repeat(32)}`;

function expectations(overrides: Partial<OrderActionExpectations> = {}): OrderActionExpectations {
  return {
    orderHandle: HANDLE,
    action: "status",
    gatewayUrl: GATEWAY,
    request: REQUEST,
    nowSeconds: NOW,
    ...overrides,
  };
}

function challenge(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "order-123",
    action: "status",
    method: "POST",
    absoluteResourceUri: orderActionResourceUri(GATEWAY, HANDLE, "status"),
    requestHash: canonicalHash(REQUEST),
    nonce: `0x${"ab".repeat(32)}`,
    issuedAt: NOW - 5,
    validBefore: NOW + 295,
    ...overrides,
  };
}

function refusalCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof PolicyRefusal, `expected a PolicyRefusal, got ${String(error)}`);
    assert.ok(error.detail.remediation.length > 0);
    return error.detail.code;
  }
  return assert.fail("expected a refusal");
}

test("a well-formed order-action challenge validates", () => {
  const validated = validateOrderActionChallenge(challenge(), expectations());
  assert.equal(validated.action, "status");
  assert.equal(validated.orderId, "order-123");
});

test("the resource URI is recomputed, not accepted", () => {
  // Same shape, different order: the signature would authorize someone else's read.
  const other = orderActionResourceUri(GATEWAY, "ord_SOMEONE_ELSE", "status");
  assert.equal(
    refusalCode(() => validateOrderActionChallenge(
      challenge({ absoluteResourceUri: other }), expectations(),
    )),
    "DASKI_LIFECYCLE_URI_MISMATCH",
  );
});

test("a challenge pointing at another host is refused", () => {
  assert.equal(
    refusalCode(() => validateOrderActionChallenge(
      challenge({ absoluteResourceUri: orderActionResourceUri("https://evil.example", HANDLE, "status") }),
      expectations(),
    )),
    "DASKI_LIFECYCLE_URI_MISMATCH",
  );
});

test("the request hash is recomputed over the body we are about to send", () => {
  assert.equal(
    refusalCode(() => validateOrderActionChallenge(
      challenge({ requestHash: canonicalHash({ note: "something else" }) }), expectations(),
    )),
    "DASKI_LIFECYCLE_REQUEST_HASH_MISMATCH",
  );
});

test("an action we did not ask for is refused", () => {
  assert.equal(
    refusalCode(() => validateOrderActionChallenge(
      challenge({
        action: "cancel",
        absoluteResourceUri: orderActionResourceUri(GATEWAY, HANDLE, "cancel"),
      }),
      expectations(),
    )),
    "DASKI_LIFECYCLE_ACTION_MISMATCH",
  );
});

test("an extra challenge field is refused rather than ignored", () => {
  assert.equal(
    refusalCode(() => validateOrderActionChallenge(challenge({ extra: 1 }), expectations())),
    "DASKI_LIFECYCLE_CHALLENGE_OPEN_SHAPE",
  );
});

test("an expired or long-lived challenge is refused", () => {
  assert.equal(
    refusalCode(() => validateOrderActionChallenge(
      challenge({ validBefore: NOW - 1 }), expectations(),
    )),
    "DASKI_LIFECYCLE_WINDOW_INVALID",
  );
  assert.equal(
    refusalCode(() => validateOrderActionChallenge(
      challenge({ issuedAt: NOW, validBefore: NOW + 4_000 }), expectations(),
    )),
    "DASKI_LIFECYCLE_WINDOW_INVALID",
  );
});

test("the typed data hashes exactly the validated challenge fields", () => {
  const validated = validateOrderActionChallenge(challenge(), expectations());
  const typed = orderActionTypedData(validated, 84532, GATEWAY);
  assert.equal(typed.primaryType, "OrderActionAuthorizationV1");
  assert.equal(typed.message.orderIdHash, keccak256(stringToHex("order-123")));
  assert.equal(typed.message.actionHash, keccak256(stringToHex("status")));
  assert.equal(typed.message.methodHash, keccak256(stringToHex("POST")));
  assert.equal(typed.message.audienceHash, keccak256(stringToHex(GATEWAY)));
  assert.equal(typed.message.requestHash, canonicalHash(REQUEST));
});

// -- wallet family ---------------------------------------------------------

const PAYER = getAddress("0x1111111111111111111111111111111111111111");

function walletExpectations(
  overrides: Partial<WalletActionExpectations> = {},
): WalletActionExpectations {
  return {
    payer: PAYER,
    action: "list-orders",
    audience: GATEWAY,
    request: { limit: 25, cursor: null },
    requireProviderBinding: false,
    nowSeconds: NOW,
    ...overrides,
  };
}

function walletChallenge(messageOverrides: Record<string, unknown> = {}) {
  return {
    domain: { name: "DaskiStandardWallet", version: "1", chainId: 84532 },
    primaryType: "WalletActionAuthorizationV1",
    message: {
      payer: PAYER.toLowerCase(),
      providerAgentId: "0",
      serviceId: ZERO,
      providerControlProfileHash: ZERO,
      servicingAdmissionHash: ZERO,
      actionCatalogHash: ZERO,
      actionCatalogSchemaHash: ZERO,
      actionDefinitionHash: ZERO,
      actionCatalogEpoch: 0,
      actionHash: keccak256(stringToHex("list-orders")),
      methodHash: keccak256(stringToHex("POST")),
      absoluteResourceUriHash: keccak256(stringToHex(`${GATEWAY}/wallet/orders`)),
      requestHash: canonicalHash({ limit: 25, cursor: null }),
      audienceHash: keccak256(stringToHex(GATEWAY)),
      nonce: `0x${"cd".repeat(32)}`,
      issuedAt: NOW - 5,
      validBefore: NOW + 295,
      ...messageOverrides,
    },
  };
}

test("a well-formed wallet challenge validates", () => {
  const validated = validateWalletActionChallenge(walletChallenge(), 84532, walletExpectations());
  assert.equal(validated.primaryType, "WalletActionAuthorizationV1");
});

test("a wallet challenge for another audience is refused", () => {
  assert.equal(
    refusalCode(() => validateWalletActionChallenge(
      walletChallenge({ audienceHash: keccak256(stringToHex("https://evil.example")) }),
      84532, walletExpectations(),
    )),
    "DASKI_WALLET_AUDIENCE_MISMATCH",
  );
});

test("a wallet challenge smuggling a provider binding is refused", () => {
  assert.equal(
    refusalCode(() => validateWalletActionChallenge(
      walletChallenge({ providerAgentId: "8327", serviceId: `0x${"ee".repeat(32)}` }),
      84532, walletExpectations(),
    )),
    "DASKI_WALLET_UNEXPECTED_PROVIDER_BINDING",
  );
});

test("a wallet challenge naming another payer is refused", () => {
  assert.equal(
    refusalCode(() => validateWalletActionChallenge(
      walletChallenge({ payer: "0x2222222222222222222222222222222222222222" }),
      84532, walletExpectations(),
    )),
    "DASKI_WALLET_PAYER_MISMATCH",
  );
});

test("a wallet challenge committing to a different request is refused", () => {
  assert.equal(
    refusalCode(() => validateWalletActionChallenge(
      walletChallenge({ requestHash: canonicalHash({ limit: 100, cursor: null }) }),
      84532, walletExpectations(),
    )),
    "DASKI_WALLET_REQUEST_HASH_MISMATCH",
  );
});

test("a wallet challenge on the wrong chain is refused", () => {
  assert.equal(
    refusalCode(() => validateWalletActionChallenge(walletChallenge(), 8453, walletExpectations())),
    "DASKI_WALLET_DOMAIN_MISMATCH",
  );
});

// The gateway attaches its sign-ready EIP-712 proposal as `signRequest` beside
// every lifecycle and wallet challenge. Refusing it as an open shape blocked
// every live order read, lifecycle action, and wallet query (2026-09-03); the
// proposal is set aside for the shape check and must agree with what the
// bridge recomputes, which is the only thing it ever signs.

function jsonNumbers(message: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(message).map(([key, value]) => [key, typeof value === "bigint" ? Number(value) : value]),
  );
}

test("an order-action challenge with an agreeing signRequest validates, and the proposal is set aside", () => {
  const typed = orderActionTypedData(validateOrderActionChallenge(challenge(), expectations()), 84532, GATEWAY);
  const signRequest = {
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: jsonNumbers(typed.message as Record<string, unknown>),
  };
  const validated = validateOrderActionChallenge(challenge({ signRequest }), expectations({ chainId: 84532 }));
  assert.equal(validated.orderId, "order-123");
  assert.equal("signRequest" in validated, false);
  // Without the profile chain id the proposal's own domain still has to agree with itself.
  assert.equal(validateOrderActionChallenge(challenge({ signRequest }), expectations()).action, "status");
});

test("an order-action signRequest that disagrees with the recomputation is refused", () => {
  const typed = orderActionTypedData(validateOrderActionChallenge(challenge(), expectations()), 84532, GATEWAY);
  const message = jsonNumbers(typed.message as Record<string, unknown>);
  const disagreeing = {
    domain: typed.domain, types: typed.types, primaryType: typed.primaryType,
    message: { ...message, nonce: `0x${"ef".repeat(32)}` },
  };
  assert.equal(
    refusalCode(() => validateOrderActionChallenge(challenge({ signRequest: disagreeing }), expectations({ chainId: 84532 }))),
    "DASKI_LIFECYCLE_SIGN_REQUEST_MISMATCH",
  );
  const otherChain = { domain: { ...typed.domain, chainId: 1 }, types: typed.types, primaryType: typed.primaryType, message };
  assert.equal(
    refusalCode(() => validateOrderActionChallenge(challenge({ signRequest: otherChain }), expectations({ chainId: 84532 }))),
    "DASKI_LIFECYCLE_SIGN_REQUEST_MISMATCH",
  );
  // Any other extra field is still an open shape.
  assert.equal(
    refusalCode(() => validateOrderActionChallenge(challenge({ signRequest: disagreeing, extra: 1 }), expectations({ chainId: 84532 }))),
    "DASKI_LIFECYCLE_CHALLENGE_OPEN_SHAPE",
  );
});

test("a wallet challenge with an agreeing signRequest validates; a disagreeing one is refused", () => {
  const base = walletChallenge();
  const typed = walletActionTypedData(validateWalletActionChallenge(base, 84532, walletExpectations()));
  const signRequest = { domain: base.domain, types: typed.types, primaryType: typed.primaryType, message: base.message };
  const validated = validateWalletActionChallenge({ ...base, signRequest }, 84532, walletExpectations());
  assert.equal(validated.primaryType, "WalletActionAuthorizationV1");
  assert.equal("signRequest" in validated, false);

  const disagreeing = { ...signRequest, message: { ...base.message, payer: `0x${"2".repeat(40)}` } };
  assert.equal(
    refusalCode(() => validateWalletActionChallenge({ ...base, signRequest: disagreeing }, 84532, walletExpectations())),
    "DASKI_LIFECYCLE_SIGN_REQUEST_MISMATCH",
  );
  assert.equal(
    refusalCode(() => validateWalletActionChallenge({ ...base, unexpected: true }, 84532, walletExpectations())),
    "DASKI_LIFECYCLE_OPEN_SHAPE",
  );
});
