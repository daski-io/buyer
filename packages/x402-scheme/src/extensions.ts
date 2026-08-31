/**
 * Challenge extensions: what we echo back with a paid submission, and what we
 * refuse to echo.
 */
import { refuse } from "./errors.js";

export const DASKI_ORDER_BINDING = "daski-order-binding";
export const DASKI_SIGN_REQUEST = "daski-sign-request";
export const PAYMENT_IDENTIFIER = "payment-identifier";

/** Alphanumeric, hyphen and underscore, 16–128 characters. */
export const PAYMENT_IDENTIFIER_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;

/**
 * The extension set a paid submission echoes: every issued extension except
 * `bazaar` and `daski-sign-request`.
 *
 * `bazaar` is dropped because its inlined outcome schemas can push the encoded
 * `PAYMENT-SIGNATURE` header past the inbound caps in front of the gateway
 * (Node's 16 KiB default, Cloudflare's per-header limit), which would refuse
 * the paid retry with a 431 before the gateway ever saw it. The gateway
 * verifies a payment that omits `bazaar` and hash-checks it when echoed.
 *
 * `daski-sign-request` is dropped because it is the server's *proposal*, not
 * part of the deal: echoing it back would assert we agreed to a document we
 * only used as an input to our own recomputation.
 */
export function paymentEchoExtensions(
  issued: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const {
    bazaar: _discovery,
    [DASKI_SIGN_REQUEST]: _proposal,
    ...extensions
  } = issued ?? {};
  return extensions;
}

/**
 * Adds our payment identifier to the issued `payment-identifier` extension.
 * The identifier is the reconciliation key: it is what makes an interrupted
 * purchase provably findable instead of ambiguously re-signable.
 */
export function withPaymentIdentifier(
  extensions: Record<string, unknown>,
  identifier: string | undefined,
): Record<string, unknown> {
  if (identifier === undefined) return extensions;
  if (!PAYMENT_IDENTIFIER_PATTERN.test(identifier)) {
    refuse({
      check: "payment-identifier",
      code: "DASKI_PAYMENT_IDENTIFIER_MALFORMED",
      expected: "16-128 characters of [A-Za-z0-9_-]",
      actual: `identifier of length ${identifier.length}`,
      remediation:
        "Let @daski/pay generate the identifier, or supply one matching the " +
        "documented pattern.",
    });
  }
  const issued = extensions[PAYMENT_IDENTIFIER];
  if (issued === undefined) return extensions;
  const declaration = issued as { info?: Record<string, unknown> };
  return {
    ...extensions,
    [PAYMENT_IDENTIFIER]: {
      ...declaration,
      info: { ...(declaration.info ?? {}), id: identifier },
    },
  };
}

/** Reads the identifier the server pinned, if it pinned one. */
export function issuedPaymentIdentifier(
  extensions: Record<string, unknown> | undefined,
): string | undefined {
  const issued = extensions?.[PAYMENT_IDENTIFIER] as
    { info?: { id?: unknown } } | undefined;
  const id = issued?.info?.id;
  return typeof id === "string" ? id : undefined;
}
