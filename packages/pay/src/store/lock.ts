/**
 * Cross-process exclusive locks as files.
 *
 * A lock is created atomically and already populated: its owner (`pid token`)
 * is written to a private staging file that is hard-linked into place, so two
 * creators cannot both succeed and a lock is never observed empty. It is
 * reclaimed only when that owner is gone (a live process may legitimately
 * hold a lock for minutes, so elapsed time never decides), and reclamation is
 * serialized through a reclaim lock: two waiters that both read a dead
 * owner's token would otherwise both unlink, one of them removing the live
 * lock the other had just created. A reclaim lock whose own owner died is
 * not recovered automatically; that needs a person, and the error says so.
 * Release removes the file only while it still records this owner.
 *
 * Two flavours share the logic. The asynchronous one serializes keystore
 * updates and one order's confirmation journal across gateway and chain
 * calls. The synchronous one guards every whole-file read-modify-write of
 * the order store, whose functions are synchronous; its critical section is
 * milliseconds, so a short blocking wait is acceptable.
 */
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import type { CliError } from "../cli/errors.js";

/** Why an acquisition gave up: a live owner kept it past the wait, or a reclaim was left by a dead process. */
export type LockRefusal = "held" | "orphaned";

export interface FileLockOptions {
  /** How long to wait for a live owner before giving up. */
  waitMs: number;
  /** The error raised when the wait expires (`held`) or recovery needs a person (`orphaned`). */
  locked: (reason: LockRefusal) => CliError;
}

const POLL_MS = 25;
const SYNC_POLL_MS = 5;

function owner(): string {
  return `${process.pid} ${randomBytes(8).toString("hex")}`;
}

/** True when a process with this id exists (a permission error still means it exists). */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Create `path` holding `token`, atomically and populated; false when it exists. */
function createExclusive(path: string, token: string): boolean {
  const staging = `${path}.${token.split(" ")[1]}.staging`;
  const fd = openSync(staging, "wx", 0o600);
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(staging, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  } finally {
    rmSync(staging, { force: true });
  }
}

interface Recorded {
  content: string;
  alive: boolean;
}

/** What a lock file records and whether that owner still runs; null when the file is absent. */
function recorded(path: string): Recorded | null {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return { content, alive: processAlive(Number(content.split(" ")[0])) };
}

/** Remove the lock only while it still records this owner. */
function release(path: string, token: string): void {
  const current = recorded(path);
  if (current?.content === token) rmSync(path, { force: true });
}

type Attempt = "acquired" | "retry" | "held" | "orphaned";

function attempt(lock: string, token: string): Attempt {
  if (createExclusive(lock, token)) return "acquired";
  const current = recorded(lock);
  if (!current) return "retry";
  if (current.alive) return "held";
  // The owner died holding it. Only the holder of the reclaim lock unlinks,
  // and only the exact file it inspected.
  const reclaim = `${lock}.reclaim`;
  if (!createExclusive(reclaim, token)) {
    const reclaimer = recorded(reclaim);
    return reclaimer && !reclaimer.alive ? "orphaned" : "retry";
  }
  try {
    const again = recorded(lock);
    if (again && again.content === current.content && !again.alive) rmSync(lock, { force: true });
  } finally {
    release(reclaim, token);
  }
  return "retry";
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function withFileLock<T>(
  lock: string,
  options: FileLockOptions,
  run: () => Promise<T>,
): Promise<T> {
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const token = owner();
  const deadline = Date.now() + options.waitMs;
  for (;;) {
    const outcome = attempt(lock, token);
    if (outcome === "acquired") break;
    if (outcome === "orphaned") throw options.locked("orphaned");
    if (Date.now() > deadline) throw options.locked("held");
    await sleep(POLL_MS);
  }
  try {
    return await run();
  } finally {
    release(lock, token);
  }
}

const waiter = new Int32Array(new SharedArrayBuffer(4));

export function withFileLockSync<T>(lock: string, options: FileLockOptions, run: () => T): T {
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const token = owner();
  const deadline = Date.now() + options.waitMs;
  for (;;) {
    const outcome = attempt(lock, token);
    if (outcome === "acquired") break;
    if (outcome === "orphaned") throw options.locked("orphaned");
    if (Date.now() > deadline) throw options.locked("held");
    Atomics.wait(waiter, 0, 0, SYNC_POLL_MS);
  }
  try {
    return run();
  } finally {
    release(lock, token);
  }
}
