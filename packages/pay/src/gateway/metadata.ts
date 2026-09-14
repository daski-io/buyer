/**
 * The gateway's `/.well-known/mcp.json`, read once per command.
 *
 * It carries the buyer CLI pin, the confirmation signing pins (chain, EAS,
 * schema, reputation storage), which payer account types the gateway
 * verifies, which confirmation modes it offers, and which vendor signer CLIs
 * it pins. Each block is validated on its own; a block that is missing or
 * malformed reads as `null`, so a caller decides for itself whether that is
 * fatal for what it is about to do.
 */
import { getAddress, type Address, type Hex } from "viem";
import { CliError } from "../cli/errors.js";

/** The buyer CLI release a gateway pins. */
export interface PinnedBuyerCli {
  package: string;
  version: string;
  install?: string | undefined;
}

export interface ConfirmationSigningPins {
  chainId: number;
  eas: Address;
  schemaUid: Hex;
  reputationStorage: Address;
}

export interface PayerAccounts {
  types: string[];
  counterfactual: boolean;
}

export interface ConfirmationModes {
  modes: string[];
  sponsoredRequires: string;
  attestationCap: number;
  revocationAfterCap: boolean;
}

export interface SignerCliPin {
  package: string;
  version: string;
  repository?: string | undefined;
}

export interface GatewayMetadata {
  buyerCli: PinnedBuyerCli | null;
  confirmationSigning: ConfirmationSigningPins | null;
  payerAccounts: PayerAccounts | null;
  confirmation: ConfirmationModes | null;
  signerClis: Record<string, SignerCliPin> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readBuyerCli(value: unknown): PinnedBuyerCli | null {
  if (!isRecord(value) || typeof value.package !== "string" || typeof value.version !== "string") return null;
  return {
    package: value.package,
    version: value.version,
    install: typeof value.install === "string" ? value.install : undefined,
  };
}

function readConfirmationSigning(value: unknown): ConfirmationSigningPins | null {
  if (!isRecord(value)) return null;
  const { chainId, eas, schemaUid, reputationStorage } = value;
  if (!Number.isSafeInteger(chainId) || typeof eas !== "string" || typeof reputationStorage !== "string" ||
      typeof schemaUid !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(schemaUid)) return null;
  try {
    return {
      chainId: chainId as number,
      eas: getAddress(eas),
      schemaUid: schemaUid.toLowerCase() as Hex,
      reputationStorage: getAddress(reputationStorage),
    };
  } catch {
    return null;
  }
}

function readPayerAccounts(value: unknown): PayerAccounts | null {
  if (!isRecord(value) || !Array.isArray(value.types) || !value.types.every((t) => typeof t === "string")) return null;
  return { types: value.types as string[], counterfactual: value.counterfactual === true };
}

function readConfirmation(value: unknown): ConfirmationModes | null {
  if (!isRecord(value) || !Array.isArray(value.modes) || !value.modes.every((m) => typeof m === "string")) return null;
  return {
    modes: value.modes as string[],
    sponsoredRequires: typeof value.sponsoredRequires === "string" ? value.sponsoredRequires : "eoa",
    attestationCap: Number.isSafeInteger(value.attestationCap) ? value.attestationCap as number : 3,
    revocationAfterCap: value.revocationAfterCap === true,
  };
}

function readSignerClis(value: unknown): Record<string, SignerCliPin> | null {
  if (!isRecord(value)) return null;
  const pins: Record<string, SignerCliPin> = {};
  for (const [name, pin] of Object.entries(value)) {
    if (!isRecord(pin) || typeof pin.package !== "string" || typeof pin.version !== "string") continue;
    pins[name] = {
      package: pin.package,
      version: pin.version,
      repository: typeof pin.repository === "string" ? pin.repository : undefined,
    };
  }
  return pins;
}

/** Parses a well-known document. Exported so fixtures can be checked without a server. */
export function parseGatewayMetadata(body: unknown): GatewayMetadata {
  const document = isRecord(body) ? body : {};
  return {
    buyerCli: readBuyerCli(document.buyerCli),
    confirmationSigning: readConfirmationSigning(document.confirmationSigning),
    payerAccounts: readPayerAccounts(document.payerAccounts),
    confirmation: readConfirmation(document.confirmation),
    signerClis: readSignerClis(document.signerClis),
  };
}

/** The gateway's EAS pin does not match the profile's; confirmations are refused until it does. */
export function easAddressMismatch(gatewayEas: Address, profileEas: Address, chainId: number): CliError {
  return new CliError({
    code: "DASKI_EAS_ADDRESS_MISMATCH",
    message:
      `The gateway pins EAS ${gatewayEas} for delivery confirmations; this profile pins ` +
      `${profileEas} for chain ${chainId}.`,
    remediation:
      "Confirm with the gateway operator that its confirmationSigning.eas is the canonical EAS " +
      `for chain ${chainId}; if it is, set easAddress in the profile to match. No confirmation is ` +
      "prepared or signed while they disagree.",
  });
}

/** The document carries no usable `confirmationSigning` block; no delivery confirmation can be prepared. */
export function confirmationPinsMissing(gatewayUrl: string): CliError {
  return new CliError({
    code: "DASKI_GATEWAY_CONFIRMATION_PINS_MISSING",
    message:
      `The gateway at ${gatewayUrl} publishes no usable confirmationSigning block (chainId, eas, ` +
      "schemaUid, reputationStorage) in /.well-known/mcp.json, so delivery confirmations are refused.",
    remediation:
      "Purchases are unaffected. Ask the gateway operator to publish confirmationSigning, then re-run; " +
      "no confirmation is prepared or signed until the pins are readable.",
  });
}

/** The document carries no usable `payerAccounts` block; the gateway does not say which account types it verifies. */
export function payerAccountsMissing(gatewayUrl: string): CliError {
  return new CliError({
    code: "DASKI_GATEWAY_PAYER_ACCOUNTS_MISSING",
    message:
      `The gateway at ${gatewayUrl} publishes no usable payerAccounts block in /.well-known/mcp.json, ` +
      "so it does not state which payer account types it verifies.",
    remediation:
      "A plain wallet can buy; a contract wallet is refused (DASKI_GATEWAY_EOA_ONLY) until the gateway " +
      "lists contract under payerAccounts.types. Ask the gateway operator to publish payerAccounts, then re-run.",
  });
}

/**
 * Reads and parses the gateway's well-known document. A transport failure or
 * a non-JSON answer is `DASKI_GATEWAY_METADATA_UNAVAILABLE`, retryable.
 */
export async function readGatewayMetadata(gatewayUrl: string, timeoutMs = 10_000): Promise<GatewayMetadata> {
  const url = `${gatewayUrl.replace(/\/$/, "")}/.well-known/mcp.json`;
  let body: unknown;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.json();
  } catch (error) {
    throw new CliError({
      code: "DASKI_GATEWAY_METADATA_UNAVAILABLE",
      message: `Could not read ${url}: ${(error as Error).message}`,
      remediation: "Check connectivity to the gateway, then re-run. Nothing was signed.",
      details: { retryable: true },
    });
  }
  return parseGatewayMetadata(body);
}

/**
 * The buyer CLI release a gateway pins, or `null` when the document or the
 * field is absent. The pin is advisory to the gateway's own operation, so a
 * gateway without it must not block `doctor`.
 */
export async function pinnedBuyerCli(gatewayUrl: string, timeoutMs = 10_000): Promise<PinnedBuyerCli | null> {
  try {
    return (await readGatewayMetadata(gatewayUrl, timeoutMs)).buyerCli;
  } catch {
    return null;
  }
}
