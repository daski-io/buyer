/**
 * The order store is what makes multi-day orders survive the agent process
 * that placed them, and what makes an interrupted purchase reconcilable
 * instead of re-signable. Both properties are load-bearing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as store from "../src/store/orders.js";

/** Each test gets its own DASKI_HOME; the store reads the env on every call. */
function withHome<T>(run: () => T): T {
  const previous = process.env.DASKI_HOME;
  const home = mkdtempSync(join(tmpdir(), "daski-orders-"));
  process.env.DASKI_HOME = home;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.DASKI_HOME;
    else process.env.DASKI_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
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
