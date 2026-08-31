/**
 * §5 — profiles, and §4.2 — caps are human-owned.
 *
 * The three caps live in `~/.daski/config.json` and nowhere else. No flag and
 * no environment variable can raise them; a flag may lower one for a single
 * invocation, which is the only direction that cannot be used to talk an
 * agent into spending more than its operator allowed.
 *
 * Sandbox and mainnet are separate blocks with separate keychain entries, so
 * a misconfigured profile cannot reach across and spend real money.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress, type Address } from "viem";
import { CliError } from "./cli/errors.js";
import { configPath, daskiHome } from "./paths.js";

export type ProfileName = "sandbox" | "mainnet" | (string & {});
export type SignerKind = "local" | "cdp" | "circle";

export interface ProfileConfig {
  /** Gateway base URL; also the audience for lifecycle signatures. */
  gatewayUrl: string;
  /** CAIP-2 network, e.g. `eip155:84532`. */
  network: string;
  chainId: number;
  /** The only token this profile will ever sign a transfer of. */
  usdcAddress: Address;
  /** EVM RPC used for balance reads. Never for signing. */
  rpcUrl: string;
  /** Human-owned. Not raisable at runtime. */
  maxPerOrderUsdc: string;
  /** Human-owned. Not raisable at runtime. */
  sessionCapUsdc: string;
  /** Human-owned. Above this, a purchase needs an interactive human. */
  requireApprovalAboveUsdc: string;
  signer: SignerKind;
  /** Profiles are opt-in; mainnet ships disabled. */
  enabled: boolean;
}

export interface DaskiConfig {
  version: 1;
  defaultProfile: ProfileName;
  profiles: Record<ProfileName, ProfileConfig>;
}

/** Base Sepolia USDC — the canonical sandbox token, pinned. */
export const SANDBOX_USDC = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
/** Base mainnet USDC, for the scaffolded-but-disabled profile. */
export const MAINNET_USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

export const DEFAULT_CONFIG: DaskiConfig = {
  version: 1,
  defaultProfile: "sandbox",
  profiles: {
    sandbox: {
      gatewayUrl: "https://sandbox-gateway.daski.io",
      network: "eip155:84532",
      chainId: 84532,
      usdcAddress: SANDBOX_USDC,
      rpcUrl: "https://sepolia.base.org",
      maxPerOrderUsdc: "25.00",
      sessionCapUsdc: "100.00",
      requireApprovalAboveUsdc: "1.00",
      signer: "local",
      enabled: true,
    },
    // Scaffolded, and deliberately off. Enabling it is a human edit.
    mainnet: {
      gatewayUrl: "https://gateway.daski.io",
      network: "eip155:8453",
      chainId: 8453,
      usdcAddress: MAINNET_USDC,
      rpcUrl: "https://mainnet.base.org",
      maxPerOrderUsdc: "0.00",
      sessionCapUsdc: "0.00",
      requireApprovalAboveUsdc: "0.00",
      signer: "local",
      enabled: false,
    },
  },
};

export interface LoadedConfig {
  config: DaskiConfig;
  profileName: ProfileName;
  profile: ProfileConfig;
  /** Warnings that are not fatal but belong in `doctor` output. */
  warnings: ConfigWarning[];
}

export interface ConfigWarning {
  code: string;
  message: string;
  remediation: string;
}

const DOC = "https://github.com/daski-io/buyer/blob/main/docs/config.md";

/** Writes the default config if none exists. Returns the path either way. */
export function ensureConfig(): string {
  const path = configPath();
  try {
    statSync(path);
    return path;
  } catch {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { mode: 0o600 });
    return path;
  }
}

/**
 * Loads the config and selects a profile. `--profile` and `DASKI_PROFILE`
 * choose *which* human-owned block applies; neither can alter its contents.
 */
export function loadConfig(profileOverride?: string): LoadedConfig {
  const path = ensureConfig();
  const warnings: ConfigWarning[] = [];
  let parsed: DaskiConfig;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as DaskiConfig;
  } catch (error) {
    throw new CliError({
      code: "DASKI_CONFIG_UNREADABLE",
      message: `${path} is not valid JSON: ${(error as Error).message}`,
      remediation: `Fix the file by hand, or delete it to regenerate defaults. See ${DOC}`,
    });
  }
  warnings.push(...permissionWarnings(path));

  const profileName = profileOverride ?? process.env.DASKI_PROFILE ?? parsed.defaultProfile;
  const profile = parsed.profiles?.[profileName];
  if (!profile) {
    throw new CliError({
      code: "DASKI_PROFILE_NOT_FOUND",
      message: `No profile named "${profileName}" in ${path}.`,
      remediation:
        `Add the profile to ${path}, or pass --profile with one of: ` +
        `${Object.keys(parsed.profiles ?? {}).join(", ")}. See ${DOC}`,
    });
  }
  if (!profile.enabled) {
    throw new CliError({
      code: "DASKI_PROFILE_DISABLED",
      message: `The "${profileName}" profile is disabled.`,
      remediation:
        `Enabling a profile — mainnet especially — is a human action: set ` +
        `profiles.${profileName}.enabled to true in ${path} and set real caps. See ${DOC}`,
    });
  }
  assertProfileSane(profileName, profile, path);
  return { config: parsed, profileName, profile, warnings };
}

/** Directory and file permission checks, surfaced by `doctor` (§4.2). */
export function permissionWarnings(path: string): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];
  for (const [target, label] of [[path, "config file"], [daskiHome(), "state directory"]] as const) {
    try {
      const mode = statSync(target).mode;
      if ((mode & 0o002) !== 0) {
        warnings.push({
          code: "DASKI_CONFIG_WORLD_WRITABLE",
          message:
            `The ${label} ${target} is world-writable, so any local process can ` +
            "raise your spend caps.",
          remediation: `Run: chmod ${label === "config file" ? "600" : "700"} ${target}`,
        });
      }
    } catch {
      // A missing target is not a permissions problem; other checks report it.
    }
  }
  return warnings;
}

function assertProfileSane(name: string, profile: ProfileConfig, path: string): void {
  const expectedNetwork = `eip155:${profile.chainId}`;
  if (profile.network !== expectedNetwork) {
    throw new CliError({
      code: "DASKI_PROFILE_INCOHERENT",
      message:
        `Profile "${name}" sets network ${profile.network} but chainId ${profile.chainId}.`,
      remediation: `Make them agree in ${path} (network must be ${expectedNetwork}). See ${DOC}`,
    });
  }
  for (const cap of ["maxPerOrderUsdc", "sessionCapUsdc", "requireApprovalAboveUsdc"] as const) {
    if (!/^\d+(\.\d{1,6})?$/.test(profile[cap])) {
      throw new CliError({
        code: "DASKI_PROFILE_CAP_MALFORMED",
        message: `Profile "${name}" has a malformed ${cap}: ${profile[cap]}`,
        remediation:
          `Set ${cap} to a decimal USDC amount with at most 6 decimals, e.g. "25.00", ` +
          `in ${path}. See ${DOC}#caps`,
      });
    }
  }
  try {
    getAddress(profile.usdcAddress);
  } catch {
    throw new CliError({
      code: "DASKI_PROFILE_TOKEN_MALFORMED",
      message: `Profile "${name}" has a malformed usdcAddress: ${profile.usdcAddress}`,
      remediation: `Set a checksummed contract address in ${path}. See ${DOC}`,
    });
  }
  if (!/^https:\/\//.test(profile.gatewayUrl)) {
    throw new CliError({
      code: "DASKI_PROFILE_GATEWAY_NOT_HTTPS",
      message: `Profile "${name}" points at a non-HTTPS gateway: ${profile.gatewayUrl}`,
      remediation: `Use an https:// gateway URL in ${path}. See ${DOC}`,
    });
  }
}

/** Tightens the config's caps for one invocation. Lowering only (§4.2). */
export function applyCapOverrides(
  profile: ProfileConfig,
  overrides: { maxPerOrderUsdc?: string | undefined; sessionCapUsdc?: string | undefined },
): ProfileConfig {
  const tightened = { ...profile };
  for (const cap of ["maxPerOrderUsdc", "sessionCapUsdc"] as const) {
    const requested = overrides[cap];
    if (requested === undefined) continue;
    if (!/^\d+(\.\d{1,6})?$/.test(requested)) {
      throw new CliError({
        code: "DASKI_CAP_OVERRIDE_MALFORMED",
        message: `--${flagFor(cap)} expects a decimal USDC amount, got "${requested}".`,
        remediation: `Pass e.g. --${flagFor(cap)} 5.00`,
      });
    }
    if (atomicUsdc(requested) > atomicUsdc(profile[cap])) {
      throw new CliError({
        code: "DASKI_CAP_OVERRIDE_WOULD_RAISE",
        message:
          `--${flagFor(cap)} ${requested} is above the configured ${cap} of ` +
          `${profile[cap]}. Flags may lower a cap, never raise one.`,
        remediation:
          `Raising a cap is a human action: edit ${cap} in ${configPath()} by hand. ` +
          `See ${DOC}#caps`,
      });
    }
    tightened[cap] = requested;
  }
  return tightened;
}

function flagFor(cap: "maxPerOrderUsdc" | "sessionCapUsdc"): string {
  return cap === "maxPerOrderUsdc" ? "max-per-order" : "session-cap";
}

/** Parses a decimal USDC string into atomic units without floating point. */
export function atomicUsdc(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0").slice(0, 6) || "0");
}

export { DOC as CONFIG_DOC };
