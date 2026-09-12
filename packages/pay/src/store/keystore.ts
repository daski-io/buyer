/**
 * §5 — key storage.
 *
 * A local key is written only to a store whose persistence is known by
 * construction: the macOS keychain or Windows Credential Manager (backend
 * `keychain`), or the scrypt+AES-GCM file guarded by a passphrase (backend
 * `file`). On Linux the keyring wrapper is never loaded: without a Secret
 * Service it silently fell back to the kernel session keyring and a key was
 * lost with the session, so `keychain` is refused there and the file backend
 * is named instead. For sandbox development only, `DASKI_PAYER_PRIVATE_KEY`
 * supplies a key from the environment.
 *
 * The file store distinguishes a missing file (an empty store) from one it
 * cannot read, parse, or trust (`DASKI_KEYSTORE_UNREADABLE`), and it refuses
 * to create or use a key on the latter. Every update holds an exclusive lock
 * file, writes a temporary file beside the target with owner-only mode,
 * flushes it, atomically renames it over the target, flushes the directory,
 * then reads the file back and decrypts the new entry to the expected address
 * before reporting success.
 *
 * Sandbox and mainnet never share a keychain entry or a file slot, so a
 * profile mix-up cannot reach a mainnet key. Nothing in this file logs,
 * prints, or returns key material except to the single caller that is about
 * to construct a signer.
 */
import {
  createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback,
} from "node:crypto";
import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress, type Address, type Hex } from "viem";
import { CliError } from "../cli/errors.js";
import { isInteractive, readPassphrase } from "../cli/prompt.js";
import {
  HOSTED_BACKENDS, type HostEnvironment, type KeyBackend, type KeyDurability,
} from "../host.js";
import { keystorePath } from "../paths.js";
import { withFileLock } from "./lock.js";

const scrypt = promisify(scryptCallback) as (
  password: string, salt: Buffer, keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const SERVICE = "io.daski.pay";
const DOC = "https://github.com/daski-io/buyer/blob/main/docs/keys.md";

/** Interactive-grade scrypt parameters. */
const SCRYPT = { N: 1 << 17, r: 8, p: 1 } as const;
/**
 * The largest parameters an entry may ask for on decryption: twice the
 * interactive cost. scrypt needs 128·N·r bytes, and Node's default 32 MiB
 * ceiling is below even the interactive cost, so the ceiling is derived from
 * the parameters instead of trusted to a default; a file that asks for more
 * is malformed, not a reason to allocate gigabytes.
 */
const SCRYPT_MAX = { N: 1 << 18, r: 8, p: 2 } as const;
const scryptMemory = (N: number, r: number): number => 2 * 128 * N * r;
const MIN_PASSPHRASE_LENGTH = 8;
/** How long a store update waits for another live process's lock before giving up. */
const LOCK_WAIT_MS = 30_000;

export type KeySource = "keychain" | "encrypted-file" | "environment";

export interface KeyLocation {
  source: KeySource;
  /** Human-readable, never the key. */
  description: string;
  /** What the store guarantees by construction. */
  durability: KeyDurability;
}

/** Which store a profile's local key lives in on this host. */
export interface KeyStoreSelection {
  host: HostEnvironment;
  backend: KeyBackend;
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
        `Unset DASKI_PAYER_PRIVATE_KEY, and store the ${profile} key in a durable ` +
        `backend instead: run \`daski wallet create --profile ${profile}\`. See ${DOC}`,
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

const ENVIRONMENT_LOCATION: KeyLocation = {
  source: "environment",
  description: "DASKI_PAYER_PRIVATE_KEY (developer/sandbox only)",
  durability: "environment",
};

function keychainLocation(profile: string): KeyLocation {
  return {
    source: "keychain",
    description: `OS keychain (${SERVICE}/${accountFor(profile)})`,
    durability: "persistent",
  };
}

function fileLocation(): KeyLocation {
  return {
    source: "encrypted-file",
    description: `${keystorePath()} (scrypt + AES-256-GCM)`,
    durability: "encrypted-file",
  };
}

// -- keychain backend (macOS and Windows only) ---------------------------------

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

export function keychainUnsupportedOnLinux(profile: string): CliError {
  return new CliError({
    code: "DASKI_KEYCHAIN_UNSUPPORTED_ON_LINUX",
    message:
      "The OS keychain backend is not used on Linux: without a Secret Service the keyring " +
      "wrapper falls back to the kernel session keyring, which does not survive the session.",
    remediation:
      `Use the encrypted file backend: DASKI_KEY_BACKEND=file daski wallet create --profile ${profile}. ` +
      `Without a terminal, also set DASKI_KEYSTORE_PASSPHRASE_FILE. See ${DOC}`,
  });
}

/**
 * Loads `@napi-rs/keyring` on the platforms whose native stores are persistent
 * by construction. On Linux this function never reaches the import.
 */
async function keyring(profile: string, host: HostEnvironment): Promise<KeyringEntry> {
  if (host.platform === "linux") throw keychainUnsupportedOnLinux(profile);
  let Entry: new (service: string, account: string) => KeyringEntry;
  try {
    const module = await import("@napi-rs/keyring");
    Entry = (module as { Entry: new (service: string, account: string) => KeyringEntry }).Entry;
  } catch {
    throw new CliError({
      code: "DASKI_KEYCHAIN_UNAVAILABLE",
      message: "The OS keychain backend could not be loaded on this machine.",
      remediation:
        `Reinstall @daski/pay so its optional @napi-rs/keyring binary is present, or use ` +
        `the encrypted file backend with DASKI_KEY_BACKEND=file. See ${DOC}`,
    });
  }
  return new Entry(SERVICE, accountFor(profile));
}

// -- file backend ----------------------------------------------------------------

function keystoreUnreadable(path: string, reason: string): CliError {
  return new CliError({
    code: "DASKI_KEYSTORE_UNREADABLE",
    message: `The keystore ${path} exists but cannot be used: ${reason}.`,
    remediation:
      "An unreadable or malformed keystore is never treated as empty, because creating a " +
      "key over it could hide the one already there. Restore the file from a backup or fix " +
      `its permissions, then re-run. See ${DOC}`,
  });
}

function isEncryptedEntry(value: unknown): value is EncryptedEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const { N, r, p } = entry;
  return entry.kdf === "scrypt" &&
    typeof N === "number" && Number.isSafeInteger(N) && N >= 1 << 14 && N <= SCRYPT_MAX.N && (N & (N - 1)) === 0 &&
    typeof r === "number" && Number.isSafeInteger(r) && r >= 1 && r <= SCRYPT_MAX.r &&
    typeof p === "number" && Number.isSafeInteger(p) && p >= 1 && p <= SCRYPT_MAX.p &&
    [entry.salt, entry.iv, entry.tag, entry.ciphertext].every((s) => typeof s === "string" && s.length > 0);
}

/**
 * Reads the store. A missing file is an empty store; anything else that stops
 * the file being read, parsed, or trusted is `DASKI_KEYSTORE_UNREADABLE`.
 */
function readKeystoreFile(path = keystorePath()): KeystoreFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: {} };
    throw keystoreUnreadable(path, (error as Error).message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw keystoreUnreadable(path, `not valid JSON (${(error as Error).message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw keystoreUnreadable(path, "the document is not an object");
  }
  const file = parsed as { version?: unknown; entries?: unknown };
  if (file.version !== 1 || !file.entries || typeof file.entries !== "object" || Array.isArray(file.entries)) {
    throw keystoreUnreadable(path, "unexpected document shape");
  }
  for (const [account, entry] of Object.entries(file.entries as Record<string, unknown>)) {
    if (!isEncryptedEntry(entry)) throw keystoreUnreadable(path, `entry "${account}" is malformed`);
  }
  return file as KeystoreFile;
}

function fsyncDirectory(directory: string): void {
  // Windows cannot open a directory handle for fsync; the rename is still atomic there.
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Replaces the store atomically: an owner-only temporary file beside the
 * target, flushed, renamed over the target, then the directory flushed. A
 * crash at any point leaves either the previous file or the new one, never a
 * truncated mixture.
 */
function replaceKeystoreFile(path: string, file: KeystoreFile): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(file, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  fsyncDirectory(directory);
}

/** Serializes store updates across processes with an exclusive lock file. */
function withKeystoreLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  return withFileLock(lock, {
    waitMs: LOCK_WAIT_MS,
    locked: (reason) => new CliError({
      code: "DASKI_KEYSTORE_LOCKED",
      message: reason === "orphaned"
        ? `A daski process died while recovering the keystore lock ${lock}.`
        : `Another process holds the keystore lock ${lock}.`,
      remediation: reason === "orphaned"
        ? `If no daski process is running, remove ${lock} and ${lock}.reclaim, then re-run. See ${DOC}`
        : "Wait for the other daski command to finish, then re-run. If no daski process " +
          `is running, remove the stale lock file. See ${DOC}`,
    }),
  }, run);
}

async function encrypt(privateKey: Hex, passphrase: string): Promise<EncryptedEntry> {
  const salt = randomBytes(32);
  const key = await scrypt(passphrase, salt, 32, { ...SCRYPT, maxmem: scryptMemory(SCRYPT.N, SCRYPT.r) });
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
    N: entry.N, r: entry.r, p: entry.p, maxmem: scryptMemory(entry.N, entry.r),
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

// -- passphrase ------------------------------------------------------------------

function passphraseFileInvalid(path: string, reason: string, remediation: string): CliError {
  return new CliError({
    code: "DASKI_PASSPHRASE_FILE_INVALID",
    message: `DASKI_KEYSTORE_PASSPHRASE_FILE (${path}) cannot be used: ${reason}.`,
    remediation: `${remediation} See ${DOC}`,
  });
}

/**
 * Reads the passphrase from the file `DASKI_KEYSTORE_PASSPHRASE_FILE` names.
 * The file must be a regular file with owner-only permissions; a passphrase
 * never travels on a command line.
 */
export function readPassphraseFile(path: string, platform: NodeJS.Platform): string {
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    throw passphraseFileInvalid(path, (error as Error).message,
      "Point it at a regular file containing only the passphrase.");
  }
  if (!stat.isFile()) {
    throw passphraseFileInvalid(path, "it is not a regular file",
      "Point it at a regular file containing only the passphrase.");
  }
  // Windows permissions are ACLs that Node cannot express as a mode.
  if (platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw passphraseFileInvalid(path, "it is readable or writable by other users",
      `Run: chmod 600 ${path}`);
  }
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    throw passphraseFileInvalid(path, (error as Error).message, "Fix the file's permissions.");
  }
  const passphrase = content.replace(/\r?\n$/, "");
  if (passphrase.length === 0) {
    throw passphraseFileInvalid(path, "it is empty", "Write the passphrase into the file.");
  }
  return passphrase;
}

function passphraseTooShort(): CliError {
  return new CliError({
    code: "DASKI_PASSPHRASE_TOO_SHORT",
    message: `The keystore passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`,
    remediation: "Re-run and choose a longer passphrase.",
  });
}

/**
 * The passphrase for the file store: from `DASKI_KEYSTORE_PASSPHRASE_FILE`
 * when set, otherwise from the terminal. With neither, the command refuses.
 */
export async function keystorePassphrase(
  host: HostEnvironment,
  purpose: "create" | "unlock",
  profile: string,
): Promise<string> {
  if (host.passphraseFile) {
    const passphrase = readPassphraseFile(host.passphraseFile, host.platform);
    if (purpose === "create" && passphrase.length < MIN_PASSPHRASE_LENGTH) throw passphraseTooShort();
    return passphrase;
  }
  if (!isInteractive()) {
    throw new CliError({
      code: "DASKI_PASSPHRASE_REQUIRES_TTY",
      message: "The encrypted keystore needs a passphrase, and this session has no terminal.",
      remediation:
        "Run the command from an interactive terminal, or set DASKI_KEYSTORE_PASSPHRASE_FILE " +
        "to a regular file (mode 600) containing the passphrase. The passphrase is never " +
        `taken from a flag. See ${DOC}`,
    });
  }
  if (purpose === "unlock") return readPassphrase(`Passphrase for the ${profile} keystore: `);
  const passphrase = await readPassphrase(`Choose a passphrase for ${keystorePath()}: `);
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw passphraseTooShort();
  const again = await readPassphrase("Confirm passphrase: ");
  if (again !== passphrase) {
    throw new CliError({
      code: "DASKI_PASSPHRASE_MISMATCH",
      message: "The passphrases did not match.",
      remediation: "Re-run and enter the same passphrase twice.",
    });
  }
  return passphrase;
}

// -- the store API -----------------------------------------------------------------

/** The refusal for a host whose backend holds no local key. */
export function localKeyRefusedOnHost(profile: string, backend: KeyBackend): CliError {
  const named = backend === "none" ? "no local key store (DASKI_KEY_BACKEND=none)" : `the hosted ${backend} wallet`;
  return new CliError({
    code: "DASKI_LOCAL_KEY_REFUSED_ON_HOST",
    message: `This host selects ${named}, so no local key is created or read for "${profile}".`,
    remediation:
      backend === "none"
        ? "Set DASKI_KEY_BACKEND=file (or keychain on macOS and Windows) to keep a local key, " +
          `or configure a hosted signer. See ${DOC}`
        : `Set the profile signer to ${backend} and run daski doctor --json --signer ${backend}. ` +
          `To keep a local key instead, set DASKI_KEY_BACKEND=file. See ${DOC}`,
  });
}

/** Where a key for this profile lives, without loading it. */
export async function locateKey(profile: string, store: KeyStoreSelection): Promise<KeyLocation | undefined> {
  if (process.env.DASKI_PAYER_PRIVATE_KEY) return ENVIRONMENT_LOCATION;
  if (HOSTED_BACKENDS.has(store.backend)) return undefined;
  if (store.backend === "keychain") {
    const entry = await keyring(profile, store.host);
    try {
      return entry.getPassword() ? keychainLocation(profile) : undefined;
    } catch {
      return undefined;
    }
  }
  return readKeystoreFile().entries[accountFor(profile)] ? fileLocation() : undefined;
}

/** Loads the private key for a profile, prompting for a passphrase if needed. */
export async function loadKey(profile: string, store: KeyStoreSelection): Promise<Hex> {
  const fromEnvironment = environmentKey(profile);
  if (fromEnvironment) return fromEnvironment;

  if (HOSTED_BACKENDS.has(store.backend)) throw localKeyRefusedOnHost(profile, store.backend);

  if (store.backend === "keychain") {
    const entry = await keyring(profile, store.host);
    const stored = entry.getPassword();
    if (!stored) throw noKey(profile);
    if (!/^0x[0-9a-fA-F]{64}$/.test(stored)) {
      throw new CliError({
        code: "DASKI_KEYCHAIN_ENTRY_MALFORMED",
        message: `The keychain entry for "${profile}" is not a valid private key.`,
        remediation: `Delete it and re-run \`daski wallet create --profile ${profile}\`. See ${DOC}`,
      });
    }
    return stored as Hex;
  }

  const stored = readKeystoreFile().entries[accountFor(profile)];
  if (!stored) throw noKey(profile);
  const passphrase = await keystorePassphrase(store.host, "unlock", profile);
  return decrypt(stored, passphrase);
}

function noKey(profile: string): CliError {
  return new CliError({
    code: "DASKI_NO_KEY_FOR_PROFILE",
    message: `No signing key is configured for the "${profile}" profile.`,
    remediation: `Run: daski wallet create --profile ${profile}`,
  });
}

/** Hooks a test uses to interrupt an update between its steps. Production passes none. */
export interface StoreKeyHooks {
  /** Runs after the file has been replaced and before it is read back. */
  afterWrite?: (() => void) | undefined;
  /** Substitutes the native keychain entry, so the keychain path runs against a double. */
  keyring?: ((profile: string) => KeyringEntry) | undefined;
  /** Runs after the keychain existence check and before the write. */
  beforeKeychainWrite?: (() => Promise<void> | void) | undefined;
  /** Where the keychain lock lives; defaults to a per-user temporary directory. */
  lockDirectory?: string | undefined;
}

/**
 * Serializes a profile's native keychain setup. The entry is per OS user, not
 * per DASKI_HOME, so the lock lives outside DASKI_HOME and names the entry:
 * two setups for the same profile, from any directories, take turns, and the
 * second finds the first's key instead of overwriting it after a check that
 * saw nothing.
 */
function withKeychainLock<T>(profile: string, directory: string | undefined, run: () => Promise<T>): Promise<T> {
  const name = `keychain-${SERVICE}-${accountFor(profile)}`.replace(/[^A-Za-z0-9._-]/g, "_");
  const lock = join(directory ?? join(tmpdir(), "daski-locks"), `${name}.lock`);
  return withFileLock(lock, {
    waitMs: LOCK_WAIT_MS,
    locked: (reason) => new CliError({
      code: "DASKI_KEYSTORE_LOCKED",
      message: reason === "orphaned"
        ? `A daski process died while recovering the keychain lock ${lock}.`
        : `Another process is setting up the keychain entry for "${profile}".`,
      remediation: reason === "orphaned"
        ? `If no daski process is running, remove ${lock} and ${lock}.reclaim, then re-run. See ${DOC}`
        : "Wait for the other daski command to finish, then re-run. If no daski process " +
          `is running, remove the stale lock file. See ${DOC}`,
    }),
  }, run);
}

/**
 * Stores a key for a profile. Returns where it landed so the caller can tell
 * the operator — the caller prints the location, never the key. The store is
 * re-read under the lock, so two creations for the same profile serialize to
 * one key: the second finds the first and refuses.
 */
export async function storeKey(
  profile: string,
  privateKey: Hex,
  store: KeyStoreSelection,
  hooks: StoreKeyHooks = {},
): Promise<KeyLocation> {
  if (HOSTED_BACKENDS.has(store.backend)) throw localKeyRefusedOnHost(profile, store.backend);
  const expected = privateKeyToAccount(privateKey).address;

  if (store.backend === "keychain") {
    const entry = hooks.keyring ? hooks.keyring(profile) : await keyring(profile, store.host);
    // Check, write and read-back are one critical section: a read-back alone
    // cannot tell that another setup will overwrite the entry afterwards.
    return withKeychainLock(profile, hooks.lockDirectory, async () => {
      if (entry.getPassword()) throw keyAlreadyExists(profile);
      await hooks.beforeKeychainWrite?.();
      entry.setPassword(privateKey);
      const readBack = entry.getPassword();
      if (readBack !== privateKey) throw readBackMismatch(profile);
      return keychainLocation(profile);
    });
  }

  const path = keystorePath();
  // The passphrase is obtained before the lock so a prompt never holds it.
  if (readKeystoreFile(path).entries[accountFor(profile)]) throw keyAlreadyExists(profile);
  const passphrase = await keystorePassphrase(store.host, "create", profile);
  const encrypted = await encrypt(privateKey, passphrase);
  return withKeystoreLock(path, async () => {
    const file = readKeystoreFile(path);
    if (file.entries[accountFor(profile)]) throw keyAlreadyExists(profile);
    file.entries[accountFor(profile)] = encrypted;
    replaceKeystoreFile(path, file);
    hooks.afterWrite?.();
    // Success is claimed only after the bytes on disk decrypt to this key.
    const written = readKeystoreFile(path).entries[accountFor(profile)];
    let recovered: Address | undefined;
    if (written) {
      try {
        recovered = getAddress(privateKeyToAccount(await decrypt(written, passphrase)).address);
      } catch {
        recovered = undefined;
      }
    }
    if (recovered !== expected) throw readBackMismatch(profile);
    return fileLocation();
  });
}

function keyAlreadyExists(profile: string): CliError {
  return new CliError({
    code: "DASKI_KEY_ALREADY_EXISTS",
    message: `A signing key already exists for the "${profile}" profile.`,
    remediation: `Use the existing signer with daski wallet address --profile ${profile}.`,
  });
}

function readBackMismatch(profile: string): CliError {
  return new CliError({
    code: "DASKI_KEYSTORE_READBACK_MISMATCH",
    message:
      `The key written for "${profile}" did not read back as the key that was generated, ` +
      "so the store cannot be trusted to hold it.",
    remediation:
      "Do not fund this address. Check the disk and the state directory, then re-run " +
      `daski wallet create --profile ${profile}. See ${DOC}`,
  });
}

/** True when a key already exists for this profile. */
export async function hasKey(profile: string, store: KeyStoreSelection): Promise<boolean> {
  return (await locateKey(profile, store)) !== undefined;
}
