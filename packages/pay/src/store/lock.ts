/**
 * A cross-process exclusive lock: a file created with O_EXCL and removed when
 * the work ends. Both stores use it. The keystore holds one for every update;
 * the order store holds one per order for a confirmation preparation, whose
 * read-check-write spans gateway and chain calls, so two processes cannot both
 * find "nothing pending" and the later write cannot drop the earlier call's
 * tracking. A lock older than the stale bound belongs to a process that died
 * holding it and is removed.
 */
import { closeSync, mkdirSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { CliError } from "../cli/errors.js";

export interface FileLockOptions {
  /** How long to wait for another process before giving up. */
  waitMs: number;
  /** A lock older than this is presumed abandoned and removed. */
  staleMs: number;
  /** The error raised when the wait expires. */
  locked: () => CliError;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function withFileLock<T>(
  lock: string,
  options: FileLockOptions,
  run: () => Promise<T>,
): Promise<T> {
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + options.waitMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > options.staleMs) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch {
        // The holder released it between our attempts; try again.
        continue;
      }
      if (Date.now() > deadline) throw options.locked();
      await sleep(25);
    }
  }
  try {
    return await run();
  } finally {
    rmSync(lock, { force: true });
  }
}
