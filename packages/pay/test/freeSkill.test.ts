/**
 * `daski free-skill` calls a provider's public free skill with the one
 * request shape the provider accepts: JSON-RPC `SendMessage`, header
 * `A2A-Version: 1.0`, the input as a data part and the skill id in the Daski
 * extension's metadata. The service and its endpoint are resolved through
 * the gateway's public service registry and the service's agent card.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../src/cli/errors.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { DASKI_A2A_EXTENSION, runFreeSkill, selectFreeSkill } from "../src/commands/freeSkill.js";
import type { PublicService } from "../src/gateway/services.js";

const code = (wanted: string) => (error: unknown): boolean => error instanceof CliError && error.code === wanted;
const GATEWAY = DEFAULT_CONFIG.profiles.sandbox!.gatewayUrl;
const ORIGIN = "https://provider.example";

const service = (slug: string, extra: Record<string, unknown> = {}) => ({
  providerAgentId: "8327", serviceId: `0x${slug.length.toString(16).padStart(2, "0").repeat(32)}`,
  agentCardUrl: `${ORIGIN}/agent-cards/${slug}.json`, service: { slug }, skills: [], ownerActions: [], freeSkills: [], ...extra,
});
const registry = { services: [
  service("ai-inference", { freeSkills: [{ skillId: "get-inference-pricing", name: "Get Inference Pricing", description: "Prices",
    documentationUrl: `${ORIGIN}/skills/ai-inference/get-inference-pricing.md` }] }),
  service("server-hosting", { freeSkills: [{ skillId: "get-pricing", name: "Get Server Pricing", description: "Preview",
    documentationUrl: `${ORIGIN}/skills/server-hosting/get-pricing.md` }] }),
  service("mailboxes", { skills: [
    { skillId: "get-pricing", contract: { paymentRequired: false, requiresAssetOwnership: false, assetType: null }, presentation: { name: "Pricing" } },
    { skillId: "create-mailbox", contract: { paymentRequired: true, requiresAssetOwnership: false, assetType: null } },
    { skillId: "change-password", contract: { paymentRequired: false, requiresAssetOwnership: true, assetType: "mailbox" } },
  ] }),
  service("hosted-elsewhere", { providerAgentId: "10763" }),
] };
const card = (slug: string) => ({ name: slug, supportedInterfaces: [{ url: `${ORIGIN}/a2a/${slug}`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }] });
const task = (state: string, data: unknown, id = "task-1") => ({
  id, status: { state, message: { role: "ROLE_AGENT", parts: [{ kind: "text", text: "Here is the price." }] } },
  artifacts: [
    { artifactId: "a1", name: "pricing_quote", parts: [{ kind: "data", data }] },
    { artifactId: `anonymous_task_access-${id}`, name: "anonymous_task_access", parts: [{ kind: "data", data: { taskAccessToken: "t".repeat(43) } }] },
  ],
});

interface Sent { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | undefined }

function fakeFetch(answers: (body: Record<string, unknown>) => unknown, cards: Record<string, unknown> = {}) {
  const sent: Sent[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    sent.push({ url, method: init?.method ?? "GET", headers, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith(`${GATEWAY}/public/v3/services?providerAgentId=`)) {
      const provider = new URL(url).searchParams.get("providerAgentId");
      return json({ services: registry.services.filter((item) => item.providerAgentId === provider) });
    }
    const slug = /\/agent-cards\/([a-z-]+)\.json$/.exec(url)?.[1];
    if (slug) return json(cards[slug] ?? card(slug));
    if (url.startsWith(`${ORIGIN}/a2a/`)) return json(answers(body!));
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
  return { impl, sent };
}

async function withHome(run: () => Promise<void>): Promise<void> {
  const previous = process.env.DASKI_HOME;
  const home = mkdtempSync(join(tmpdir(), "daski-free-skill-"));
  process.env.DASKI_HOME = home;
  try { await run(); } finally {
    if (previous === undefined) delete process.env.DASKI_HOME; else process.env.DASKI_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test("the request is the one shape the provider accepts, sent to the service's JSON-RPC endpoint", async () => {
  await withHome(async () => {
    const quote = { vcpu: 2, ramGiB: 4, hourlyRateUsd: "0.02" };
    const { impl, sent } = fakeFetch((body) => ({ jsonrpc: "2.0", id: body.id, result: task("TASK_STATE_COMPLETED", quote) }));
    const input = { vcpu: 2, ramGiB: 4, storageGiB: 32, hours: 1 };
    const printed = await runFreeSkill({ json: true, providerAgentId: "8327", skillId: "get-pricing", service: "server-hosting",
      input, fetch: impl });
    assert.equal(printed.endpoint, `${ORIGIN}/a2a/server-hosting`);
    assert.equal(printed.state, "completed");
    assert.deepEqual(printed.result, quote, "the data part, without the anonymous access token");
    assert.equal(printed.message, "Here is the price.");
    assert.ok(!JSON.stringify(printed).includes("t".repeat(43)));

    const call = sent.find((item) => item.method === "POST")!;
    assert.equal(call.headers["A2A-Version"], "1.0");
    assert.equal(call.headers["content-type"], "application/json");
    assert.equal(call.body!.jsonrpc, "2.0");
    assert.equal(call.body!.method, "SendMessage");
    const message = (call.body!.params as { message: Record<string, unknown> }).message;
    assert.deepEqual(message.parts, [{ kind: "data", data: input }]);
    assert.deepEqual(message.metadata, { [DASKI_A2A_EXTENSION]: { skillId: "get-pricing" } });
    assert.equal(message.role, "ROLE_USER");
    assert.equal(typeof message.messageId, "string");
    assert.deepEqual(sent.map((item) => item.method), ["GET", "GET", "POST"], "registry, agent card, the call; nothing signed");
  });
});

test("the service is found from the provider's free skills; a skill offered twice needs --service", async () => {
  await withHome(async () => {
    const { impl } = fakeFetch((body) => ({ jsonrpc: "2.0", id: body.id, result: task("TASK_STATE_COMPLETED", { ok: true }) }));
    const printed = await runFreeSkill({ json: true, providerAgentId: "8327", skillId: "get-inference-pricing", fetch: impl });
    assert.equal(printed.service, "ai-inference");
    await assert.rejects(runFreeSkill({ json: true, providerAgentId: "8327", skillId: "get-pricing", fetch: impl }),
      (error: unknown) => code("DASKI_FREE_SKILL_AMBIGUOUS")(error) &&
        /--service <slug>, one of server-hosting, mailboxes/.test((error as CliError).remediation));
    // A free listing that needs no asset is served the same way; one that needs an asset or payment is not free.
    assert.equal((await runFreeSkill({ json: true, providerAgentId: "8327", skillId: "get-pricing", service: "mailboxes", fetch: impl })).service,
      "mailboxes");
    for (const skillId of ["create-mailbox", "change-password", "get-inference-key"]) {
      await assert.rejects(runFreeSkill({ json: true, providerAgentId: "8327", skillId, fetch: impl }),
        (error: unknown) => code("DASKI_FREE_SKILL_NOT_FOUND")(error) &&
          JSON.stringify((error as CliError).details.available).includes("get-inference-pricing"), skillId);
    }
  });
});

test("a refusal, a failed task and an endpoint that is not https are reported, and a working task is polled", async () => {
  await withHome(async () => {
    const refusing = fakeFetch((body) => ({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "Missing required fields: hours" } }));
    await assert.rejects(runFreeSkill({ json: true, providerAgentId: "8327", skillId: "get-pricing", service: "server-hosting", fetch: refusing.impl }),
      (error: unknown) => code("DASKI_FREE_SKILL_REFUSED")(error) && /hours/.test((error as CliError).message) &&
        (error as CliError).remediation.includes(`${ORIGIN}/skills/server-hosting/get-pricing.md`));

    const failing = fakeFetch((body) => ({ jsonrpc: "2.0", id: body.id, result: task("TASK_STATE_FAILED", {}) }));
    await assert.rejects(runFreeSkill({ json: true, providerAgentId: "8327", skillId: "get-pricing", service: "server-hosting", fetch: failing.impl }),
      code("DASKI_FREE_SKILL_FAILED"));

    const plain = fakeFetch(() => ({}), { "server-hosting": { supportedInterfaces: [{ url: "http://provider.example/a2a/x", protocolBinding: "JSONRPC" }] } });
    await assert.rejects(runFreeSkill({ json: true, providerAgentId: "8327", skillId: "get-pricing", service: "server-hosting", fetch: plain.impl }),
      code("DASKI_FREE_SKILL_NO_ENDPOINT"));
    assert.equal(plain.sent.some((item) => item.method === "POST"), false, "nothing is sent to a plain-http endpoint");

    let polls = 0;
    const slow = fakeFetch((body) => {
      if (body.method === "SendMessage") return { jsonrpc: "2.0", id: body.id, result: task("TASK_STATE_WORKING", {}) };
      polls += 1;
      assert.deepEqual(body.params, { id: "task-1", taskAccessToken: "t".repeat(43) });
      return { jsonrpc: "2.0", id: body.id, result: task(polls < 2 ? "TASK_STATE_WORKING" : "TASK_STATE_COMPLETED", { done: true }) };
    });
    const printed = await runFreeSkill({ json: true, providerAgentId: "8327", skillId: "get-pricing", service: "server-hosting",
      fetch: slow.impl, pollMs: 1 });
    assert.equal(printed.state, "completed");
    assert.deepEqual(printed.result, { done: true });
    assert.equal(polls, 2);
  });
});

test("--output writes the answer to a mode-600 file instead of printing it", async () => {
  await withHome(async () => {
    const dir = mkdtempSync(join(tmpdir(), "daski-free-skill-out-"));
    try {
      const { impl } = fakeFetch((body) => ({ jsonrpc: "2.0", id: body.id, result: task("TASK_STATE_COMPLETED", { price: "1" }) }));
      const output = join(dir, "pricing.json");
      const printed = await runFreeSkill({ json: true, providerAgentId: "8327", skillId: "get-pricing", service: "server-hosting",
        fetch: impl, output });
      assert.equal(printed.resultWrittenTo, output);
      assert.equal("result" in printed, false);
      assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { price: "1" });
      if (process.platform !== "win32") assert.equal(statSync(output).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("ids are checked before anything is fetched", async () => {
  const unreachable = (async () => { throw new Error("nothing may be fetched"); }) as unknown as typeof fetch;
  await assert.rejects(runFreeSkill({ json: true, providerAgentId: "abc", skillId: "get-pricing", fetch: unreachable }),
    code("DASKI_PROVIDER_ID_INVALID"));
  await assert.rejects(runFreeSkill({ json: true, providerAgentId: "8327", skillId: "Get Pricing", fetch: unreachable }),
    code("DASKI_FREE_SKILL_ID_INVALID"));
  const services = registry.services.slice(0, 2).map((item) => ({ ...item, serviceId: item.serviceId, slug: item.service.slug,
    skills: [], ownerActions: [], freeSkills: item.freeSkills })) as unknown as PublicService[];
  assert.equal(selectFreeSkill(services, "8327", "get-pricing").service.slug, "server-hosting");
});
