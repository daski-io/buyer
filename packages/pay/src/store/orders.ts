/**
 * §5 — the order store.
 *
 * This file is what makes a multi-day order survive the agent process that
 * placed it. `daski order status <handle>` works from a cold start with
 * nothing but the handle, because everything needed to re-derive authority
 * lives here rather than in memory.
 *
 * It is also the reconciliation index: a purchase records its intent *before*
 * the signature goes out, so an interrupted buy can be looked up instead of
 * re-signed.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address, Hex } from "viem";
import { CliError } from "../cli/errors.js";
import { ordersPath } from "../paths.js";
import { withFileLock, withFileLockSync } from "./lock.js";

export type OrderState =
  | "INTENT_RECORDED"
  | "AUTHORIZED"
  | "SUBMITTED"
  | "FULFILLED"
  | "INPUT_REQUIRED"
  | "PROVIDER_FAILED"
  | "CANCELED"
  | "PENDING_RECONCILIATION"
  /** The gateway said the authorization did not settle; nothing was charged. */
  | "NOT_SETTLED";

/** A stored read capability, when the gateway issues one (spec 01 §8). */
export interface ReadCapability {
  token: string;
  /** Unix seconds. */
  expiresAt: number;
}

/** A sponsored review submission retained for retries while sponsorship is pending. */
export interface ConfirmationSubmissionRecord {
  action: "confirmation" | "revoke-confirmation";
  request: { phase: "submit"; submission: "sponsored"; preparationId: string; signature: string };
}

export type ConfirmationTxState = "prepared" | "submitted" | "observed" | "abandoned";

/** What the direct-mode call commits to, so a receipt can be bound to it later. */
export interface ConfirmationTxExpected {
  schema: Hex;
  recipient: Address;
  refUID: Hex;
  /** keccak256 of the attestation data. */
  dataHash: Hex;
  /** For a revocation: the attestation being revoked. */
  uid?: Hex | undefined;
}

/**
 * A direct-mode confirmation the wallet's own tool submits. `submitted` means
 * a hash was recorded and nothing has been verified yet; `observed` means the
 * receipt, the EAS event, the attestation, and the gateway's final read
 * all agree.
 */
export interface ConfirmationTxRecord {
  action: "attest" | "revoke";
  callHash: Hex;
  expected: ConfirmationTxExpected;
  txHash?: Hex | undefined;
  state: ConfirmationTxState;
  /** The attestation the observed receipt created or revoked. */
  uid?: Hex | undefined;
  preparedAt: string;
}

export interface OrderRecord {
  /** The gateway's order handle, once known. */
  handle?: string | undefined;
  /** Our payment identifier: the reconciliation key, known before signing. */
  intentId: string;
  profile: string;
  providerAgentId: string;
  outcomeId: string;
  payer: string;
  /** Atomic USDC. */
  amount: string;
  /** Approved business terms, used to distinguish repeat purchases. */
  approvalTermsHash?: string | undefined;
  state: OrderState;
  /** The recomputed authorization nonce; identifies the order on-chain. */
  authorizationNonce?: string | undefined;
  readCapability?: ReadCapability | undefined;
  confirmationSubmission?: ConfirmationSubmissionRecord | undefined;
  /** The direct-mode confirmation in flight or last observed, if any. */
  confirmationTx?: ConfirmationTxRecord | undefined;
  createdAt: string;
  updatedAt: string;
  /** The request body, kept so an interrupted purchase can be replayed byte-identically. */
  request?: Record<string, unknown> | undefined;
}

interface OrderFile {
  version: 1;
  orders: OrderRecord[];
}

function read(): OrderFile {
  try {
    const parsed = JSON.parse(readFileSync(ordersPath(), "utf8")) as OrderFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.orders)) throw new Error("shape");
    return parsed;
  } catch {
    return { version: 1, orders: [] };
  }
}

/** How long a whole-file update waits for another process's update. */
const STORE_LOCK_WAIT_MS = 10_000;

/**
 * Every read-modify-write of the whole file runs under one store-wide lock:
 * the file holds every order, so two commands updating different orders
 * would otherwise read the same version and the later rename would drop the
 * earlier order's update. The rename only protects against truncation.
 */
function withStoreLock<T>(run: () => T): T {
  const lock = `${ordersPath()}.lock`;
  return withFileLockSync(lock, {
    waitMs: STORE_LOCK_WAIT_MS,
    locked: (reason) => new CliError({
      code: "DASKI_ORDER_STORE_LOCKED",
      message: reason === "orphaned"
        ? "A daski process died while recovering the order store lock."
        : "Another daski command is updating the order store.",
      remediation: reason === "orphaned"
        ? `If no daski process is running, remove ${lock} and ${lock}.reclaim, then re-run.`
        : "Wait for it to finish, then re-run. If no daski process is running, remove the " +
          "stale orders.json.lock file.",
    }),
  }, run);
}

/** Writes via a temp file and rename, so a crash cannot truncate the store. */
function write(file: OrderFile): void {
  const path = ordersPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function listOrders(profile?: string): OrderRecord[] {
  const orders = read().orders;
  return profile ? orders.filter((order) => order.profile === profile) : orders;
}

/** Finds by handle first, then by intent id, so either identifier works. */
export function findOrder(handleOrIntent: string, profile?: string): OrderRecord | undefined {
  return listOrders(profile).find(
    (order) => order.handle === handleOrIntent || order.intentId === handleOrIntent,
  );
}

export function findByIntent(intentId: string): OrderRecord | undefined {
  return read().orders.find((order) => order.intentId === intentId);
}

/** Inserts or updates by intent id. The intent id is the stable key. */
export function upsertOrder(record: OrderRecord): OrderRecord {
  return withStoreLock(() => {
    const file = read();
    const now = new Date().toISOString();
    const index = file.orders.findIndex((order) => order.intentId === record.intentId);
    const merged: OrderRecord = { ...record, updatedAt: now };
    if (index >= 0) {
      merged.createdAt = file.orders[index]!.createdAt;
      file.orders[index] = merged;
    } else {
      file.orders.push(merged);
    }
    write(file);
    return merged;
  });
}

export function updateOrder(
  intentId: string,
  changes: Partial<Omit<OrderRecord, "intentId" | "createdAt">>,
): OrderRecord | undefined {
  return withStoreLock(() => {
    const file = read();
    const index = file.orders.findIndex((order) => order.intentId === intentId);
    if (index < 0) return undefined;
    const merged: OrderRecord = {
      ...file.orders[index]!,
      ...changes,
      updatedAt: new Date().toISOString(),
    };
    file.orders[index] = merged;
    write(file);
    return merged;
  });
}

/** How long a command waits for another live process's work on the same order. */
const ORDER_LOCK_WAIT_MS = 10_000;

/**
 * Serializes one order's confirmation journal across processes. The
 * read-check-write of a preparation spans gateway and chain calls; without
 * the lock two preparations both find nothing pending and the later write
 * drops the earlier validated call's tracking. The lock is reclaimed only
 * when its owner is gone, never by age: the owner may be waiting on a person.
 */
export function withOrderLock<T>(intentId: string, run: () => Promise<T>): Promise<T> {
  const name = intentId.replace(/[^A-Za-z0-9._-]/g, "_");
  const lock = `${ordersPath()}.${name}.lock`;
  return withFileLock(lock, {
    waitMs: ORDER_LOCK_WAIT_MS,
    locked: (reason) => new CliError({
      code: "DASKI_ORDER_LOCKED",
      message: reason === "orphaned"
        ? "A daski process died while recovering this order's lock."
        : "Another daski command is updating this order's confirmation record.",
      remediation: reason === "orphaned"
        ? `If no daski process is running, remove ${lock} and ${lock}.reclaim, then re-run.`
        : "Wait for it to finish, then re-run. If no daski process is running, remove the " +
          "stale .lock file next to orders.json.",
    }),
  }, run);
}

/** States under which no USDC was authorized, or the gateway says none settled. */
const UNSPENT_STATES: ReadonlySet<OrderState> = new Set<OrderState>(["INTENT_RECORDED", "NOT_SETTLED"]);

/** True when the record consumed no session budget and its identifier may be signed for again. */
export function isUnspent(record: OrderRecord): boolean {
  return UNSPENT_STATES.has(record.state);
}

/** Total atomic USDC authorized for a profile: the §4.1.5 session running total. */
export function authorizedTotalAtomic(profile: string): bigint {
  return listOrders(profile)
    .filter((order) => !isUnspent(order))
    .reduce((total, order) => total + BigInt(order.amount), 0n);
}

/** A stored capability that is still usable, or undefined. */
export function activeReadCapability(
  record: OrderRecord,
  nowSeconds = Math.floor(Date.now() / 1_000),
): ReadCapability | undefined {
  const capability = record.readCapability;
  if (!capability) return undefined;
  // A capability about to expire is treated as expired: a read that starts
  // valid and finishes invalid is a worse failure than fetching a fresh one.
  return capability.expiresAt > nowSeconds + 15 ? capability : undefined;
}
