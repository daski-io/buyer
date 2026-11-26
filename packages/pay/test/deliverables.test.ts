/**
 * `daski order deliverables`: after FULFILLED, everything the order
 * delivered, in one owner-only folder. The artifact read lists the
 * deliverables (the gateway's order-artifact-deliverables.json fixture); each
 * owner action runs through the same challenge, signature and retry as
 * `daski asset action`, for any signer; each result goes to its own mode-600
 * file; the manifest names files and field names, never a value. Running it
 * again recovers what the provider kept and runs the rest again.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHash } from "@daski/x402-scheme";
import { CliError } from "../src/cli/errors.js";
import { orderDeliverables } from "../src/commands/deliverables.js";
import { orderStatus, withDeliverablesNext } from "../src/commands/order.js";
import {
  deliverableKey, getWhatYouBought, orderFulfilled, readDeliverables, resultFieldNames, type OwnerActionDeliverable,
} from "../src/gateway/deliverables.js";
import { findOrder, upsertOrder } from "../src/store/orders.js";
import { ACCOUNT, fakeContext, fakeGateway, isolated, mcp, type Answer } from "./walletFakes.js";

type Json = Record<string, unknown>;

const HANDLE = "A".repeat(43);
const SECRET = "ak_live-secret-never-printed";
const EXECUTION = `0x${"ab".repeat(32)}`;
const PROVIDER_ORIGIN = "https://provider.example";
const ENV = ["DASKI_HOME", "DASKI_PAYER_PRIVATE_KEY"] as const;

function fixtureDirectory(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, "test", "fixtures", "gateway-wire");
    if (existsSync(join(candidate, "order-artifact-deliverables.json"))) return candidate;
    directory = dirname(directory);
  }
  throw new Error("gateway wire fixtures are missing");
}

/** The gateway's artifact answer, as the website's MCP server relays it: the task isolated as base64 JSON. */
function artifactAnswer(overrides: Json = {}): Json {
  const raw = JSON.parse(readFileSync(join(fixtureDirectory(), "order-artifact-deliverables.json"), "utf8")) as Json;
  const { result, ...envelope } = { ...raw, ...overrides };
  return { ...envelope, orderHandle: HANDLE, untrustedResult: isolated(result) };
}

const fixtureItems = () => (artifactAnswer().deliverables as Json[]).slice(1) as unknown as OwnerActionDeliverable[];

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  const home = mkdtempSync(join(tmpdir(), "daski-deliverables-"));
  for (const key of ENV) delete process.env[key];
  process.env.DASKI_HOME = home;
  try {
    const now = new Date().toISOString();
    upsertOrder({ intentId: "intent", handle: HANDLE, profile: "sandbox", providerAgentId: "8327", outcomeId: "create-api-account",
      payer: ACCOUNT.address, amount: "1000000", state: "FULFILLED", createdAt: now, updatedAt: now,
      readCapability: { token: "cap", expiresAt: Math.floor(Date.now() / 1000) + 600 } });
    await run(home);
  } finally {
    for (const key of ENV) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(home, { recursive: true, force: true });
  }
}

/** The perform answer as the MCP server relays it. */
function performed(args: Json, result: unknown, status = "completed", errorClass: string | null = null): Json {
  return {
    providerAgentId: args.providerAgentId, payer: ACCOUNT.address.toLowerCase(), actionExecutionId: EXECUTION, status,
    requestHash: canonicalHash({ actionId: args.actionId, providerAssetId: args.providerAssetId, input: args.input }),
    errorClass, untrustedResult: isolated(result),
  };
}

const keyResult = { keyId: "key_0001", apiKey: SECRET, keyPrefix: "ak_0001" };
const documentResult = (url = `${PROVIDER_ORIGIN}/documents/one-time-token`) => ({
  documentId: "00000000-0000-4000-8000-00000000d0c1", title: "Account agreement", type: "agreement",
  download: { url, method: "GET", mimeType: "application/pdf", expiresAt: "2026-11-26T12:15:00.000Z", singleUse: true },
});
const PDF = Buffer.from("%PDF-1.7 account agreement");

const ownerActions = [
  { actionId: "get-api-key", name: "Get API key", assetType: "api-account", destructive: false },
  { actionId: "rotate-api-key", name: "Rotate API key", assetType: "api-account", destructive: true },
  { actionId: "download-account-document", name: "Download a document", assetType: "api-account", destructive: false },
  { actionId: "delete-server", name: "Delete a server", assetType: "server", destructive: true },
];

/** The provider's answer per action, and a fetch serving the registry and the one-time link. */
function provider(options: { answers?: Record<string, Answer>; artifact?: () => unknown;
  link?: (init: RequestInit | undefined) => Response } = {}) {
  const fetched: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    if (url.includes("/public/v3/services?providerAgentId=8327")) {
      return Response.json({ services: [{ providerAgentId: "8327", serviceId: `0x${"1a".repeat(32)}`,
        agentCardUrl: `${PROVIDER_ORIGIN}/agent-cards/api-accounts.json`, service: { slug: "api-accounts" }, ownerActions }] });
    }
    if (url === `${PROVIDER_ORIGIN}/documents/one-time-token`) {
      inits.push(init);
      return options.link?.(init) ?? new Response(PDF, { headers: { "content-type": "application/pdf" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const gateway = fakeGateway({
    tools: ["daski_use_asset", "daski_get_order_artifact", "daski_get_order_status"],
    reads: { daski_get_order_artifact: options.artifact ?? (() => artifactAnswer()) },
    answers: { daski_use_asset: (args) => {
      const own = options.answers?.[String(args.actionId)];
      if (own) return own(args);
      return performed(args, args.actionId === "get-api-key" ? keyResult : documentResult());
    } },
  });
  return { ...gateway, fetched, inits, fetchImpl };
}

const signedUses = (calls: { tool: string; args: Json }[]) =>
  calls.filter((call) => call.tool === "daski_use_asset" && call.args.authorization);

test("the gateway's fixture reads as the artifact, then each owner action as the asset action's own arguments", () => {
  const read = readDeliverables(artifactAnswer(), "8327");
  assert.equal(read.listed, true);
  assert.equal(read.ignored, 0);
  assert.deepEqual(read.items[0], { kind: "artifact" });
  assert.deepEqual(read.items.slice(1), fixtureItems());
  // An owner action for another provider, a malformed one, an operation, a repeat: none of them runs.
  const [first] = fixtureItems();
  const odd = readDeliverables({ deliverables: [{ kind: "artifact" }, first, first, { ...first, providerAgentId: "10763" },
    { ...first, input: { operation: "recover-action" } }, { ...first, input: { nested: { a: 1 } } },
    { ...first, providerAssetId: "../../escape" }, { ...first, label: "API key‮" }, { ...first, extra: true }] }, "8327");
  assert.equal(odd.items.length, 2);
  assert.equal(odd.ignored, 7);
  // An older gateway lists nothing: the artifact is the whole order.
  assert.deepEqual(readDeliverables({}, "8327"), { items: [{ kind: "artifact" }], listed: false, ignored: 0 });
  // Field names come from the task's data parts, never the deliverables part.
  assert.deepEqual(resultFieldNames(JSON.parse(Buffer.from(String((artifactAnswer().untrustedResult as Json).content),
    "base64").toString("utf8"))), ["keyId", "environment", "keyPrefix"]);
});

test("it saves the artifact and each owner action's result, mode 600, and prints a manifest without a value", async () => {
  await withHome(async (home) => {
    const { client, calls, fetched, inits, fetchImpl } = provider();
    const manifest = await orderDeliverables({ handle: HANDLE, json: true }, async () => fakeContext(client), fetchImpl);
    const directory = join(home, "results", HANDLE);
    assert.equal(inits[0]?.redirect, "error", "a redirect is never followed");
    assert.equal(inits[0]?.method, "GET");
    assert.equal(manifest.complete, true);
    assert.equal(manifest.state, "delivered");
    assert.equal(manifest.outputDir, directory);
    const items = manifest.items as Json[];
    assert.deepEqual(items.map((item) => [item.kind, item.label, item.status, item.file]), [
      ["artifact", "Order artifact", "saved", join(directory, "00-artifact.json")],
      ["owner-action", "API key", "saved", join(directory, "01-get-api-key.json")],
      ["owner-action", "Account agreement (PDF)", "saved", join(directory, "02-download-account-document.json")],
    ]);
    assert.deepEqual(items[0]!.fields, ["keyId", "environment", "keyPrefix"]);
    assert.deepEqual(items[1]!.fields, ["keyId", "apiKey", "keyPrefix"]);
    assert.deepEqual(items[1]!.inputFields, ["keyId"]);
    assert.equal(items[1]!.recovered, false);
    // The single-use link is fetched at once, from the provider's own origin; the manifest names the file.
    assert.deepEqual(items[2]!.download, { file: join(directory, "02-download-account-document.pdf"),
      mediaType: "application/pdf", byteLength: PDF.byteLength });
    assert.deepEqual(readFileSync(join(directory, "02-download-account-document.pdf")), PDF);
    assert.ok(fetched.includes(`${PROVIDER_ORIGIN}/documents/one-time-token`));
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "01-get-api-key.json"), "utf8")), keyResult);
    const printed = JSON.stringify(manifest);
    assert.ok(!printed.includes(SECRET) && !printed.includes("one-time-token") && !printed.includes("key_0001"),
      "no secret, link or input value is printed");
    assert.match(String(manifest.next), /^Everything this order delivered is in /);
    assert.deepEqual(JSON.parse(readFileSync(String(manifest.manifestFile), "utf8")).items, items);
    if (process.platform !== "win32") {
      for (const file of ["00-artifact.json", "01-get-api-key.json", "02-download-account-document.json",
        "02-download-account-document.pdf", "manifest.json"]) {
        assert.equal(statSync(join(directory, file)).mode & 0o777, 0o600, file);
      }
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.equal(statSync(join(home, "results")).mode & 0o777, 0o700);
    }
    // Each owner action is exactly the listed call, under the CLI's own signature; the artifact read used the stored capability.
    const uses = signedUses(calls);
    assert.deepEqual(uses.map((call) => { const { authorization: _a, payer: _p, ...rest } = call.args; return rest; }),
      fixtureItems().map(({ providerAgentId, actionId, providerAssetId, input }) => ({ providerAgentId, actionId, providerAssetId, input })));
    assert.equal(calls[0]!.tool, "daski_get_order_artifact");
    assert.equal(calls[0]!.args.readCapability, "cap");
    assert.deepEqual(findOrder(HANDLE, "sandbox")?.deliverableExecutions,
      Object.fromEntries(fixtureItems().map((item) => [deliverableKey(item), EXECUTION])));
  });
});

test("--output-dir takes the files instead, and a folder that cannot be written is refused before anything is read", async () => {
  await withHome(async (home) => {
    const { client, fetchImpl } = provider();
    const target = join(home, "elsewhere", "order");
    const manifest = await orderDeliverables({ handle: HANDLE, json: true, outputDir: target }, async () => fakeContext(client), fetchImpl);
    assert.equal(manifest.outputDir, target);
    assert.ok(existsSync(join(target, "01-get-api-key.json")));
    const refused = provider();
    await assert.rejects(orderDeliverables({ handle: HANDLE, json: true, outputDir: join(target, "01-get-api-key.json") },
      async () => fakeContext(refused.client), refused.fetchImpl),
      (error: unknown) => error instanceof CliError && error.code === "DASKI_OUTPUT_UNWRITABLE");
    assert.equal(refused.calls.length, 0);
  });
});

test("running it again recovers each action's kept result, and runs an action again when the provider keeps none", async () => {
  await withHome(async () => {
    const first = provider();
    await orderDeliverables({ handle: HANDLE, json: true }, async () => fakeContext(first.client), first.fetchImpl);
    // The key's result is kept; the document's recovery is refused, so its action runs again.
    const again = provider({ answers: {
      "download-account-document": (args) => (args.input as Json).operation === "recover-action"
        ? mcp({ code: "ASSET_ACTION_REJECTED", message: "The wallet request could not be completed" }, true)
        : performed(args, documentResult()),
    } });
    const manifest = await orderDeliverables({ handle: HANDLE, json: true }, async () => fakeContext(again.client), again.fetchImpl);
    assert.equal(manifest.complete, true);
    const items = manifest.items as Json[];
    assert.equal(items[1]!.recovered, true);
    assert.equal(items[2]!.recovered, false);
    const uses = signedUses(again.calls);
    const [key, document] = fixtureItems();
    assert.deepEqual(uses.map((call) => [call.args.actionId, call.args.input]), [
      ["get-api-key", { operation: "recover-action", actionExecutionId: EXECUTION, originalInput: key!.input }],
      ["download-account-document", { operation: "recover-action", actionExecutionId: EXECUTION, originalInput: document!.input }],
      ["download-account-document", document!.input],
    ]);
  });
});

test("an order still being delivered is not complete and says to check again; nothing runs", async () => {
  await withHome(async () => {
    const errors = JSON.parse(readFileSync(join(fixtureDirectory(), "standard-rail-error.json"), "utf8")) as Record<string, { error: Json }>;
    const delivering = provider({ artifact: () => mcp(errors.artifactStillBeingDelivered!.error, true) });
    const manifest = await orderDeliverables({ handle: HANDLE, json: true }, async () => fakeContext(delivering.client),
      delivering.fetchImpl);
    assert.equal(manifest.complete, false);
    assert.equal(manifest.state, "delivering");
    assert.deepEqual(manifest.items, []);
    assert.match(String(manifest.next), new RegExp(`still being delivered; nothing failed.*daski order deliverables ${HANDLE} --json`));
    assert.equal(delivering.calls.filter((call) => call.tool === "daski_use_asset").length, 0);
    // An order that ended without a result is the gateway's refusal, with its own next step.
    const ended = provider({ artifact: () => mcp(errors.artifactNotAvailable!.error, true) });
    await assert.rejects(orderDeliverables({ handle: HANDLE, json: true }, async () => fakeContext(ended.client), ended.fetchImpl),
      (error: unknown) => error instanceof CliError && error.code === "ARTIFACT_NOT_AVAILABLE");
  });
});

test("a failed item is named with whether a retry is safe and what else the provider offers; the others are still saved", async () => {
  await withHome(async () => {
    const { client, fetchImpl } = provider({ answers: {
      "get-api-key": (args) => performed(args, null, "failed", "key_not_available"),
      "download-account-document": (args) => performed(args, null, "failed", "provider_retryable"),
    } });
    const manifest = await orderDeliverables({ handle: HANDLE, json: true }, async () => fakeContext(client), fetchImpl);
    assert.equal(manifest.complete, false);
    assert.equal(manifest.state, "incomplete");
    const items = manifest.items as Json[];
    assert.equal(items[0]!.status, "saved");
    assert.deepEqual(items.slice(1).map((item) => [item.label, item.status, item.retrySafe]),
      [["API key", "failed", false], ["Account agreement (PDF)", "failed", true]]);
    // The provider's other actions on the same kind of asset are named, a destructive one as such; none is run.
    assert.deepEqual(items[1]!.otherActions, [
      { actionId: "rotate-api-key", name: "Rotate API key", destructive: true },
      { actionId: "download-account-document", name: "Download a document", destructive: false },
    ]);
    assert.equal(items[2]!.otherActions, undefined, "a temporary failure names no alternative");
    assert.match(String(manifest.next), /may fetch Account agreement \(PDF\)/);
    // A gateway refusal marked retryable, or a lost connection, may succeed again; a rejection will not.
    const refused = provider({ answers: {
      "get-api-key": () => mcp({ code: "WALLET_RATE_LIMITED", message: "Too many" }, true),
      "download-account-document": () => mcp({ code: "ASSET_ACTION_REJECTED", message: "Rejected" }, true),
    } });
    const second = await orderDeliverables({ handle: HANDLE, json: true }, async () => fakeContext(refused.client), refused.fetchImpl);
    const failures = (second.items as Json[]).slice(1);
    assert.deepEqual(failures.map((item) => [(item.error as Json).code, item.retrySafe]),
      [["WALLET_RATE_LIMITED", true], ["ASSET_ACTION_REJECTED", false]]);
    assert.match(String((failures[1]!.error as Json).remediation), new RegExp(`daski order support ${HANDLE}`));
    assert.doesNotMatch(String((failures[1]!.error as Json).remediation), /--input|--asset/);
    const lost = provider({ answers: { "get-api-key": () => { throw new Error("socket hang up"); } } });
    const third = await orderDeliverables({ handle: HANDLE, json: true }, async () => fakeContext(lost.client), lost.fetchImpl);
    assert.deepEqual([((third.items as Json[])[1]!.error as Json).code, (third.items as Json[])[1]!.retrySafe],
      ["DASKI_DELIVERABLE_UNREACHABLE", true]);
  });
});

test("a result the provider answers with empty fields names them, and what else it offers", async () => {
  await withHome(async () => {
    // Past a secret's delivery window a provider can still answer completed, with the secret null.
    const { client, fetchImpl } = provider({ answers: {
      "get-api-key": (args) => performed(args, { ...keyResult, apiKey: null }),
    } });
    const manifest = await orderDeliverables({ handle: HANDLE, json: true }, async () => fakeContext(client), fetchImpl);
    const item = (manifest.items as Json[])[1]!;
    assert.equal(item.status, "saved");
    assert.deepEqual(item.emptyFields, ["apiKey"]);
    assert.deepEqual((item.otherActions as Json[]).map((action) => action.actionId), ["rotate-api-key", "download-account-document"]);
    assert.match(String(manifest.next), /Check emptyFields on API key/);
  });
});

test("a one-time link that cannot be saved says whether a fresh one may succeed", async () => {
  await withHome(async () => {
    for (const [label, link, code, retrySafe] of [
      ["a wrong content type", () => new Response("<html>", { headers: { "content-type": "text/html" } }), "DASKI_DOWNLOAD_FAILED", false],
      ["an expired link", () => Response.json({ error: "invalid_or_expired_token" }, { status: 403 }), "DASKI_DOWNLOAD_FAILED", true],
      ["an empty answer", () => new Response(new Uint8Array(0), { headers: { "content-type": "application/pdf" } }),
        "DASKI_DOWNLOAD_FAILED", true],
      ["a declared size over the limit", () => new Response(PDF, { headers: { "content-type": "application/pdf",
        "content-length": String(60 * 1024 * 1024) } }), "DASKI_DOWNLOAD_FAILED", false],
    ] as const) {
      const { client, fetchImpl } = provider({ link });
      const manifest = await orderDeliverables({ handle: HANDLE, json: true }, async () => fakeContext(client), fetchImpl);
      const item = (manifest.items as Json[])[2]!;
      assert.deepEqual([item.status, (item.error as Json).code, item.retrySafe], ["failed", code, retrySafe], label);
      assert.ok(!JSON.stringify(manifest).includes("one-time-token"), `${label}: the link is not printed`);
    }
  });
});

test("a one-time link off the provider's own origin, or not plain https, is not fetched", async () => {
  await withHome(async () => {
    for (const url of ["https://elsewhere.example/documents/one-time-token", "http://provider.example/documents/one-time-token",
      "https://user:pass@provider.example/documents/one-time-token"]) {
      const { client, fetchImpl, fetched } = provider({ answers: {
        "download-account-document": (args) => performed(args, documentResult(url)),
      } });
      const manifest = await orderDeliverables({ handle: HANDLE, json: true }, async () => fakeContext(client), fetchImpl);
      const item = (manifest.items as Json[])[2]!;
      assert.equal(item.status, "failed", url);
      assert.equal((item.error as Json).code, "DASKI_DOWNLOAD_REFUSED", url);
      assert.equal(item.retrySafe, false, url);
      assert.ok(!fetched.some((seen) => seen.includes("one-time-token")), `${url}: never fetched`);
    }
  });
});

test("any signer signs each action itself; a signer that cannot sign stops before anything is sent and keeps the artifact", async () => {
  await withHome(async (home) => {
    const { client, calls, fetchImpl } = provider();
    const circle = fakeContext(client);
    circle.signer.describe = () => ({ provider: "circle-agent", accountType: "contract", conformance: "verified" }) as never;
    const manifest = await orderDeliverables({ handle: HANDLE, json: true }, async () => circle, fetchImpl);
    assert.equal(manifest.complete, true);
    assert.equal(signedUses(calls).length, 2);

    const failing = provider();
    const broken = fakeContext(failing.client);
    broken.signer.describe = () => ({ provider: "circle-agent", accountType: "contract", conformance: "verified" }) as never;
    broken.signer.signTypedData = async () => { throw new CliError({ code: "DASKI_CIRCLE_AGENT_LOGIN_REQUIRED",
      message: "The Circle session expired.", remediation: "Log in with circle wallet login." }); };
    await assert.rejects(orderDeliverables({ handle: HANDLE, json: true }, async () => broken, failing.fetchImpl), (error: unknown) => {
      const failure = error as CliError;
      assert.equal(failure.code, "DASKI_CIRCLE_AGENT_LOGIN_REQUIRED");
      assert.match(failure.remediation, /Nothing was sent/);
      assert.deepEqual(failure.details.savedFiles, [join(home, "results", HANDLE, "00-artifact.json")]);
      return true;
    });
    assert.equal(signedUses(failing.calls).length, 0);
  });
});

test("an action that completed is recorded at once, so a run cut short later can still recover it", async () => {
  await withHome(async (home) => {
    const { client, calls, fetchImpl } = provider();
    const context = fakeContext(client);
    const sign = context.signer.signTypedData;
    let signatures = 0;
    context.signer.signTypedData = async (data) => {
      signatures += 1;
      if (signatures > 1) throw new CliError({ code: "DASKI_SIGNER_UNAVAILABLE", message: "gone", remediation: "Fix it." });
      return sign(data);
    };
    await assert.rejects(orderDeliverables({ handle: HANDLE, json: true }, async () => context, fetchImpl), (error: unknown) => {
      const files = (error as CliError).details.savedFiles as string[];
      assert.deepEqual(files, [join(home, "results", HANDLE, "00-artifact.json"), join(home, "results", HANDLE, "01-get-api-key.json")]);
      return true;
    });
    assert.equal(signedUses(calls).length, 1);
    const [key] = fixtureItems();
    assert.deepEqual(findOrder(HANDLE, "sandbox")?.deliverableExecutions, { [deliverableKey(key!)]: EXECUTION });
  });
});

test("an older gateway's artifact without deliverables is the whole order", async () => {
  await withHome(async () => {
    const { client, calls, fetchImpl } = provider({ artifact: () => { const { deliverables: _d, ...rest } = artifactAnswer(); return rest; } });
    const manifest = await orderDeliverables({ handle: HANDLE, json: true }, async () => fakeContext(client), fetchImpl);
    assert.equal(manifest.complete, true);
    assert.equal(manifest.deliverablesListed, false);
    assert.equal((manifest.items as Json[]).length, 1);
    assert.equal(calls.filter((call) => call.tool === "daski_use_asset").length, 0);
  });
});

test("order status and order confirm say to get what was bought, for any fulfilled order", async () => {
  await withHome(async () => {
    const answers: Json[] = [
      { orderState: "DISPATCHED", state: "working" },
      { orderState: "FULFILLED", state: "completed", fulfillmentState: "completed" },
    ];
    let read = 0;
    const client = { hasTool: async () => true, callTool: async () => ({ content: [], structuredContent: answers[read++] }) };
    const working = await orderStatus({ handle: HANDLE, json: true }, async () => fakeContext(client));
    assert.equal(working.next, undefined);
    assert.equal(withDeliverablesNext({ state: "final" }, { handle: HANDLE }).next, undefined, "not fulfilled yet");
    const done = await orderStatus({ handle: HANDLE, json: true }, async () => fakeContext(client));
    assert.equal(done.next, `Get what you bought: daski order deliverables ${HANDLE} --json`);
    assert.equal(findOrder(HANDLE, "sandbox")?.fulfilled, true, "kept for order confirm");

    assert.equal(withDeliverablesNext({ state: "final" }, { handle: HANDLE }).next, getWhatYouBought(HANDLE));
    assert.equal(withDeliverablesNext({ state: "pending", next: "Run daski order confirm x --resume." }, { handle: HANDLE }).next,
      `Run daski order confirm x --resume. Get what you bought: daski order deliverables ${HANDLE} --json`);
    assert.equal(withDeliverablesNext({ state: "final" }, { handle: HANDLE, revoke: true }).next, undefined);
    // Completed after recovery counts as fulfilled.
    assert.equal(orderFulfilled({ orderState: "PROVIDER_FAILED", fulfillmentState: "recovered" }), true);
    assert.equal(orderFulfilled({ orderState: "DISPATCHED", fulfillmentState: "working" }), false);
  });
});
