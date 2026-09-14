/**
 * Where this CLI runs, and where a local key may live.
 *
 * Two declarations come from the environment and are reported by `doctor` as
 * separate facts: the host class (`DASKI_HOST_CLASS`) and the key backend
 * (`DASKI_KEY_BACKEND`). Neither is inferred from the other, and neither can
 * override the paid-use gate on a key found in session-only storage: a
 * declaration says what the operator believes, the backend says what the
 * store guarantees by construction, and only the second decides durability.
 *
 * Everything here is resolved once per command from an explicit environment
 * and platform, so tests can describe a Linux host with a legacy keyring entry
 * without touching the real machine.
 */
import { readFileSync } from "node:fs";
import { CliError } from "./cli/errors.js";
import type { SignerKind } from "./config.js";

const DOC = "https://github.com/daski-io/buyer/blob/main/docs/keys.md";

export type HostClass = "durable" | "ephemeral" | "undeclared";
export type KeyBackend = "keychain" | "file" | "circle-agent" | "cdp" | "none";
export type KeyDurability = "persistent" | "encrypted-file" | "session-memory" | "environment" | "none";

const HOST_CLASSES: readonly HostClass[] = ["durable", "ephemeral"];
export const KEY_BACKENDS: readonly KeyBackend[] = ["keychain", "file", "circle-agent", "cdp", "none"];
/** Backends under which no local key exists: the wallet is somewhere else, or nowhere. */
export const HOSTED_BACKENDS: ReadonlySet<KeyBackend> = new Set<KeyBackend>(["circle-agent", "cdp", "none"]);

export interface HostEnvironment {
  platform: NodeJS.Platform;
  hostClass: HostClass;
  /** The backend `DASKI_KEY_BACKEND` names, or undefined when it is unset. */
  declaredBackend: KeyBackend | undefined;
  /** `DASKI_KEYSTORE_PASSPHRASE_FILE`, when set. */
  passphraseFile: string | undefined;
  /** The kernel key listing the Linux legacy detector reads. */
  procKeysPath: string;
}

/** Resolves the host facts from an environment and platform, refusing unknown values. */
export function resolveHost(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): HostEnvironment {
  const declaredClass = env.DASKI_HOST_CLASS;
  let hostClass: HostClass = "undeclared";
  if (declaredClass !== undefined && declaredClass !== "") {
    if (!HOST_CLASSES.includes(declaredClass as HostClass)) {
      throw new CliError({
        code: "DASKI_HOST_CLASS_INVALID",
        message: `DASKI_HOST_CLASS is "${declaredClass}"; it must be durable or ephemeral.`,
        remediation:
          "Set DASKI_HOST_CLASS=durable on the user's own machine, or " +
          `DASKI_HOST_CLASS=ephemeral on an agent-managed, shared, or resettable host. See ${DOC}`,
      });
    }
    hostClass = declaredClass as HostClass;
  }
  const declaredBackend = env.DASKI_KEY_BACKEND;
  if (declaredBackend !== undefined && declaredBackend !== "" &&
      !KEY_BACKENDS.includes(declaredBackend as KeyBackend)) {
    throw new CliError({
      code: "DASKI_KEY_BACKEND_INVALID",
      message: `DASKI_KEY_BACKEND is "${declaredBackend}"; it must be one of ${KEY_BACKENDS.join(", ")}.`,
      remediation: `Set DASKI_KEY_BACKEND=file for an encrypted local key, or name the hosted wallet. See ${DOC}`,
    });
  }
  const passphraseFile = env.DASKI_KEYSTORE_PASSPHRASE_FILE;
  return {
    platform,
    hostClass,
    declaredBackend: declaredBackend ? (declaredBackend as KeyBackend) : undefined,
    passphraseFile: passphraseFile ? passphraseFile : undefined,
    procKeysPath: "/proc/keys",
  };
}

/**
 * The backend a signer kind uses on this host. An explicit declaration wins;
 * otherwise a local key goes to the platform store that is persistent by
 * construction (the OS keychain on macOS and Windows, the encrypted file on
 * Linux), and a hosted signer names itself.
 */
export function keyBackendFor(host: HostEnvironment, signer: SignerKind): KeyBackend {
  if (host.declaredBackend) return host.declaredBackend;
  switch (signer) {
    case "local":
      return host.platform === "linux" ? "file" : "keychain";
    case "circle-agent":
      return "circle-agent";
    case "cdp":
      return "cdp";
    default:
      return "none";
  }
}

/** The account name the 0.3.x keyring wrapper registered, namespaced per profile. */
export function legacyKeyringDescription(profile: string): string {
  return `keyring:payer:${profile}@io.daski.pay`;
}

/**
 * Detects a key the 0.3.x CLI stored through `@napi-rs/keyring` on a Linux
 * host without a Secret Service, where the wrapper silently fell back to the
 * kernel session keyring. The entry lives only until the login session ends.
 *
 * This is a detector and nothing more: it reads `/proc/keys`, never the
 * keyring itself, and the key it finds is never loaded.
 */
export function detectLegacyKeyringEntry(host: HostEnvironment, profile: string): boolean {
  if (host.platform !== "linux") return false;
  let listing: string;
  try {
    listing = readFileSync(host.procKeysPath, "utf8");
  } catch {
    return false;
  }
  const description = legacyKeyringDescription(profile);
  return listing.split("\n").some((line) => line.includes(description));
}

/** The refusal every paid path raises for a key that lives in session memory. */
export function keyNotDurable(profile: string): CliError {
  return new CliError({
    code: "DASKI_KEY_NOT_DURABLE",
    message:
      `The "${profile}" key was stored by an earlier release in the Linux kernel session ` +
      "keyring, which does not survive the login session. It is not used.",
    remediation:
      "Create a new wallet with the encrypted file backend: " +
      `DASKI_KEY_BACKEND=file daski wallet create --profile ${profile}. There is no migration ` +
      "command; sandbox funds only exist before mainnet. The session entry disappears when " +
      `the login session ends. See ${DOC}`,
  });
}
