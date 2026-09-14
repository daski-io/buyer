/**
 * Cross-process exclusive locks as files.
 *
 * A lock is created atomically and already populated: its owner (`pid random
 * identity`) is written to a private staging file that is hard-linked into
 * place, so two creators cannot both succeed and a lock is never observed
 * empty. It is reclaimed only when that owner is verifiably gone (a live
 * process may legitimately hold a lock for minutes, so elapsed time never
 * decides), and reclamation is serialized through a reclaim lock: two waiters
 * that both read a dead owner's token would otherwise both unlink, one of
 * them removing the live lock the other had just created. A reclaim lock
 * whose own owner died is not recovered automatically; that needs a person,
 * and the error says so. Release removes the file only while it still
 * records this owner.
 *
 * A pid alone does not identify a process across the places one state
 * directory can be shared: a container mount or Windows and WSL see each
 * other's pids in different namespaces, so `process.kill(pid, 0)` answers
 * ESRCH for a live owner. The token therefore records where the owner runs:
 * on Linux the kernel boot id, the pid namespace, and the owner's start time
 * (field 22 of `/proc/<pid>/stat`, which a reused pid does not repeat); on
 * other platforms the hostname. An owner is reclaimable only when that
 * identity can be verified from here and shows the process gone; an owner
 * from another boot, namespace, or host, or one recorded without an identity,
 * cannot be verified and is never reclaimed, so the waiter fails closed with
 * the "locked, remove manually" remediation instead.
 *
 * Two flavours share the logic. The asynchronous one serializes keystore
 * updates and one order's confirmation journal across gateway and chain
 * calls. The synchronous one guards every whole-file read-modify-write of
 * the order store, whose functions are synchronous; its critical section is
 * milliseconds, so a short blocking wait is acceptable.
 */
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, readlinkSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { CliError } from "../cli/errors.js";

/** Why an acquisition gave up: a live or unverifiable owner kept it past the wait, or a reclaim was left by a dead process. */
export type LockRefusal = "held" | "orphaned";

/**
 * The facts a lock owner's identity is recorded from and checked against.
 * Injectable so a test can describe another boot, namespace, or host without
 * switching any of them.
 */
export interface LockHost {
  platform: NodeJS.Platform;
  hostname(): string;
  /** Linux: `/proc/sys/kernel/random/boot_id`; undefined when it cannot be read. */
  bootId(): string | undefined;
  /** Linux: this process's pid namespace (`/proc/self/ns/pid`); undefined when it cannot be read. */
  pidNamespace(): string | undefined;
  /** Linux: field 22 of `/proc/<pid>/stat`; `gone` when `/proc/<pid>` is absent; undefined when it cannot be read. */
  startTime(pid: number): string | "gone" | undefined;
  /** `process.kill(pid, 0)`: false only on ESRCH (a permission error still means the process exists). */
  signalable(pid: number): boolean;
}

export interface FileLockOptions {
  /** How long to wait for a live (or unverifiable) owner before giving up. */
  waitMs: number;
  /** The error raised when the wait expires (`held`) or recovery needs a person (`orphaned`). */
  locked: (reason: LockRefusal) => CliError;
  /** Where this process runs; defaults to the real host. */
  host?: LockHost | undefined;
}

const POLL_MS = 25;
const SYNC_POLL_MS = 5;

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

function readTrimmed(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

/**
 * Field 22 of a `/proc/<pid>/stat` line: the start time in clock ticks since
 * boot. The command name (field 2) may contain spaces and parentheses, so
 * fields are counted from the last closing parenthesis, after which field 3
 * is first.
 */
export function startTimeFromStat(stat: string): string | undefined {
  const end = stat.lastIndexOf(")");
  if (end < 0) return undefined;
  const start = stat.slice(end + 1).trim().split(/\s+/)[22 - 3];
  return start !== undefined && /^\d+$/.test(start) ? start : undefined;
}

/** The real host's facts. */
export function nativeLockHost(platform: NodeJS.Platform = process.platform): LockHost {
  return {
    platform,
    hostname: () => hostname(),
    bootId: () => readTrimmed("/proc/sys/kernel/random/boot_id"),
    pidNamespace: () => {
      try {
        return /\[(\d+)\]/.exec(readlinkSync("/proc/self/ns/pid"))?.[1];
      } catch {
        return undefined;
      }
    },
    startTime: (pid) => {
      let stat: string;
      try {
        stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : undefined;
      }
      return startTimeFromStat(stat);
    },
    signalable: processAlive,
  };
}

/**
 * This process's identity as its lock tokens record it: `linux/<boot id>/<pid
 * namespace>/<start time>`, or `host/<hostname>` off Linux. A part that cannot
 * be read is left empty, which no reader verifies, so such a lock is only
 * ever removed by hand.
 */
export function lockIdentity(host: LockHost, pid = process.pid): string {
  if (host.platform !== "linux") return `host/${host.hostname()}`;
  const start = host.startTime(pid);
  return ["linux", host.bootId() ?? "", host.pidNamespace() ?? "", start === undefined || start === "gone" ? "" : start].join("/");
}

export type OwnerState = "alive" | "gone" | "unverifiable";

/**
 * Whether the owner a token names is still running. `gone` only when the
 * recorded identity is verifiable from here and shows it: on Linux the same
 * boot and pid namespace with `/proc/<pid>` absent or a different start time
 * (the pid was reused); elsewhere the same hostname with ESRCH. Anything else
 * (another boot, namespace, or host; `/proc` unavailable; a token without an
 * identity) is `unverifiable`, which is treated like `alive`: never reclaimed.
 */
export function ownerState(host: LockHost, token: string): OwnerState {
  const [pidText, , identity] = token.split(" ");
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0 || identity === undefined) return "unverifiable";
  const parts = identity.split("/");
  if (parts[0] === "linux" && parts.length === 4) {
    const [, bootId, namespace, start] = parts;
    if (host.platform !== "linux" || !bootId || !namespace || !start) return "unverifiable";
    if (host.bootId() !== bootId || host.pidNamespace() !== namespace) return "unverifiable";
    const current = host.startTime(pid);
    if (current === "gone") return "gone";
    if (current === undefined) return "unverifiable";
    return current === start ? "alive" : "gone";
  }
  if (parts[0] === "host" && parts.length === 2 && parts[1]) {
    if (host.platform === "linux" || host.hostname() !== parts[1]) return "unverifiable";
    return host.signalable(pid) ? "alive" : "gone";
  }
  return "unverifiable";
}

function owner(host: LockHost): string {
  return `${process.pid} ${randomBytes(8).toString("hex")} ${lockIdentity(host)}`;
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
  state: OwnerState;
}

/** What a lock file records and whether that owner still runs; null when the file is absent. */
function recorded(path: string, host: LockHost): Recorded | null {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return { content, state: ownerState(host, content) };
}

/** Remove the lock only while it still records this owner. */
function release(path: string, token: string): void {
  let current: string | undefined;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    return;
  }
  if (current === token) rmSync(path, { force: true });
}

type Attempt = "acquired" | "retry" | "held" | "orphaned";

function attempt(lock: string, token: string, host: LockHost): Attempt {
  if (createExclusive(lock, token)) return "acquired";
  const current = recorded(lock, host);
  if (!current) return "retry";
  // A live owner keeps it; so does one that cannot be verified from here.
  if (current.state !== "gone") return "held";
  // The owner died holding it. Only the holder of the reclaim lock unlinks,
  // and only the exact file it inspected.
  const reclaim = `${lock}.reclaim`;
  if (!createExclusive(reclaim, token)) {
    const reclaimer = recorded(reclaim, host);
    return reclaimer?.state === "gone" ? "orphaned" : "retry";
  }
  try {
    const again = recorded(lock, host);
    if (again && again.content === current.content && again.state === "gone") rmSync(lock, { force: true });
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
  const host = options.host ?? nativeLockHost();
  const token = owner(host);
  const deadline = Date.now() + options.waitMs;
  for (;;) {
    const outcome = attempt(lock, token, host);
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
  const host = options.host ?? nativeLockHost();
  const token = owner(host);
  const deadline = Date.now() + options.waitMs;
  for (;;) {
    const outcome = attempt(lock, token, host);
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
