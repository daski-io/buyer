/**
 * `wallet create` is gated on every fact the key-durability policy names: the
 * signer kind, the declared host class, the key backend, the platform, an
 * existing key, human approval, and a passphrase source. A Linux host whose
 * earlier key sits in the kernel session keyring is detected and blocked
 * until a durable key exists.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWallet, walletAddress } from "../src/commands/wallet.js";
import { runBuy } from "../src/commands/buy.js";
import { CliError } from "../src/cli/errors.js";
import {
  detectLegacyKeyringEntry, keyBackendFor, legacyKeyringDescription, resolveHost, type HostEnvironment,
} from "../src/host.js";

const ENV = ["DASKI_HOME", "DASKI_KEY_BACKEND", "DASKI_HOST_CLASS", "DASKI_KEYSTORE_PASSPHRASE_FILE", "DASKI_PAYER_PRIVATE_KEY"] as const;
const code = (wanted: string) => (error: unknown): boolean => error instanceof CliError && error.code === wanted;

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  const home = mkdtempSync(join(tmpdir(), "daski-wallet-setup-"));
  for (const key of ENV) delete process.env[key];
  process.env.DASKI_HOME = home;
  try {
    await run(home);
  } finally {
    for (const key of ENV) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(home, { recursive: true, force: true });
  }
}

function host(overrides: Partial<HostEnvironment> = {}): HostEnvironment {
  return { platform: "linux", hostClass: "undeclared", declaredBackend: "file", passphraseFile: undefined,
    procKeysPath: "/nonexistent/proc-keys", ...overrides };
}

/** An owner-only passphrase file, the non-interactive source. */
function passphraseFile(home: string, passphrase = "correct horse battery"): string {
  const path = join(home, "passphrase.txt");
  writeFileSync(path, `${passphrase}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

test("missing-wallet setup names the authorized command, while an existing signer is reused", async () => {
  await withHome(async (home) => {
    process.env.DASKI_KEY_BACKEND = "file";
    await assert.rejects(createWallet({}), (error: unknown) => error instanceof CliError &&
      error.code === "DASKI_KEY_CREATION_NEEDS_HUMAN" && error.remediation.includes("--yes-human-approved"));
    assert.equal(existsSync(join(home, "keystore.json")), false);
    process.env.DASKI_PAYER_PRIVATE_KEY = `0x${"11".repeat(32)}`;
    const before = await walletAddress({});
    assert.equal(before.keyDurability, "environment");
    await assert.rejects(createWallet({ yesHumanApproved: true }), code("DASKI_KEY_ALREADY_EXISTS"));
    assert.deepEqual(await walletAddress({}), before);
    assert.equal(existsSync(join(home, "keystore.json")), false);
  });
});

test("the host facts come from the environment and refuse unknown values", () => {
  assert.equal(resolveHost({}, "linux").hostClass, "undeclared");
  assert.equal(resolveHost({ DASKI_HOST_CLASS: "ephemeral" }, "linux").hostClass, "ephemeral");
  assert.throws(() => resolveHost({ DASKI_HOST_CLASS: "cloud" }, "linux"), code("DASKI_HOST_CLASS_INVALID"));
  assert.throws(() => resolveHost({ DASKI_KEY_BACKEND: "vault" }, "linux"), code("DASKI_KEY_BACKEND_INVALID"));
  assert.equal(resolveHost({ DASKI_KEY_BACKEND: "circle-agent" }, "linux").declaredBackend, "circle-agent");
  // Without a declaration a local key goes to the store that is persistent by construction.
  assert.equal(keyBackendFor(host({ declaredBackend: undefined, platform: "linux" }), "local"), "file");
  assert.equal(keyBackendFor(host({ declaredBackend: undefined, platform: "darwin" }), "local"), "keychain");
  assert.equal(keyBackendFor(host({ declaredBackend: undefined, platform: "win32" }), "local"), "keychain");
  assert.equal(keyBackendFor(host({ declaredBackend: undefined }), "circle-agent"), "circle-agent");
  assert.equal(keyBackendFor(host({ declaredBackend: "file" }), "circle-agent"), "file", "a declaration wins");
});

test("wallet create is refused for a non-local signer, on an ephemeral host, with a hosted backend, and with the keychain on Linux", async () => {
  await withHome(async (home) => {
    await assert.rejects(createWallet({ host: host(), signerOverride: "circle-agent", yesHumanApproved: true }),
      (error: unknown) => code("DASKI_WALLET_CREATE_LOCAL_ONLY")(error) && /circle-agent/.test((error as CliError).remediation));
    await assert.rejects(createWallet({ host: host({ hostClass: "ephemeral" }), yesHumanApproved: true }),
      (error: unknown) => code("DASKI_LOCAL_KEY_REFUSED_ON_HOST")(error) &&
        /circle-agent/.test((error as CliError).remediation), "an ephemeral host names the hosted setup");
    for (const backend of ["circle-agent", "cdp", "none"] as const) {
      await assert.rejects(createWallet({ host: host({ declaredBackend: backend }), yesHumanApproved: true }),
        code("DASKI_LOCAL_KEY_REFUSED_ON_HOST"), backend);
    }
    await assert.rejects(createWallet({ host: host({ declaredBackend: "keychain", platform: "linux" }), yesHumanApproved: true }),
      (error: unknown) => code("DASKI_KEYCHAIN_UNSUPPORTED_ON_LINUX")(error) &&
        /DASKI_KEY_BACKEND=file/.test((error as CliError).remediation), "the file backend is named");
    // With neither a terminal nor a passphrase file the file backend refuses before writing anything.
    await assert.rejects(createWallet({ host: host(), yesHumanApproved: true }),
      (error: unknown) => code("DASKI_PASSPHRASE_REQUIRES_TTY")(error) &&
        /DASKI_KEYSTORE_PASSPHRASE_FILE/.test((error as CliError).remediation));
    assert.equal(existsSync(join(home, "keystore.json")), false);
  });
});

test("passphrase file mode creates and unlocks the key; other files are refused", { skip: process.platform === "win32" }, async () => {
  await withHome(async (home) => {
    const secure = passphraseFile(home);
    const created = await createWallet({ host: host({ passphraseFile: secure }), yesHumanApproved: true });
    assert.equal(created.created, true);
    assert.equal(created.keyBackend, "file");
    assert.equal(created.keyDurability, "encrypted-file");
    assert.equal(existsSync(join(home, "keystore.json")), true);
    assert.equal(existsSync(join(home, "keystore.json.lock")), false, "the lock is released");
    const address = await walletAddress({ host: host({ passphraseFile: secure }) });
    assert.equal(address.address, created.address, "the key unlocks through the file without a terminal");
    assert.equal(address.keyDurability, "encrypted-file");

    const loose = join(home, "loose.txt");
    writeFileSync(loose, "correct horse battery\n", { mode: 0o644 });
    chmodSync(loose, 0o644);
    await assert.rejects(walletAddress({ host: host({ passphraseFile: loose }) }),
      (error: unknown) => code("DASKI_PASSPHRASE_FILE_INVALID")(error) && /chmod 600/.test((error as CliError).remediation));
    const directory = join(home, "dir");
    mkdirSync(directory);
    await assert.rejects(walletAddress({ host: host({ passphraseFile: directory }) }), code("DASKI_PASSPHRASE_FILE_INVALID"));
    await assert.rejects(walletAddress({ host: host({ passphraseFile: join(home, "missing") }) }), code("DASKI_PASSPHRASE_FILE_INVALID"));
    const empty = join(home, "empty.txt");
    writeFileSync(empty, "", { mode: 0o600 });
    await assert.rejects(walletAddress({ host: host({ passphraseFile: empty }) }), code("DASKI_PASSPHRASE_FILE_INVALID"));
    const short = passphraseFile(join(home), "short");
    await assert.rejects(createWallet({ host: host({ passphraseFile: short }), profile: "sandbox", yesHumanApproved: true }),
      code("DASKI_KEY_ALREADY_EXISTS"), "an existing key is never overwritten, whatever the passphrase");
  });
});

test("a legacy session-keyring entry is detected, blocks paid use, and yields to a durable key", async () => {
  await withHome(async (home) => {
    const procKeys = join(home, "proc-keys");
    writeFileSync(procKeys, [
      "3b47a9ab I--Q---     1 perm 3f010000  1000  1000 user      something-else: 12",
      `1f2e3d4c I--Q---     1 perm 3f010000  1000  1000 user      ${legacyKeyringDescription("sandbox")}: 66`,
    ].join("\n"));
    const legacy = host({ procKeysPath: procKeys });
    assert.equal(detectLegacyKeyringEntry(legacy, "sandbox"), true);
    assert.equal(detectLegacyKeyringEntry(legacy, "mainnet"), false, "entries are per profile");
    assert.equal(detectLegacyKeyringEntry({ ...legacy, platform: "darwin" }, "sandbox"), false, "Linux only");
    assert.equal(detectLegacyKeyringEntry(host(), "sandbox"), false, "no listing, no entry");

    await assert.rejects(walletAddress({ host: legacy }), (error: unknown) => code("DASKI_KEY_NOT_DURABLE")(error) &&
      /DASKI_KEY_BACKEND=file daski wallet create/.test((error as CliError).remediation));
    const requestFile = join(home, "request.json");
    writeFileSync(requestFile, "{}");
    await assert.rejects(runBuy({ providerAgentId: "1", outcomeId: "x", requestFile, json: true, host: legacy }),
      code("DASKI_KEY_NOT_DURABLE"), "buy runs the same gate before touching the gateway");

    // The remedy is a new wallet with the file backend; once it exists it is used.
    const secure = passphraseFile(home);
    const created = await createWallet({ host: { ...legacy, passphraseFile: secure }, yesHumanApproved: true });
    const address = await walletAddress({ host: { ...legacy, passphraseFile: secure } });
    assert.equal(address.address, created.address);
    assert.equal(address.keyDurability, "encrypted-file");
  });
});
