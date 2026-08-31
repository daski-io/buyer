/**
 * §5 — key storage.
 *
 * Order of preference: the OS keychain, then an scrypt+AES-GCM file guarded by
 * a passphrase, then — for sandbox development only — an environment variable.
 * Sandbox and mainnet never share a keychain entry or a file slot, so a
 * profile mix-up cannot reach a mainnet key.
 *
 * Nothing in this file logs, prints, or returns key material except to the
 * single caller that is about to construct a signer.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { Hex } from "viem";
import { CliError } from "../cli/errors.js";
import { readPassphrase } from "../cli/prompt.js";
import { keystorePath } from "../paths.js";

const scrypt = promisify(scryptCallback) as (
  password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number },
) => Promise<Buffer>;

const SERVICE = "io.daski.pay";
const DOC = "https://github.com/daski-io/buyer/blob/main/docs/keys.md";

/** Interactive-grade scrypt parameters. */
const SCRYPT = { N: 1 << 17, r: 8, p: 1 } as const;

export type KeySource = "keychain" | "encrypted-file" | "environment";

export interface KeyLocation {
  source: KeySource;
  /** Human-readable, never the key. */
  description: string;
}

interface KeystoreFile {
  version: 1;
  entries: Record<string, EncryptedEntry>;
}

interface EncryptedEntry {
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

/** Keychain and file entries are namespaced by profile, never shared. */
function accountFor(profile: string): string {
  return `payer:${profile}`;
}

/** The developer escape hatch, and only for a sandbox profile. */
function environmentKey(profile: string): Hex | undefined {
  const raw = process.env.DASKI_PAYER_PRIVATE_KEY;
  if (!raw) return undefined;
  if (profile !== "sandbox") {
    throw new CliError({
      code: "DASKI_ENV_KEY_REFUSED_OFF_SANDBOX",
      message:
        `DASKI_PAYER_PRIVATE_KEY is set, but the active profile is "${profile}". ` +
        "The environment-variable signer is sandbox-only.",
      remediation:
        `Unset DASKI_PAYER_PRIVATE_KEY, and store the ${profile} key in the OS ` +
        `keychain instead: run \`daski wallet create --profile ${profile}\`. See ${DOC}`,
    });
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new CliError({
      code: "DASKI_ENV_KEY_MALFORMED",
      message: "DASKI_PAYER_PRIVATE_KEY is not a 32-byte 0x-prefixed hex key.",
      remediation: `Unset it, or set a valid key. See ${DOC}`,
    });
  }
  return raw as Hex;
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

/**
 * Loads `@napi-rs/keyring` if the platform has it. It is an optional
 * dependency with prebuilt binaries and no install scripts, so its absence is
 * normal rather than exceptional — we fall through to the file keystore.
 */
async function keyring(profile: string): Promise<KeyringEntry | undefined> {
  if (process.env.DASKI_DISABLE_KEYCHAIN === "1") return undefined;
  try {
    const module = await import("@napi-rs/keyring");
    const Entry = (module as { Entry: new (service: string, account: string) => KeyringEntry }).Entry;
    return new Entry(SERVICE, accountFor(profile));
  } catch {
    return undefined;
  }
}

function readKeystoreFile(): KeystoreFile {
  try {
    const parsed = JSON.parse(readFileSync(keystorePath(), "utf8")) as KeystoreFile;
    if (parsed.version !== 1 || typeof parsed.entries !== "object") throw new Error("shape");
    return parsed;
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeKeystoreFile(file: KeystoreFile): void {
  const path = keystorePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function encrypt(privateKey: Hex, passphrase: string): Promise<EncryptedEntry> {
  const salt = randomBytes(32);
  const key = await scrypt(passphrase, salt, 32, SCRYPT);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(privateKey.slice(2), "hex")),
    cipher.final(),
  ]);
  return {
    kdf: "scrypt",
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

async function decrypt(entry: EncryptedEntry, passphrase: string): Promise<Hex> {
  const key = await scrypt(passphrase, Buffer.from(entry.salt, "base64"), 32, {
    N: entry.N, r: entry.r, p: entry.p,
  });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "base64"));
  decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
  try {
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(entry.ciphertext, "base64")),
      decipher.final(),
    ]);
    return `0x${plaintext.toString("hex")}` as Hex;
  } catch {
    // GCM authentication failed: a wrong passphrase, or a tampered file.
    throw new CliError({
      code: "DASKI_KEYSTORE_DECRYPT_FAILED",
      message: "The keystore could not be decrypted with that passphrase.",
      remediation:
        "Re-run and enter the passphrase used when the key was created. If it " +
        `is lost, the key cannot be recovered from this file. See ${DOC}`,
    });
  }
}

/** Where a key for this profile lives, without loading it. */
export async function locateKey(profile: string): Promise<KeyLocation | undefined> {
  if (process.env.DASKI_PAYER_PRIVATE_KEY) {
    return {
      source: "environment",
      description: "DASKI_PAYER_PRIVATE_KEY (developer/sandbox only)",
    };
  }
  const entry = await keyring(profile);
  if (entry) {
    try {
      if (entry.getPassword()) {
        return { source: "keychain", description: `OS keychain (${SERVICE}/${accountFor(profile)})` };
      }
    } catch {
      // An unavailable keychain is not an error here; fall through to the file.
    }
  }
  if (readKeystoreFile().entries[accountFor(profile)]) {
    return { source: "encrypted-file", description: `${keystorePath()} (scrypt + AES-256-GCM)` };
  }
  return undefined;
}

/** Loads the private key for a profile, prompting for a passphrase if needed. */
export async function loadKey(profile: string): Promise<Hex> {
  const fromEnvironment = environmentKey(profile);
  if (fromEnvironment) return fromEnvironment;

  const entry = await keyring(profile);
  if (entry) {
    try {
      const stored = entry.getPassword();
      if (stored) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(stored)) {
          throw new CliError({
            code: "DASKI_KEYCHAIN_ENTRY_MALFORMED",
            message: `The keychain entry for "${profile}" is not a valid private key.`,
            remediation: `Delete it and re-run \`daski wallet create --profile ${profile}\`. See ${DOC}`,
          });
        }
        return stored as Hex;
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
    }
  }

  const stored = readKeystoreFile().entries[accountFor(profile)];
  if (!stored) {
    throw new CliError({
      code: "DASKI_NO_KEY_FOR_PROFILE",
      message: `No signing key is configured for the "${profile}" profile.`,
      remediation: `Run: daski wallet create --profile ${profile}`,
    });
  }
  const passphrase = await readPassphrase(`Passphrase for the ${profile} keystore: `);
  return decrypt(stored, passphrase);
}

/**
 * Stores a key for a profile. Returns where it landed so the caller can tell
 * the operator — the caller prints the location, never the key.
 */
export async function storeKey(profile: string, privateKey: Hex): Promise<KeyLocation> {
  const entry = await keyring(profile);
  if (entry) {
    try {
      entry.setPassword(privateKey);
      return { source: "keychain", description: `OS keychain (${SERVICE}/${accountFor(profile)})` };
    } catch {
      // No usable keychain (headless Linux without libsecret, for example).
    }
  }
  const passphrase = await readPassphrase(
    `No OS keychain is available. Choose a passphrase for ${keystorePath()}: `,
  );
  if (passphrase.length < 8) {
    throw new CliError({
      code: "DASKI_PASSPHRASE_TOO_SHORT",
      message: "The keystore passphrase must be at least 8 characters.",
      remediation: "Re-run and choose a longer passphrase.",
    });
  }
  const again = await readPassphrase("Confirm passphrase: ");
  if (again !== passphrase) {
    throw new CliError({
      code: "DASKI_PASSPHRASE_MISMATCH",
      message: "The passphrases did not match.",
      remediation: "Re-run and enter the same passphrase twice.",
    });
  }
  const file = readKeystoreFile();
  file.entries[accountFor(profile)] = await encrypt(privateKey, passphrase);
  writeKeystoreFile(file);
  return { source: "encrypted-file", description: `${keystorePath()} (scrypt + AES-256-GCM)` };
}

/** True when a key already exists for this profile. */
export async function hasKey(profile: string): Promise<boolean> {
  return (await locateKey(profile)) !== undefined;
}
