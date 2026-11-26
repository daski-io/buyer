/**
 * After FULFILLED: an order whose result is behind one of its provider's
 * owner actions names the command that gets it, in `order status` and in
 * `order confirm`. Whether it is such an order is read from the gateway's
 * outcome detail, its public service registry and the order's own result,
 * never from a provider id.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orderStatus, withResultNext } from "../src/commands/order.js";
import { decodeOrderResult, orderComplete, resultStep } from "../src/gateway/resultStep.js";
import type { OutcomeSummary } from "../src/gateway/catalog.js";
import type { PublicService } from "../src/gateway/services.js";
import { findOrder, upsertOrder } from "../src/store/orders.js";
import { ACCOUNT, fakeContext, isolated } from "./walletFakes.js";

const SERVICE_ID = `0x${"1a".repeat(32)}`;
const inference: PublicService = {
  providerAgentId: "8327", serviceId: SERVICE_ID, slug: "ai-inference", agentCardUrl: null,
  skills: [{ skillId: "create-inference-account", assetType: "inference-account", paymentRequired: true,
    requiresAssetOwnership: false, name: null, description: null, documentationUrl: null }],
  ownerActions: [
    { actionId: "rotate-inference-key", name: "Rotate", description: null, assetType: "inference-account", destructive: true },
    { actionId: "get-inference-usage", name: "Usage", description: null, assetType: "inference-account", destructive: false },
    { actionId: "get-inference-key", name: "Get Inference Key", description: null, assetType: "inference-account", destructive: false },
  ],
  freeSkills: [],
};
const outcome = (extra: Partial<OutcomeSummary> = {}) => ({
  providerAgentId: "8327", outcomeId: "create-inference-account", skillId: "create-inference-account", serviceId: SERVICE_ID,
  persistentAsset: true, ...extra,
}) as OutcomeSummary;
const created = { keyId: "inf_0123456789abcdef01234567", inferenceOrigin: "https://inference.example",
  next: "Call get-inference-key with this keyId to receive the API key secret, then call the inferenceOrigin directly." };
const fulfilled = (result: unknown, extra: Record<string, unknown> = {}) =>
  ({ orderState: "FULFILLED", state: "completed", fulfillmentState: "completed", untrustedResult: isolated(result), ...extra });

function sources(service: PublicService = inference, summary: OutcomeSummary = outcome()) {
  const lookups: string[] = [];
  return {
    lookups,
    catalog: { getOutcome: async (provider: string, id: string, options?: { refresh?: boolean }) => {
      lookups.push(`outcome:${provider}/${id}${options?.refresh ? ":refresh" : ""}`); return summary; } },
    services: { byId: async (id: string) => { lookups.push(`service:${id}`); return service; } },
  };
}

const step = (body: Record<string, unknown>, from = sources()) =>
  resultStep({ ...from, providerAgentId: "8327", outcomeId: "create-inference-account", handle: "ord_1", body });

test("a fulfilled order whose result names a non-destructive owner action of its asset gets that action's command", async () => {
  const found = await step(fulfilled(created));
  assert.equal(found?.actionId, "get-inference-key");
  assert.equal(found?.command, "daski asset action --order ord_1 --action get-inference-key --json");
  assert.match(String(found?.next), /^The order is fulfilled, and its result points to the provider's owner action get-inference-key /);
  // Several named: the one the result names first.
  const both = { ...created, next: "Call get-inference-usage later; first call get-inference-key." };
  assert.equal((await step(fulfilled({ keyId: created.keyId, next: both.next })))?.actionId, "get-inference-usage");
  assert.equal((await step(fulfilled({ keyId: created.keyId, next: "Call get-inference-key, then get-inference-usage." })))?.actionId,
    "get-inference-key");
  // The A2A task envelope a provider may sign is searched the same way.
  const task = { id: "t", status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{ name: "inference_key_created",
    parts: [{ kind: "data", data: created }] }] };
  assert.equal((await step(fulfilled(task)))?.actionId, "get-inference-key");
  // Completed after recovery counts too.
  assert.equal((await step(fulfilled(created, { orderState: "PROVIDER_FAILED", fulfillmentState: "recovered" })))?.actionId,
    "get-inference-key");
});

test("no step when the result is in the order itself, the order is not done, or the outcome leaves no asset", async () => {
  // A server's result carries the server and names none of its actions.
  const server: PublicService = { ...inference, slug: "server-hosting", skills: [{ ...inference.skills[0]!, skillId: "create-server", assetType: "server" }],
    ownerActions: [{ actionId: "get-server", name: "Get Server", description: null, assetType: "server", destructive: false }] };
  const serverOrder = resultStep({ ...sources(server, outcome({ outcomeId: "create-server", skillId: "create-server" })),
    providerAgentId: "8327", outcomeId: "create-server", handle: "ord_2",
    body: fulfilled({ serverId: "srv_1", assetId: "8d42e3f9-1111-4222-8333-944455556666", access: { ipv4: "192.0.2.1" } }) });
  assert.equal(await serverOrder, undefined);

  const quiet = sources();
  assert.equal(await step({ orderState: "DISPATCHED", state: "working", untrustedResult: isolated(created) }, quiet), undefined);
  assert.deepEqual(quiet.lookups, [], "an order that is not done costs no lookups");
  assert.equal(await step(fulfilled(created), sources(inference, outcome({ persistentAsset: false }))), undefined);
  // A destructive action named in the result is never the next step.
  assert.equal(await step(fulfilled({ keyId: "inf_1", next: "If it leaked, use rotate-inference-key." })), undefined);
  // An action of another asset type is not this order's.
  const other: PublicService = { ...inference, ownerActions: [{ ...inference.ownerActions[2]!, assetType: "mailbox" }] };
  assert.equal(await step(fulfilled(created), sources(other)), undefined);
  // An action id the gateway would not admit is never printed as a command.
  const unsafe: PublicService = { ...inference, ownerActions: [{ ...inference.ownerActions[2]!, actionId: "get-key;rm -rf ~" }] };
  assert.equal(await step(fulfilled({ next: "Call get-key;rm -rf ~ now." }), sources(unsafe)), undefined);
  // A failing lookup leaves the read as it was.
  const failing = { catalog: { getOutcome: async () => { throw new Error("offline"); } }, services: sources().services };
  assert.equal(await step(fulfilled(created), failing as never), undefined);
});

test("a cached outcome from before these fields is read again once", async () => {
  const lookups: string[] = [];
  const catalog = { getOutcome: async (_p: string, _o: string, options?: { refresh?: boolean }) => {
    lookups.push(options?.refresh ? "refresh" : "cached");
    return (options?.refresh ? outcome() : { providerAgentId: "8327", outcomeId: "create-inference-account" }) as OutcomeSummary;
  } };
  assert.equal((await resultStep({ catalog, services: sources().services, providerAgentId: "8327",
    outcomeId: "create-inference-account", handle: "ord_1", body: fulfilled(created) }))?.actionId, "get-inference-key");
  assert.deepEqual(lookups, ["cached", "refresh"]);
});

test("the order's result is read from the MCP server's isolation or the gateway's own field", () => {
  assert.deepEqual(decodeOrderResult({ untrustedResult: isolated(created) }), created);
  assert.deepEqual(decodeOrderResult({ result: created }), created);
  assert.equal(decodeOrderResult({ untrustedResult: { contentEncoding: "base64", content: "%%%" } }), undefined);
  assert.equal(orderComplete({ orderState: "FULFILLED" }), true);
  assert.equal(orderComplete({ orderState: "DISPATCHED", fulfillmentState: "working" }), false);
});

test("order status names the step, and order confirm names it after its own next step", async () => {
  const previousHome = process.env.DASKI_HOME;
  const home = mkdtempSync(join(tmpdir(), "daski-result-step-"));
  process.env.DASKI_HOME = home;
  try {
    const now = new Date().toISOString();
    upsertOrder({ intentId: "intent", handle: "ord_1", profile: "sandbox", providerAgentId: "8327",
      outcomeId: "create-inference-account", payer: ACCOUNT.address, amount: "1000000", state: "SUBMITTED", createdAt: now,
      updatedAt: now, readCapability: { token: "cap", expiresAt: Math.floor(Date.now() / 1000) + 600 } });
    const from = sources();
    const client = { hasTool: async () => true, callTool: async () => ({ content: [], structuredContent: fulfilled(created) }) };
    const printed = await orderStatus({ handle: "ord_1", json: true }, async () => fakeContext(client, { catalog: from.catalog }),
      from.services);
    assert.equal(printed.state, "FULFILLED");
    assert.deepEqual(printed.resultStep, { actionId: "get-inference-key", name: "Get Inference Key",
      command: "daski asset action --order ord_1 --action get-inference-key --json" });
    assert.match(String(printed.next), /daski asset action --order ord_1 --action get-inference-key --json/);
    assert.equal(findOrder("ord_1", "sandbox")?.resultStep?.actionId, "get-inference-key", "kept for order confirm");

    const confirmed = withResultNext({ orderHandle: "ord_1", mode: "sponsored", state: "final" }, { handle: "ord_1" });
    assert.match(String(confirmed.next), /^The order is fulfilled, and its result points to/);
    const pending = withResultNext({ state: "pending", next: "Run daski order confirm ord_1 --resume." }, { handle: "ord_1" });
    assert.equal(pending.next, "Run daski order confirm ord_1 --resume. Then get the order's result: " +
      "daski asset action --order ord_1 --action get-inference-key --json");
    assert.deepEqual(withResultNext({ state: "final" }, { handle: "ord_1", revoke: true }), { state: "final" });
    assert.deepEqual(withResultNext({ state: "final" }, { handle: "unknown" }), { state: "final" });
  } finally {
    if (previousHome === undefined) delete process.env.DASKI_HOME; else process.env.DASKI_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
