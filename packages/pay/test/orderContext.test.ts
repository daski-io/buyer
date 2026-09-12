/**
 * An order-bound context builds its signer lazily: a read served by a stored
 * capability never opens the key store, the signer is built on the first
 * signature, and it must be the payer on record. `order import` rebuilds the
 * store from the gateway's own history.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CliError } from "../src/cli/errors.js";
import { orderImport, readWithCapability, withOrder } from "../src/commands/order.js";
import { createContext, type CommandContext, type ContextOptions, type OrderBinding } from "../src/context.js";
import type { HostEnvironment } from "../src/host.js";
import { findByIntent, findOrder, listOrders, upsertOrder } from "../src/store/orders.js";

const code = (wanted: string) => (error: unknown): boolean => error instanceof CliError && error.code === wanted;
const ENV = ["DASKI_HOME", "DASKI_PAYER_PRIVATE_KEY"] as const;
const host: HostEnvironment = { platform: "linux", hostClass: "durable", declaredBackend: "file", passphraseFile: undefined, procKeysPath: "/nonexistent" };
const PAYER = "0x1111111111111111111111111111111111111111";
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);

async function withHome(run: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  const home = mkdtempSync(join(tmpdir(), "daski-order-context-"));
  for (const key of ENV) delete process.env[key];
  process.env.DASKI_HOME = home;
  try {
    await run();
  } finally {
    for (const key of ENV) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(home, { recursive: true, force: true });
  }
}

const now = new Date().toISOString();
const record = (intentId: string, handle: string | undefined, extra: Record<string, unknown> = {}) => ({
  intentId, handle, profile: "sandbox", providerAgentId: "1", outcomeId: "form", payer: PAYER, amount: "1000000",
  state: "FULFILLED" as const, createdAt: now, updatedAt: now, ...extra,
});

test("a stored read capability serves a read without the key store, and the signer is built only on first use", async () => {
  await withHome(async () => {
    // No key exists for the profile, yet the context is built and the read succeeds.
    const context = await createContext({ host }, { expectedPayer: PAYER });
    assert.equal(context.payerAddress, getAddress(PAYER));
    assert.throws(() => context.signer.describe(), code("DASKI_SIGNER_NOT_RESOLVED"));
    const reads: string[] = [];
    const served = { ...context, client: { hasTool: async () => true, callTool: async (name: string, args: Record<string, unknown>) => {
      reads.push(`${name}:${String(args.readCapability)}`);
      return { content: [], structuredContent: { state: "FULFILLED", served: true } };
    } } } as unknown as CommandContext;
    const stored = upsertOrder(record("intent", "handle", { readCapability: { token: "cap", expiresAt: Math.floor(Date.now() / 1000) + 600 } }));
    const body = await readWithCapability(served, stored, { toolName: "daski_get_order_status", action: "status", request: {} });
    assert.equal(body.served, true);
    assert.deepEqual(reads, ["daski_get_order_status:cap"]);
    await assert.rejects(context.signer.getAddress(), code("DASKI_NO_KEY_FOR_PROFILE"), "the key store is opened only for a signature");
    await context.close();
  });
});

test("the lazily built signer must be the payer on record", async () => {
  await withHome(async () => {
    process.env.DASKI_PAYER_PRIVATE_KEY = `0x${"11".repeat(32)}`;
    const other = await createContext({ host }, { expectedPayer: "0x2222222222222222222222222222222222222222" });
    await assert.rejects(other.resolveSigner(), code("DASKI_ORDER_PAYER_MISMATCH"));
    await other.close();
    const same = await createContext({ host }, { expectedPayer: account.address });
    assert.equal(await same.signer.getAddress(), account.address);
    assert.equal(same.signer.describe().accountType, "eoa");
    await same.close();
  });
});

test("withOrder resolves the record first and binds the context to its payer", async () => {
  await withHome(async () => {
    upsertOrder(record("intent", "handle"));
    const bindings: OrderBinding[] = [];
    const factory = async (_options: ContextOptions, binding: OrderBinding) => {
      bindings.push(binding);
      return { close: async () => {} } as unknown as CommandContext;
    };
    const seen = await withOrder({ handle: "handle", json: true, host }, async (_context, found) => found.intentId, factory);
    assert.equal(seen, "intent");
    assert.deepEqual(bindings, [{ expectedPayer: PAYER }]);
    await assert.rejects(withOrder({ handle: "missing", json: true, host }, async () => undefined, factory),
      (error: unknown) => code("DASKI_ORDER_NOT_FOUND")(error) && /order import/.test((error as CliError).remediation));
    assert.equal(bindings.length, 1, "no context is built for an unknown order");
  });
});

test("order import rehydrates the store from the payer's gateway history without disturbing existing records", async () => {
  await withHome(async () => {
    upsertOrder(record("int_existing", "ord_existing", { confirmationSubmission: { action: "confirmation",
      request: { phase: "submit", submission: "sponsored", preparationId: "p", signature: "0x" } } }));
    upsertOrder(record("int_no_handle", undefined, { state: "PENDING_RECONCILIATION" }));
    const requests: Record<string, unknown>[] = [];
    const pages: Record<string, unknown>[] = [
      { orders: [
        { orderHandle: "ord_existing", paymentIdentifier: "int_existing", providerAgentId: "1", outcomeId: "form", state: "FULFILLED", grossAmount: "1000000", createdAt: now },
        { orderHandle: "ord_recovered", paymentIdentifier: "int_no_handle", providerAgentId: "1", outcomeId: "form", state: "DISPATCHED", grossAmount: "1000000", createdAt: now },
        { orderHandle: "ord_new", paymentIdentifier: "int_new", providerAgentId: "8327", outcomeId: "create-mailbox", state: "FULFILLED", grossAmount: "9990000", createdAt: now },
      ], nextCursor: "page-2" },
      { orders: [
        { orderHandle: "ord_legacy", providerAgentId: "8327", outcomeId: "register-domain", state: "INPUT_REQUIRED", grossAmount: "5990000", createdAt: now },
      ], nextCursor: null },
    ];
    const context = { profileName: "sandbox", payerAddress: getAddress(PAYER), profile: { chainId: 84532, gatewayUrl: "https://g.example" },
      signer: { getAddress: async () => getAddress(PAYER), signTypedData: async () => { throw new Error("no signature expected"); }, describe: () => ({ provider: "local", accountType: "eoa" }) },
      client: { hasTool: async () => true, callTool: async (_name: string, args: Record<string, unknown>) => {
        requests.push(args);
        return { content: [], structuredContent: pages[requests.length - 1]! };
      } }, close: async () => {} } as unknown as CommandContext;
    const result = await orderImport({ json: true, host }, async () => context);
    assert.equal(result.listed, 4);
    assert.equal(result.added, 2);
    assert.equal(result.updated, 1);
    assert.equal(result.existing, 1);
    assert.deepEqual(requests.map((request) => request.cursor), [null, "page-2"]);
    assert.equal(findByIntent("int_existing")?.confirmationSubmission?.request.preparationId, "p", "existing state is untouched");
    assert.equal(findByIntent("int_no_handle")?.handle, "ord_recovered");
    assert.equal(findByIntent("int_no_handle")?.state, "SUBMITTED");
    assert.equal(findByIntent("int_new")?.amount, "9990000");
    assert.equal(findOrder("ord_legacy")?.intentId, "ord_legacy", "a row without an identifier is keyed by its handle");
    assert.equal(findOrder("ord_legacy")?.state, "INPUT_REQUIRED");
    assert.equal(listOrders("sandbox").length, 4);
  });
});

test("order import walks every page, returns a partial result with a resume cursor at the cap, and refuses a looping cursor", async () => {
  await withHome(async () => {
    const page = (cursor: string | null, id: string) => ({ orders: [
      { orderHandle: `ord_${id}`, paymentIdentifier: `int_${id}`, providerAgentId: "1", outcomeId: "form", state: "FULFILLED", grossAmount: "1", createdAt: now },
    ], nextCursor: cursor });
    const pages: Record<string, Record<string, unknown>> = {
      first: page("c1", "a"), c1: page("c2", "b"), c2: page("c3", "c"), c3: page(null, "d"),
    };
    const requests: Record<string, unknown>[] = [];
    const context = { profileName: "sandbox", payerAddress: getAddress(PAYER), profile: { chainId: 84532, gatewayUrl: "https://g.example" },
      signer: { getAddress: async () => getAddress(PAYER), signTypedData: async () => { throw new Error("no signature expected"); }, describe: () => ({ provider: "local", accountType: "eoa" }) },
      client: { hasTool: async () => true, callTool: async (_name: string, args: Record<string, unknown>) => {
        requests.push(args);
        const cursor = ((args.cursor as string | null | undefined) ?? "first");
        return { content: [], structuredContent: pages[cursor]! };
      } }, close: async () => {} } as unknown as CommandContext;
    // Two pages per command: the first run stops with a resume cursor; the resumed run finishes.
    const partial = await orderImport({ json: true, host }, async () => context, { maxPages: 2 });
    assert.equal(partial.imported, false);
    assert.equal(partial.partial, true);
    assert.equal(partial.resumeCursor, "c2");
    assert.equal(partial.added, 2);
    const rest = await orderImport({ json: true, host, cursor: partial.resumeCursor as string }, async () => context, { maxPages: 2 });
    assert.equal(rest.imported, true);
    assert.equal(rest.added, 2);
    assert.deepEqual(requests.map((request) => request.cursor), [null, "c1", "c2", "c3"]);
    assert.equal(listOrders("sandbox").length, 4);
    // A cursor that repeats is a history that does not advance, never a silent stop.
    pages.c3 = page("c1", "e");
    await assert.rejects(orderImport({ json: true, host }, async () => context, { maxPages: 50 }),
      (error: unknown) => error instanceof CliError && error.code === "DASKI_ORDER_HISTORY_LOOP");
  });
});
