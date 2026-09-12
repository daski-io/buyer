/**
 * Cross-process exclusive locks as files created with O_EXCL.
 *
 * A lock names its owner (`pid token`). It is reclaimed only when that owner
 * is gone: a live process may legitimately hold a lock for minutes (a signer
 * waiting on a passphrase), so elapsed time never decides. Release removes
 * the file only while it still names this owner, so a lock a successor took
 * is never removed by mistake.
 *
 * Two flavours share the logic. The asynchronous one serializes keystore
 * updates and one order's confirmation journal across gateway and chain
 * calls. The synchronous one guards every whole-file read-modify-write of
 * the order store, whose functions are synchronous; its critical section is
 * milliseconds, so a short blocking wait is acceptable.
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import type { CliError } from "../cli/errors.js";

export interface FileLockOptions {
  /** How long to wait for a live owner before giving up. */
  waitMs: number;
  /** The error raised when the wait expires. */
  locked: () => CliError;
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

type Attempt = "acquired" | "retry" | "held";

/** One acquisition attempt; a lock whose recorded owner is gone is removed for the retry. */
function attempt(lock: string, token: string): Attempt {
  try {
    const fd = openSync(lock, "wx", 0o600);
    try {
      writeSync(fd, token);
    } finally {
      closeSync(fd);
    }
    return "acquired";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  let recorded: string;
  try {
    recorded = readFileSync(lock, "utf8");
  } catch {
    // Released between our attempts.
    return "retry";
  }
  const pid = Number(recorded.split(" ")[0]);
  if (recorded.length > 0 && !processAlive(pid)) {
    // The owner died holding it. Remove exactly the file we inspected.
    try {
      if (readFileSync(lock, "utf8") === recorded) rmSync(lock, { force: true });
    } catch {
      // Already gone.
    }
    return "retry";
  }
  return "held";
}

/** Remove the lock only while it still records this owner. */
function release(lock: string, token: string): void {
  try {
    if (readFileSync(lock, "utf8") === token) rmSync(lock, { force: true });
  } catch {
    // Already gone.
  }
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
    if (outcome === "held" && Date.now() > deadline) throw options.locked();
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
    if (outcome === "held" && Date.now() > deadline) throw options.locked();
    Atomics.wait(waiter, 0, 0, SYNC_POLL_MS);
  }
  try {
    return run();
  } finally {
    release(lock, token);
  }
}
