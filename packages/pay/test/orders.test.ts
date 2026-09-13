/**
 * The order store is what makes multi-day orders survive the agent process
 * that placed them, and what makes an interrupted purchase reconcilable
 * instead of re-signable. Both properties are load-bearing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../src/cli/errors.js";
import * as store from "../src/store/orders.js";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** Each test gets its own DASKI_HOME; the store reads the env on every call. An async body keeps its home until it settles. */
function withHome<T>(run: () => T): T {
  const previous = process.env.DASKI_HOME;
  const home = mkdtempSync(join(tmpdir(), "daski-orders-"));
  process.env.DASKI_HOME = home;
  const cleanup = () => {
    if (previous === undefined) delete process.env.DASKI_HOME;
    else process.env.DASKI_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  };
  let result: T;
  try {
    result = run();
  } catch (error) {
    cleanup();
    throw error;
  }
  if (result instanceof Promise) return result.finally(cleanup) as T;
  cleanup();
  return result;
}

const BASE = {
  profile: "sandbox",
  providerAgentId: "8327",
  outcomeId: "create-mailbox",
  payer: "0x1111111111111111111111111111111111111111",
  amount: "9990000",
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
};

test("an order round-trips through a fresh process", async () => {
  await withHome(async () => {
    store.upsertOrder({ ...BASE, intentId: "intent-a", state: "SUBMITTED", handle: "ord_a" });
    // The store keeps no in-memory state: every read hits the file, so this is
    // the same path a fresh process takes with only the handle in hand.
    const found = store.findOrder("ord_a");
    assert.equal(found?.intentId, "intent-a");
    assert.equal(found?.state, "SUBMITTED");
  });
});

test("an order is findable by handle or by intent id", async () => {
  await withHome(async () => {
    store.upsertOrder({ ...BASE, intentId: "intent-b", state: "SUBMITTED", handle: "ord_b" });
    assert.equal(store.findOrder("ord_b")?.intentId, "intent-b");
    assert.equal(store.findOrder("intent-b")?.handle, "ord_b");
    assert.equal(store.findOrder("nope"), undefined);
  });
});

test("upsert is keyed on the intent id and preserves createdAt", async () => {
  await withHome(async () => {
    store.upsertOrder({ ...BASE, intentId: "intent-c", state: "INTENT_RECORDED" });
    store.updateOrder("intent-c", { state: "AUTHORIZED", handle: "ord_c" });
    const all = store.listOrders("sandbox");
    assert.equal(all.length, 1, "an update must not create a second record");
    assert.equal(all[0]!.state, "AUTHORIZED");
    assert.equal(all[0]!.createdAt, BASE.createdAt, "createdAt survives updates");
  });
});

test("the session total excludes intents that were never authorized", async () => {
  await withHome(async () => {
    store.upsertOrder({ ...BASE, intentId: "i-1", state: "SUBMITTED" });
    store.upsertOrder({ ...BASE, intentId: "i-2", state: "AUTHORIZED" });
    // Recorded before signing, never signed: it must not consume the cap.
    store.upsertOrder({ ...BASE, intentId: "i-3", state: "INTENT_RECORDED" });
    assert.equal(store.authorizedTotalAtomic("sandbox"), 19_980_000n);
  });
});

test("the session total is per profile, so sandbox cannot spend mainnet's cap", async () => {
  await withHome(async () => {
    store.upsertOrder({ ...BASE, intentId: "s-1", state: "SUBMITTED" });
    store.upsertOrder({ ...BASE, intentId: "m-1", state: "SUBMITTED", profile: "mainnet" });
    assert.equal(store.authorizedTotalAtomic("sandbox"), 9_990_000n);
    assert.equal(store.authorizedTotalAtomic("mainnet"), 9_990_000n);
  });
});

test("a capability about to expire is treated as already expired", async () => {
  await withHome(async () => {
    const now = 1_788_200_000;
    const record = {
      ...BASE, intentId: "i-cap", state: "SUBMITTED" as const,
      readCapability: { token: "cap-token", expiresAt: now + 5 },
    };
    // A read that starts valid and finishes invalid is a worse failure than
    // fetching a fresh capability.
    assert.equal(store.activeReadCapability(record, now), undefined);
    assert.equal(
      store.activeReadCapability({
        ...record, readCapability: { token: "cap-token", expiresAt: now + 600 },
      }, now)?.token,
      "cap-token",
    );
  });
});

test("an intent the gateway refused before settlement consumes no session budget and may be signed for again", () => {
  withHome(() => {
    store.upsertOrder({ ...BASE, intentId: "int_paid", state: "SUBMITTED", handle: "ord_paid" });
    store.upsertOrder({ ...BASE, intentId: "int_pending", state: "PENDING_RECONCILIATION" });
    store.upsertOrder({ ...BASE, intentId: "int_refused", state: "NOT_SETTLED" });
    store.upsertOrder({ ...BASE, intentId: "int_unsigned", state: "INTENT_RECORDED" });
    // Paid and pending count; a definitive refusal and an unsigned intent do not.
    assert.equal(store.authorizedTotalAtomic("sandbox"), 2n * BigInt(BASE.amount));
    assert.equal(store.isUnspent(store.findByIntent("int_refused")!), true);
    assert.equal(store.isUnspent(store.findByIntent("int_unsigned")!), true);
    assert.equal(store.isUnspent(store.findByIntent("int_pending")!), false);
    assert.equal(store.isUnspent(store.findByIntent("int_paid")!), false);
  });
});

test("updates to different orders from concurrent processes are never lost", async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { readFileSync } = await import("node:fs");
  await withHome(async () => {
    const home = process.env.DASKI_HOME!;
    const ids = ["one", "two", "three"];
    for (const id of ids) store.upsertOrder({ ...BASE, intentId: id, state: "SUBMITTED", handle: `ord_${id}` });
    const module = fileURLToPath(new URL("../src/store/orders.js", import.meta.url));
    const rounds = 25;
    // Each child updates only its own order, 25 times; the store holds every
    // order in one file, so without the store-wide lock a child's rename can
    // discard another child's update.
    const script = `const { updateOrder } = await import(${JSON.stringify(module)});
      const [id, rounds] = process.argv.slice(1);
      for (let i = 0; i < Number(rounds); i += 1) updateOrder(id, { amount: String(i), handle: "ord_" + id + "_" + i });`;
    const children = ids.map((id) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, "--", id, String(rounds)],
        { env: { ...process.env, DASKI_HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`child ${id} exited ${code}: ${stderr}`)));
    }));
    await Promise.all(children);
    const orders = (JSON.parse(readFileSync(join(home, "orders.json"), "utf8")) as { orders: store.OrderRecord[] }).orders;
    for (const id of ids) {
      const order = orders.find((candidate) => candidate.intentId === id);
      assert.equal(order?.amount, String(rounds - 1), `every update to ${id} survived`);
      assert.equal(order?.handle, `ord_${id}_${rounds - 1}`);
    }
    assert.equal(orders.length, ids.length);
  });
});

const unreadable = (path: string) => (error: unknown): boolean =>
  error instanceof CliError && error.code === "DASKI_ORDER_STORE_UNREADABLE" && error.remediation.includes(path);

test("a missing store is an empty ledger; an unreadable one refuses every read and write and is never overwritten", () => {
  withHome(() => {
    const home = process.env.DASKI_HOME!;
    const path = join(home, "orders.json");
    assert.deepEqual(store.listOrders(), []);
    assert.equal(store.findByIntent("a"), undefined);
    assert.equal(store.authorizedTotalAtomic("sandbox"), 0n);
    const refused = unreadable(path);
    const valid = JSON.stringify({ version: 1, orders: [{ ...BASE, intentId: "a", state: "SUBMITTED", handle: "ord_a" }] });
    for (const content of [
      valid.slice(0, valid.length - 20),                                    // truncated by a crash mid-write
      "{not json",
      "[]",
      JSON.stringify({ version: 2, orders: [] }),
      JSON.stringify({ version: 1, orders: {} }),
      JSON.stringify({ version: 1, orders: [{ intentId: "a" }] }),            // a record without its budget fields
      JSON.stringify({ version: 1, orders: [{ ...BASE, intentId: "a", state: "SUBMITTED", amount: "9.99" }] }),
    ]) {
      writeFileSync(path, content);
      assert.throws(() => store.listOrders(), refused, content);
      assert.throws(() => store.findOrder("ord_a"), refused, content);
      assert.throws(() => store.findByIntent("a"), refused, content);
      // The budget total surfaces the error rather than reporting zero.
      assert.throws(() => store.authorizedTotalAtomic("sandbox"), refused, content);
      assert.throws(() => store.upsertOrder({ ...BASE, intentId: "fresh", state: "SUBMITTED" }), refused, content);
      assert.throws(() => store.updateOrder("a", { state: "FULFILLED" }), refused, content);
      assert.equal(readFileSync(path, "utf8"), content, "the bytes are untouched");
      assert.deepEqual(readdirSync(home), ["orders.json"], "no temporary or lock file is left behind");
    }
  });
});

test("a permission-denied store refuses reads and writes", { skip: isRoot || process.platform === "win32" }, () => {
  withHome(() => {
    const home = process.env.DASKI_HOME!;
    const path = join(home, "orders.json");
    store.upsertOrder({ ...BASE, intentId: "kept", state: "SUBMITTED", handle: "ord_kept" });
    const before = readFileSync(path, "utf8");
    chmodSync(path, 0o000);
    try {
      assert.throws(() => store.listOrders(), unreadable(path));
      assert.throws(() => store.authorizedTotalAtomic("sandbox"), unreadable(path));
      assert.throws(() => store.upsertOrder({ ...BASE, intentId: "fresh", state: "SUBMITTED" }), unreadable(path));
      assert.throws(() => store.updateOrder("kept", { state: "FULFILLED" }), unreadable(path));
    } finally {
      chmodSync(path, 0o600);
    }
    assert.equal(readFileSync(path, "utf8"), before, "the previous store is byte-identical");
    assert.deepEqual(readdirSync(home), ["orders.json"]);
    assert.equal(store.findByIntent("kept")?.handle, "ord_kept");
  });
});

test("a write leaves only the store behind, owner-only", () => {
  withHome(() => {
    const home = process.env.DASKI_HOME!;
    store.upsertOrder({ ...BASE, intentId: "w-1", state: "SUBMITTED" });
    store.updateOrder("w-1", { handle: "ord_w" });
    assert.deepEqual(readdirSync(home), ["orders.json"], "the flushed temporary file was renamed into place");
    if (process.platform !== "win32") assert.equal(statSync(join(home, "orders.json")).mode & 0o777, 0o600);
  });
});
