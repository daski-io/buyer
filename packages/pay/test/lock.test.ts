/**
 * The file locks behind the keystore and the order store: reclaimed only when
 * their recorded owner is gone (never by age, since a live owner may be
 * waiting on a person), and released only while they still record this owner.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../src/cli/errors.js";
import { processAlive, withFileLock, withFileLockSync } from "../src/store/lock.js";

const locked = () => new CliError({ code: "TEST_LOCKED", message: "locked", remediation: "wait" });
const options = { waitMs: 150, locked };

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "daski-lock-"));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a lock whose owner died is reclaimed at once, however young it is", async () => {
  await withDir(async (dir) => {
    const lock = join(dir, "store.lock");
    // No process with this id exists; the file is fresh.
    assert.equal(processAlive(2 ** 22 - 1), false);
    writeFileSync(lock, `${2 ** 22 - 1} deadbeefdeadbeef`);
    const began = Date.now();
    assert.equal(withFileLockSync(lock, options, () => "ran"), "ran");
    assert.ok(Date.now() - began < 100, "no wait for a dead owner");
    assert.equal(existsSync(lock), false);
    assert.equal(await withFileLock(lock, options, async () => "ran too"), "ran too");
  });
});

test("a live owner's lock is never reclaimed by age; the waiter times out and the lock stays intact", async () => {
  await withDir(async (dir) => {
    const lock = join(dir, "store.lock");
    const content = `${process.pid} 0123456789abcdef`;
    writeFileSync(lock, content);
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);
    assert.throws(() => withFileLockSync(lock, options, () => "must not run"), (error: unknown) => error instanceof CliError && error.code === "TEST_LOCKED");
    await assert.rejects(withFileLock(lock, options, async () => "must not run"), (error: unknown) => error instanceof CliError && error.code === "TEST_LOCKED");
    assert.equal(readFileSync(lock, "utf8"), content, "the live owner's lock is untouched");
  });
});

test("release removes the lock only while it still records this owner", async () => {
  await withDir(async (dir) => {
    const lock = join(dir, "store.lock");
    await withFileLock(lock, options, async () => {
      // A successor took the lock (as a wrongful reclaim would let it); ours must not remove theirs.
      writeFileSync(lock, `${process.pid} successor`);
    });
    assert.equal(readFileSync(lock, "utf8"), `${process.pid} successor`);
    rmSync(lock);
    withFileLockSync(lock, options, () => undefined);
    assert.equal(existsSync(lock), false, "our own lock is released");
  });
});

test("concurrent holders serialize: the second waits for the live first and then acquires", async () => {
  await withDir(async (dir) => {
    const lock = join(dir, "order.lock");
    const order: string[] = [];
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = withFileLock(lock, { waitMs: 2_000, locked }, async () => { order.push("first-in"); await held; order.push("first-out"); });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = withFileLock(lock, { waitMs: 2_000, locked }, async () => { order.push("second"); });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(order, ["first-in"], "the second holder waits while the first is alive");
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first-in", "first-out", "second"]);
    assert.equal(existsSync(lock), false);
  });
});
