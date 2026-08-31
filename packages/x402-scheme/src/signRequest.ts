/**
 * `daski-sign-request` — the server's proposed authorization.
 *
 * When the gateway ships this extension it hands the buyer a fully-formed
 * typed-data document. That is a convenience, not an authority: the bridge
 * parses it into a closed shape, hands it to the policy validator like any
 * other proposal, and recomputes the recipe nonce. A proposal that survives
 * all of that is signed; one that does not is reported, never repaired.
 */
import type { Address, Hex } from "viem";
import type { Eip712Domain, TypedDataRequest } from "./eip712.js";
import { refuse } from "./errors.js";

const DOC = "https://github.com/daski-io/buyer/blob/main/docs/policy.md#sign-request";

export interface ParsedSignRequest {
  domain: Eip712Domain;
  primaryType: string;
  types: Record<string, readonly { name: string; type: string }[]>;
  message: Record<string, unknown>;
}

/**
 * Parses a `daski-sign-request` extension into a typed-data proposal.
 *
 * Nothing is validated here beyond structural sanity — the §4 validator owns
 * every semantic check, so this cannot become a second, weaker gate.
 */
export function parseSignRequest(value: unknown): TypedDataRequest | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    refuse({
      check: "challenge-shape",
      code: "DASKI_SIGN_REQUEST_NOT_AN_OBJECT",
      expected: "an object under extensions['daski-sign-request']",
      actual: Array.isArray(value) ? "an array" : typeof value,
      remediation: `Request a fresh challenge; see ${DOC}`,
    });
  }
  const request = value as Record<string, unknown>;
  const keys = Object.keys(request).sort();
  if (keys.join(",") !== "domain,message,primaryType,types") {
    refuse({
      check: "challenge-shape",
      code: "DASKI_SIGN_REQUEST_OPEN_SHAPE",
      expected: "exactly [domain, message, primaryType, types]",
      actual: `[${keys.join(", ")}]`,
      remediation:
        "An unrecognized sign-request layout cannot be validated, so it cannot " +
        `be signed. Upgrade @daski/x402-scheme; see ${DOC}`,
    });
  }
  const domain = request.domain as Record<string, unknown>;
  if (!domain || typeof domain !== "object" || Array.isArray(domain)) {
    refuse({
      check: "challenge-shape",
      code: "DASKI_SIGN_REQUEST_MALFORMED_DOMAIN",
      expected: "an EIP-712 domain object",
      actual: typeof domain,
      remediation: `Request a fresh challenge; see ${DOC}`,
    });
  }
  const domainKeys = Object.keys(domain).sort();
  if (domainKeys.join(",") !== "chainId,name,verifyingContract,version") {
    refuse({
      check: "challenge-shape",
      code: "DASKI_SIGN_REQUEST_OPEN_DOMAIN",
      expected: "exactly [chainId, name, verifyingContract, version]",
      actual: `[${domainKeys.join(", ")}]`,
      remediation:
        "A domain with extra or missing fields hashes differently than the one " +
        `we would validate; see ${DOC}`,
    });
  }
  const message = request.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    refuse({
      check: "challenge-shape",
      code: "DASKI_SIGN_REQUEST_MALFORMED_MESSAGE",
      expected: "an EIP-712 message object",
      actual: typeof message,
      remediation: `Request a fresh challenge; see ${DOC}`,
    });
  }
  return {
    domain: {
      name: String(domain.name),
      version: String(domain.version),
      chainId: Number(domain.chainId),
      verifyingContract: domain.verifyingContract as Address,
    },
    primaryType: String(request.primaryType),
    types: request.types as Record<string, readonly { name: string; type: string }[]>,
    message: message as Record<string, unknown>,
  };
}

/** The nonce a proposal carries, for the recompute-and-compare in §4.3. */
export function proposedNonce(proposal: TypedDataRequest): Hex | undefined {
  const nonce = proposal.message.nonce;
  return typeof nonce === "string" && /^0x[0-9a-fA-F]{64}$/.test(nonce)
    ? (nonce as Hex)
    : undefined;
}
