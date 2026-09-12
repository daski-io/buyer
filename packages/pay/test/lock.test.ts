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

const locked = (reason: "held" | "orphaned") => new CliError({ code: reason === "orphaned" ? "TEST_ORPHANED" : "TEST_LOCKED", message: reason, remediation: "wait" });
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

test("a lock is created populated: no reader ever sees an empty file, and no staging file is left behind", async () => {
  await withDir(async (dir) => {
    const lock = join(dir, "store.lock");
    const { readdirSync, statSync } = await import("node:fs");
    await withFileLock(lock, options, async () => {
      assert.match(readFileSync(lock, "utf8"), new RegExp(`^${process.pid} [0-9a-f]{16}$`));
      assert.ok(statSync(lock).size > 0);
      assert.deepEqual(readdirSync(dir), ["store.lock"], "the staging file is gone once linked");
    });
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("reclaiming a dead owner's lock is serialized: a live reclaimer's reclaim lock makes others wait, a dead one fails closed", async () => {
  await withDir(async (dir) => {
    const lock = join(dir, "store.lock");
    const dead = `${2 ** 22 - 1} deadbeefdeadbeef`;
    writeFileSync(lock, dead);
    // Another live process is mid-reclaim: nothing is unlinked and the waiter keeps waiting.
    writeFileSync(`${lock}.reclaim`, `${process.pid} 0123456789abcdef`);
    assert.throws(() => withFileLockSync(lock, options, () => "must not run"), (error: unknown) => error instanceof CliError && error.code === "TEST_LOCKED");
    assert.equal(readFileSync(lock, "utf8"), dead, "the dead owner's lock is left to the reclaimer that holds the reclaim lock");
    assert.equal(existsSync(`${lock}.reclaim`), true);
    // The reclaimer itself died: recovery needs a person; nothing is unlinked.
    writeFileSync(`${lock}.reclaim`, `${2 ** 22 - 2} feedfacefeedface`);
    assert.throws(() => withFileLockSync(lock, options, () => "must not run"), (error: unknown) => error instanceof CliError && error.code === "TEST_ORPHANED");
    await assert.rejects(withFileLock(lock, options, async () => "must not run"), (error: unknown) => error instanceof CliError && error.code === "TEST_ORPHANED");
    assert.equal(readFileSync(lock, "utf8"), dead);
    assert.equal(existsSync(`${lock}.reclaim`), true);
    // With the reclaim lock gone, the dead owner's lock is reclaimed and both files are cleaned up afterwards.
    rmSync(`${lock}.reclaim`);
    assert.equal(withFileLockSync(lock, options, () => "ran"), "ran");
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(`${lock}.reclaim`), false);
  });
});

test("many concurrent waiters on a dead owner's lock run one at a time and leave nothing behind", async () => {
  await withDir(async (dir) => {
    const lock = join(dir, "store.lock");
    writeFileSync(lock, `${2 ** 22 - 1} deadbeefdeadbeef`);
    let inside = 0;
    let overlaps = 0;
    const holders = Array.from({ length: 8 }, (_, index) => withFileLock(lock, { waitMs: 5_000, locked }, async () => {
      inside += 1;
      if (inside > 1) overlaps += 1;
      await new Promise((resolve) => setTimeout(resolve, 5 + index));
      inside -= 1;
      return index;
    }));
    const results = await Promise.all(holders);
    assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(overlaps, 0, "the critical section never overlapped");
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(dir), []);
  });
});
