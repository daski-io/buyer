/**
 * The encrypted file store: a missing file is an empty store, an unreadable
 * or malformed one refuses creation and use, updates are locked and atomic,
 * and success is claimed only after the bytes on disk decrypt to the key that
 * was generated.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { CliError } from "../src/cli/errors.js";
import type { HostEnvironment } from "../src/host.js";
import { hasKey, loadKey, locateKey, storeKey, type KeyStoreSelection } from "../src/store/keystore.js";

const code = (wanted: string) => (error: unknown): boolean => error instanceof CliError && error.code === wanted;
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

interface Fixture { home: string; store: KeyStoreSelection; keystore: string }

async function withStore(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const previous = process.env.DASKI_HOME;
  const home = mkdtempSync(join(tmpdir(), "daski-keystore-"));
  process.env.DASKI_HOME = home;
  const passphraseFile = join(home, "passphrase.txt");
  writeFileSync(passphraseFile, "correct horse battery\n", { mode: 0o600 });
  chmodSync(passphraseFile, 0o600);
  const host: HostEnvironment = { platform: "linux", hostClass: "durable", declaredBackend: "file",
    passphraseFile, procKeysPath: "/nonexistent" };
  try {
    await run({ home, store: { host, backend: "file" }, keystore: join(home, "keystore.json") });
  } finally {
    chmodSync(home, 0o700);
    if (previous === undefined) delete process.env.DASKI_HOME; else process.env.DASKI_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

const leftovers = (home: string): string[] => readdirSync(home).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"));

test("a missing file is an empty store; a stored key locates, loads, and is never overwritten", async () => {
  await withStore(async ({ home, store, keystore }) => {
    assert.equal(await locateKey("sandbox", store), undefined);
    assert.equal(await hasKey("sandbox", store), false);
    const key = generatePrivateKey();
    const location = await storeKey("sandbox", key, store);
    assert.equal(location.source, "encrypted-file");
    assert.equal(location.durability, "encrypted-file");
    assert.equal(await loadKey("sandbox", store), key);
    assert.equal((await locateKey("sandbox", store))?.durability, "encrypted-file");
    await assert.rejects(storeKey("sandbox", generatePrivateKey(), store), code("DASKI_KEY_ALREADY_EXISTS"));
    assert.equal(await loadKey("sandbox", store), key, "the first key survives a second creation");
    assert.deepEqual(leftovers(home), []);
    const file = JSON.parse(readFileSync(keystore, "utf8")) as { entries: Record<string, { ciphertext: string }> };
    assert.equal(Object.keys(file.entries).join(","), "payer:sandbox");
    assert.ok(!readFileSync(keystore, "utf8").includes(key.slice(2)), "the key is never on disk in clear");
  });
});

test("an interrupted update leaves the previous file intact and no temporary file behind", { skip: isRoot }, async () => {
  await withStore(async ({ home, store, keystore }) => {
    const key = generatePrivateKey();
    await storeKey("sandbox", key, store);
    const before = readFileSync(keystore, "utf8");
    // The update cannot create its lock or its temporary file, so it fails before the rename.
    chmodSync(home, 0o500);
    try {
      await assert.rejects(storeKey("mainnet", generatePrivateKey(), store));
    } finally {
      chmodSync(home, 0o700);
    }
    assert.equal(readFileSync(keystore, "utf8"), before, "the previous store is byte-identical");
    assert.deepEqual(leftovers(home), []);
    assert.equal(await loadKey("sandbox", store), key);
  });
});

test("a malformed store refuses creation and use instead of reading as empty", async () => {
  await withStore(async ({ store, keystore }) => {
    for (const content of ["{not json", "[]", JSON.stringify({ version: 2, entries: {} }),
      JSON.stringify({ version: 1, entries: { "payer:sandbox": { kdf: "scrypt" } } })]) {
      writeFileSync(keystore, content);
      await assert.rejects(storeKey("sandbox", generatePrivateKey(), store), code("DASKI_KEYSTORE_UNREADABLE"), content);
      await assert.rejects(locateKey("sandbox", store), code("DASKI_KEYSTORE_UNREADABLE"), content);
      await assert.rejects(loadKey("sandbox", store), code("DASKI_KEYSTORE_UNREADABLE"), content);
      assert.equal(readFileSync(keystore, "utf8"), content, "nothing is written over it");
    }
  });
});

test("a permission-denied store refuses creation and use", { skip: isRoot || process.platform === "win32" }, async () => {
  await withStore(async ({ store, keystore }) => {
    await storeKey("sandbox", generatePrivateKey(), store);
    chmodSync(keystore, 0o000);
    try {
      await assert.rejects(locateKey("sandbox", store), code("DASKI_KEYSTORE_UNREADABLE"));
      await assert.rejects(storeKey("mainnet", generatePrivateKey(), store), code("DASKI_KEYSTORE_UNREADABLE"));
      await assert.rejects(loadKey("sandbox", store), code("DASKI_KEYSTORE_UNREADABLE"));
    } finally {
      chmodSync(keystore, 0o600);
    }
  });
});

test("concurrent creations for the same profile serialize to one key", async () => {
  await withStore(async ({ home, store }) => {
    const first = generatePrivateKey();
    const second = generatePrivateKey();
    const results = await Promise.allSettled([storeKey("sandbox", first, store), storeKey("sandbox", second, store)]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
    assert.equal(fulfilled.length, 1, "exactly one creation wins");
    assert.equal(rejected.length, 1);
    assert.ok(code("DASKI_KEY_ALREADY_EXISTS")(rejected[0]!.reason));
    const stored = await loadKey("sandbox", store);
    assert.ok(stored === first || stored === second);
    assert.deepEqual(leftovers(home), []);
  });
});

test("concurrent updates for different profiles both persist", async () => {
  await withStore(async ({ home, store }) => {
    const sandbox = generatePrivateKey();
    const mainnet = generatePrivateKey();
    await Promise.all([storeKey("sandbox", sandbox, store), storeKey("mainnet", mainnet, store)]);
    assert.equal(await loadKey("sandbox", store), sandbox);
    assert.equal(await loadKey("mainnet", store), mainnet);
    assert.deepEqual(leftovers(home), []);
  });
});

test("a key that does not read back as written is reported as a failure, never as success", async () => {
  await withStore(async ({ home, store, keystore }) => {
    await assert.rejects(storeKey("sandbox", generatePrivateKey(), store, {
      afterWrite: () => {
        // The disk lies: the entry on disk is not the one that was written.
        const file = JSON.parse(readFileSync(keystore, "utf8")) as { entries: Record<string, { ciphertext: string }> };
        const entry = file.entries["payer:sandbox"]!;
        entry.ciphertext = Buffer.from(Buffer.from(entry.ciphertext, "base64").map((byte) => byte ^ 0xff)).toString("base64");
        writeFileSync(keystore, JSON.stringify(file));
      },
    }), (error: unknown) => code("DASKI_KEYSTORE_READBACK_MISMATCH")(error) && /Do not fund/.test((error as CliError).remediation));
    assert.deepEqual(leftovers(home), [], "the lock is released on failure too");
  });
});

test("two concurrent native-keychain setups for one profile serialize: exactly one succeeds and its key is the one stored", async () => {
  const home = mkdtempSync(join(tmpdir(), "daski-keychain-"));
  try {
    // A keyring double shared by both setups, as the OS entry is shared by every process of the user.
    const entries = new Map<string, string>();
    const account = (profile: string) => `payer:${profile}`;
    const keyring = (profile: string) => ({
      getPassword: () => entries.get(account(profile)) ?? null,
      setPassword: (value: string) => { entries.set(account(profile), value); },
      deletePassword: () => entries.delete(account(profile)),
    });
    const host: HostEnvironment = { platform: "darwin", hostClass: "durable", declaredBackend: "keychain", passphraseFile: undefined, procKeysPath: "/nonexistent" };
    const store: KeyStoreSelection = { host, backend: "keychain" };
    const first = generatePrivateKey();
    const second = generatePrivateKey();
    let releaseFirst!: () => void;
    const firstPastCheck = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let secondStarted!: () => void;
    const secondHasStarted = new Promise<void>((resolve) => { secondStarted = resolve; });
    const one = storeKey("sandbox", first, store, {
      keyring, lockDirectory: home,
      // The first setup saw no key; it pauses before writing until the second has been started.
      beforeKeychainWrite: async () => { releaseFirst(); await secondHasStarted; },
    });
    await firstPastCheck;
    const two = storeKey("sandbox", second, store, { keyring, lockDirectory: home, beforeKeychainWrite: () => { throw new Error("the second setup must never reach its write"); } });
    secondStarted();
    const [oneOutcome, twoOutcome] = await Promise.allSettled([one, two]);
    assert.equal(oneOutcome.status, "fulfilled");
    assert.equal(twoOutcome.status, "rejected");
    assert.ok(code("DASKI_KEY_ALREADY_EXISTS")((twoOutcome as PromiseRejectedResult).reason));
    assert.equal(entries.get("payer:sandbox"), first, "the first key is the one the keychain holds");
    assert.deepEqual(readdirSync(home).filter((name) => name.endsWith(".lock")), [], "the keychain lock is released");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
