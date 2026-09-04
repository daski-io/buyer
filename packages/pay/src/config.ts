/** Profiles select a signer and network. Purchases use quote approval;
 * additional budgets are optional. Existing configured budgets are preserved. */
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
  /** Optional budget for a single purchase; null means no additional budget. */
  maxPerOrderUsdc: string | null;
  /** Optional budget across the profile's recorded authorizations. */
  sessionCapUsdc: string | null;
  /** Purchases above this user-selected allowance require quote approval. */
  requireApprovalAboveUsdc: string;
  signer: SignerKind;
  /** Profiles are opt-in; mainnet ships disabled. */
  enabled: boolean;
}

export interface DaskiConfig {
  version: 1 | 2;
  defaultProfile: ProfileName;
  profiles: Record<ProfileName, ProfileConfig>;
}

/** Base Sepolia USDC — the canonical sandbox token, pinned. */
export const SANDBOX_USDC = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
/** Base mainnet USDC, for the scaffolded-but-disabled profile. */
export const MAINNET_USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

export const DEFAULT_CONFIG: DaskiConfig = {
  version: 2,
  defaultProfile: "sandbox",
  profiles: {
    sandbox: {
      gatewayUrl: "https://sandbox-gateway.daski.io",
      network: "eip155:84532",
      chainId: 84532,
      usdcAddress: SANDBOX_USDC,
      rpcUrl: "https://sepolia.base.org",
      maxPerOrderUsdc: null,
      sessionCapUsdc: null,
      requireApprovalAboveUsdc: "0.00",
      signer: "local",
      enabled: true,
    },
    // Mainnet is available when the user chooses to enable it.
    mainnet: {
      gatewayUrl: "https://gateway.daski.io",
      network: "eip155:8453",
      chainId: 8453,
      usdcAddress: MAINNET_USDC,
      rpcUrl: "https://mainnet.base.org",
      maxPerOrderUsdc: null,
      sessionCapUsdc: null,
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

/** Load the selected profile without changing existing spending choices. */
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
      remediation: `Correct the JSON in ${path}. See ${DOC}`,
    });
  }
  warnings.push(...permissionWarnings(path));
  if (parsed.version !== 1 && parsed.version !== 2) {
    throw new CliError({ code: "DASKI_CONFIG_VERSION_UNSUPPORTED",
      message: "This configuration version is not supported.",
      remediation: `Check the installed CLI version and ${DOC}.` });
  }

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
        `When the user selects this network, set profiles.${profileName}.enabled ` +
        `to true in ${path}. See ${DOC}`,
    });
  }
  assertProfileSane(profileName, profile, path);
  return { config: parsed, profileName, profile, warnings };
}

/** Directory and file permission checks, surfaced by `doctor` (§4.2). */
export function permissionWarnings(path: string): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];
  // NTFS permissions are ACLs; Node synthesizes the POSIX mode on Windows and
  // reports the world-writable bit regardless of the real ACL, and chmod is a
  // no-op there. The check would only ever be a false positive: skip it.
  if (process.platform === "win32") return warnings;
  for (const [target, label] of [[path, "config file"], [daskiHome(), "state directory"]] as const) {
    try {
      const mode = statSync(target).mode;
      if ((mode & 0o002) !== 0) {
        warnings.push({
          code: "DASKI_CONFIG_WORLD_WRITABLE",
          message:
            `The ${label} ${target} is world-writable, so any local process can ` +
            "change its settings.",
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
    if (cap !== "requireApprovalAboveUsdc" && profile[cap] === null) continue;
    if (typeof profile[cap] !== "string" || !/^\d+(\.\d{1,6})?$/.test(profile[cap])) {
      throw new CliError({
        code: "DASKI_PROFILE_CAP_MALFORMED",
        message: `Profile "${name}" has a malformed ${cap}: ${profile[cap]}`,
        remediation:
          `Set ${cap} to a decimal USDC amount with at most 6 decimals, e.g. "25.00", ` +
          `in ${path}, or use daski budget to change optional budgets. See ${DOC}#budgets`,
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

/** Apply a temporary budget within any existing configured budget. */
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
    const existing = profile[cap];
    if (existing !== null && atomicUsdc(requested) > atomicUsdc(existing)) {
      throw new CliError({
        code: "DASKI_CAP_OVERRIDE_WOULD_RAISE",
        message:
          `--${flagFor(cap)} ${requested} is above the configured ${cap} of ` +
          `${profile[cap]}.`,
        remediation:
          `To change the stored budget at the user's request, use daski budget ` +
          `--${cap === "maxPerOrderUsdc" ? "per-order" : "total"} ${requested}. See ${DOC}#budgets`,
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

/** An explicit settings command; normal purchases and upgrades do not call it. */
export function configureBudgets(options: {
  profile?: string | undefined;
  perOrder?: string | undefined;
  total?: string | undefined;
  approvalAbove?: string | undefined;
}): Record<string, unknown> {
  const loaded = loadConfig(options.profile);
  const profile = { ...loaded.profile };
  for (const [value, key] of [
    [options.perOrder, "maxPerOrderUsdc"],
    [options.total, "sessionCapUsdc"],
    [options.approvalAbove, "requireApprovalAboveUsdc"],
  ] as const) {
    if (value === undefined) continue;
    if (value === "none" && key !== "requireApprovalAboveUsdc") profile[key] = null;
    else if (/^\d+(\.\d{1,6})?$/.test(value)) profile[key] = value;
    else throw new CliError({ code: "DASKI_BUDGET_INVALID",
      message: `Invalid ${key} value.`,
      remediation: "Use a decimal USDC amount, or none for an optional budget." });
  }
  const changed = options.perOrder !== undefined || options.total !== undefined || options.approvalAbove !== undefined;
  if (changed) {
    loaded.config.version = 2;
    loaded.config.profiles[loaded.profileName] = profile;
    writeFileSync(configPath(), `${JSON.stringify(loaded.config, null, 2)}\n`, { mode: 0o600 });
  }
  return { profile: loaded.profileName, changed,
    maxPerOrderUsdc: profile.maxPerOrderUsdc, sessionCapUsdc: profile.sessionCapUsdc,
    requireApprovalAboveUsdc: profile.requireApprovalAboveUsdc };
}
