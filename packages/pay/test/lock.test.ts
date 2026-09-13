/**
 * The file locks behind the keystore and the order store: reclaimed only when
 * their recorded owner is verifiably gone (never by age, since a live owner
 * may be waiting on a person; never on a pid alone, since another namespace
 * or host cannot vouch for one), and released only while they still record
 * this owner.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../src/cli/errors.js";
import {
  lockIdentity, nativeLockHost, ownerState, processAlive, startTimeFromStat, withFileLock, withFileLockSync,
  type LockHost,
} from "../src/store/lock.js";

const locked = (reason: "held" | "orphaned") => new CliError({ code: reason === "orphaned" ? "TEST_ORPHANED" : "TEST_LOCKED", message: reason, remediation: "wait" });
const DEAD_PID = 2 ** 22 - 1;
const REUSED_PID = 2 ** 22 - 2;

/**
 * A Linux host whose processes are the given pids with their start times;
 * this process is alive with start time 100 unless overridden. Every fact is
 * injected, so no namespace or boot is switched to describe another one.
 */
function fakeHost(overrides: Partial<LockHost> = {}, processes = new Map<number, string>([[process.pid, "100"], [REUSED_PID, "777"]])): LockHost {
  return {
    platform: "linux",
    hostname: () => "alpha",
    bootId: () => "boot-a",
    pidNamespace: () => "4026531836",
    startTime: (pid) => processes.get(pid) ?? "gone",
    signalable: (pid) => processes.has(pid),
    ...overrides,
  };
}
const host = fakeHost();
const options = { waitMs: 150, locked, host };
const IDENTITY = "linux/boot-a/4026531836";
/** A token whose owner is gone: no such process, or the pid was reused by a process with another start time. */
const dead = `${DEAD_PID} deadbeefdeadbeef ${IDENTITY}/50`;
const reused = `${REUSED_PID} feedfacefeedface ${IDENTITY}/50`;
const live = `${process.pid} 0123456789abcdef ${IDENTITY}/100`;

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "daski-lock-"));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a lock whose owner is verifiably gone is reclaimed at once, however young it is", async () => {
  await withDir(async (dir) => {
    const lock = join(dir, "store.lock");
    writeFileSync(lock, dead);
    const began = Date.now();
    assert.equal(withFileLockSync(lock, options, () => "ran"), "ran");
    assert.ok(Date.now() - began < 100, "no wait for a dead owner");
    assert.equal(existsSync(lock), false);
    // The pid is running again, but as another process: the owner is gone.
    writeFileSync(lock, reused);
    assert.equal(await withFileLock(lock, options, async () => "ran too"), "ran too");
    assert.equal(existsSync(lock), false);
  });
});

test("a live owner's lock is never reclaimed by age; the waiter times out and the lock stays intact", async () => {
  await withDir(async (dir) => {
    const lock = join(dir, "store.lock");
    writeFileSync(lock, live);
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);
    assert.throws(() => withFileLockSync(lock, options, () => "must not run"), (error: unknown) => error instanceof CliError && error.code === "TEST_LOCKED");
    await assert.rejects(withFileLock(lock, options, async () => "must not run"), (error: unknown) => error instanceof CliError && error.code === "TEST_LOCKED");
    assert.equal(readFileSync(lock, "utf8"), live, "the live owner's lock is untouched");
  });
});

test("an owner whose identity cannot be verified from here is never reclaimed: the waiter fails closed and the lock stays intact", async () => {
  await withDir(async (dir) => {
    const lock = join(dir, "store.lock");
    const cases: [string, string, LockHost][] = [
      ["another boot", dead, fakeHost({ bootId: () => "boot-b" })],
      ["another pid namespace (a container sharing the kernel)", dead, fakeHost({ pidNamespace: () => "4026532999" })],
      ["/proc unavailable", dead, fakeHost({ bootId: () => undefined })],
      ["the owner's stat unreadable", dead, fakeHost({ startTime: () => undefined })],
      ["a token without an identity", `${DEAD_PID} deadbeefdeadbeef`, host],
      ["a token whose identity is incomplete", `${DEAD_PID} deadbeefdeadbeef linux/boot-a//50`, host],
      ["a Linux owner read from Windows (WSL sharing DASKI_HOME)", dead, fakeHost({ platform: "win32", hostname: () => "alpha" })],
      ["a Windows owner read from WSL", `${DEAD_PID} deadbeefdeadbeef host/alpha`, host],
      ["another host", `${DEAD_PID} deadbeefdeadbeef host/beta`, fakeHost({ platform: "darwin" })],
    ];
    for (const [label, token, facts] of cases) {
      writeFileSync(lock, token);
      assert.equal(ownerState(facts, token), "unverifiable", label);
      assert.throws(() => withFileLockSync(lock, { ...options, host: facts }, () => "must not run"),
        (error: unknown) => error instanceof CliError && error.code === "TEST_LOCKED", label);
      await assert.rejects(withFileLock(lock, { ...options, host: facts }, async () => "must not run"),
        (error: unknown) => error instanceof CliError && error.code === "TEST_LOCKED", label);
      assert.equal(readFileSync(lock, "utf8"), token, `${label}: the lock is left for a person`);
      assert.equal(existsSync(`${lock}.reclaim`), false, `${label}: no reclaim was attempted`);
    }
  });
});

test("off Linux the hostname and ESRCH decide: the same host reclaims a vanished owner and keeps a live one", async () => {
  await withDir(async (dir) => {
    const lock = join(dir, "store.lock");
    const darwin = fakeHost({ platform: "darwin" });
    assert.equal(lockIdentity(darwin), "host/alpha");
    writeFileSync(lock, `${DEAD_PID} deadbeefdeadbeef host/alpha`);
    assert.equal(withFileLockSync(lock, { ...options, host: darwin }, () => "ran"), "ran");
    assert.equal(existsSync(lock), false);
    const held = `${process.pid} 0123456789abcdef host/alpha`;
    writeFileSync(lock, held);
    assert.equal(ownerState(darwin, held), "alive");
    await assert.rejects(withFileLock(lock, { ...options, host: darwin }, async () => "must not run"),
      (error: unknown) => error instanceof CliError && error.code === "TEST_LOCKED");
    assert.equal(readFileSync(lock, "utf8"), held);
  });
});

test("the real host records a verifiable identity for this process, and a pid that does not exist reads as gone", () => {
  const native = nativeLockHost();
  const identity = lockIdentity(native);
  if (process.platform === "linux") {
    assert.match(identity, /^linux\/[0-9a-f-]{36}\/\d+\/\d+$/, identity);
  } else {
    assert.match(identity, /^host\/.+$/, identity);
  }
  assert.equal(ownerState(native, `${process.pid} 0123456789abcdef ${identity}`), "alive");
  assert.equal(processAlive(DEAD_PID), false);
  assert.equal(ownerState(native, `${DEAD_PID} deadbeefdeadbeef ${identity}`), "gone");
  // A command name with spaces and parentheses does not shift the start-time field.
  assert.equal(startTimeFromStat("1234 (my (odd) name) S 1 1234 1234 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0 98765 1000 200 18446744073709551615"), "98765");
  assert.equal(startTimeFromStat("garbage"), undefined);
});

test("release removes the lock only while it still records this owner", async () => {
  await withDir(async (dir) => {
    const lock = join(dir, "store.lock");
    await withFileLock(lock, options, async () => {
      // A successor took the lock (as a wrongful reclaim would let it); ours must not remove theirs.
      writeFileSync(lock, `${process.pid} successor ${IDENTITY}/100`);
    });
    assert.equal(readFileSync(lock, "utf8"), `${process.pid} successor ${IDENTITY}/100`);
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

test("a lock is created populated with the owner's identity: no reader ever sees an empty file, and no staging file is left behind", async () => {
  await withDir(async (dir) => {
    const lock = join(dir, "store.lock");
    const { readdirSync, statSync } = await import("node:fs");
    await withFileLock(lock, { waitMs: 150, locked }, async () => {
      const content = readFileSync(lock, "utf8");
      assert.match(content, new RegExp(`^${process.pid} [0-9a-f]{16} (linux/[^/ ]+/[^/ ]+/[^/ ]+|host/[^ ]+)$`), content);
      assert.equal(content.split(" ")[2], lockIdentity(nativeLockHost()));
      assert.ok(statSync(lock).size > 0);
      assert.deepEqual(readdirSync(dir), ["store.lock"], "the staging file is gone once linked");
    });
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("reclaiming a dead owner's lock is serialized: a live reclaimer's reclaim lock makes others wait, a dead one fails closed", async () => {
  await withDir(async (dir) => {
    const lock = join(dir, "store.lock");
    writeFileSync(lock, dead);
    // Another live process is mid-reclaim: nothing is unlinked and the waiter keeps waiting.
    writeFileSync(`${lock}.reclaim`, live);
    assert.throws(() => withFileLockSync(lock, options, () => "must not run"), (error: unknown) => error instanceof CliError && error.code === "TEST_LOCKED");
    assert.equal(readFileSync(lock, "utf8"), dead, "the dead owner's lock is left to the reclaimer that holds the reclaim lock");
    assert.equal(existsSync(`${lock}.reclaim`), true);
    // The reclaimer itself died: recovery needs a person; nothing is unlinked.
    writeFileSync(`${lock}.reclaim`, reused);
    assert.throws(() => withFileLockSync(lock, options, () => "must not run"), (error: unknown) => error instanceof CliError && error.code === "TEST_ORPHANED");
    await assert.rejects(withFileLock(lock, options, async () => "must not run"), (error: unknown) => error instanceof CliError && error.code === "TEST_ORPHANED");
    assert.equal(readFileSync(lock, "utf8"), dead);
    assert.equal(existsSync(`${lock}.reclaim`), true);
    // A reclaimer that cannot be verified is waited for, never declared dead.
    writeFileSync(`${lock}.reclaim`, `${DEAD_PID} 0123456789abcdef linux/boot-b/4026531836/50`);
    assert.throws(() => withFileLockSync(lock, options, () => "must not run"), (error: unknown) => error instanceof CliError && error.code === "TEST_LOCKED");
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
    writeFileSync(lock, dead);
    let inside = 0;
    let overlaps = 0;
    const holders = Array.from({ length: 8 }, (_, index) => withFileLock(lock, { waitMs: 5_000, locked, host }, async () => {
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
