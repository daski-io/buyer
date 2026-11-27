import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../src/cli/errors.js";
import { providerValues, runRequirements } from "../src/commands/requirements.js";

async function withHome(run: (home: string) => Promise<void>) {
  const before = process.env.DASKI_HOME;
  const home = mkdtempSync(join(tmpdir(), "daski-requirements-"));
  process.env.DASKI_HOME = home;
  try { await run(home); } finally {
    if (before === undefined) delete process.env.DASKI_HOME; else process.env.DASKI_HOME = before;
    rmSync(home, { recursive: true, force: true });
  }
}

/** A gateway whose requirements tool answers `body`, recording what it was asked. */
function gateway(body: Record<string, unknown>, isError = false) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let closed = false;
  return {
    calls, closed: () => closed,
    factory: () => ({
      callTool: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { content: [], structuredContent: body, ...(isError ? { isError: true } : {}) };
      },
      close: async () => { closed = true; },
    }),
  };
}

test("fills in the provider's values and lists only what the user must still add", async () => {
  await withHome(async (home) => {
    const file = join(home, "server.json");
    writeFileSync(file, JSON.stringify({ vcpu: 2, ramGiB: 1, storageGiB: 16, hours: 1 }));
    const g = gateway({
      requiredFields: { planId: { required: true, value: "hc2-0123456789abcdef.burst-2x1.16", totalPrice: "0.21" } },
      selectorsRequired: [],
      fieldErrors: [
        { path: "planId", rule: "required", message: "Field 'planId' is required." },
        { path: "sshPublicKey", rule: "required", message: "Field 'sshPublicKey' is required." },
      ],
      supported: true,
    });
    const answer = await runRequirements({ json: true, providerAgentId: "8327", outcomeId: "create-server", requestFile: file },
      g.factory);
    assert.deepEqual(g.calls, [{ name: "daski_get_outcome_requirements",
      args: { providerAgentId: "8327", outcomeId: "create-server", request: { vcpu: 2, ramGiB: 1, storageGiB: 16, hours: 1 } } }]);
    assert.equal(g.closed(), true);
    assert.equal(answer.complete, false);
    assert.deepEqual(answer.fieldErrors, [{ path: "sshPublicKey", rule: "required", message: "Field 'sshPublicKey' is required." }]);
    assert.deepEqual(answer.nextRequest,
      { vcpu: 2, ramGiB: 1, storageGiB: 16, hours: 1, planId: "hc2-0123456789abcdef.burst-2x1.16" });
    assert.match(String(answer.next), /Fix each fieldErrors entry/);
  });
});

test("an empty request asks for the selectors first; a complete one names daski buy", async () => {
  await withHome(async () => {
    const selectors = await runRequirements({ json: true, providerAgentId: "8327", outcomeId: "create-server" },
      gateway({ requiredFields: {}, selectorsRequired: ["vcpu", "hours"], fieldErrors: [] }).factory);
    assert.equal(selectors.complete, false);
    assert.match(String(selectors.next), /^Add vcpu, hours to the request/);
    const inference = await runRequirements({ json: true, providerAgentId: "8327", outcomeId: "create-inference-account" },
      gateway({
        requiredFields: { acceptTerms: { required: true, value: "2026-11-09" }, creditUsd: { required: true, minUsd: "1" } },
        selectorsRequired: [],
        fieldErrors: [{ path: "acceptTerms", rule: "required", message: "Field 'acceptTerms' is required." }],
      }).factory);
    // acceptTerms is the provider's to fill; creditUsd has no value, so it is not invented.
    assert.equal(inference.complete, true);
    assert.deepEqual(inference.nextRequest, { acceptTerms: "2026-11-09" });
    assert.match(String(inference.next), /daski buy --provider 8327 --outcome create-inference-account --request/);
  });
});

test("a refusal carries the gateway's code and next action; bad ids are refused before any call", async () => {
  await withHome(async () => {
    const g = gateway({ code: "OUTCOME_NOT_FOUND", message: "No such outcome", next_action: "Refresh discovery." }, true);
    await assert.rejects(runRequirements({ json: true, providerAgentId: "8327", outcomeId: "nope" }, g.factory),
      (error: unknown) => error instanceof CliError && error.code === "OUTCOME_NOT_FOUND" && error.remediation === "Refresh discovery.");
    const unused = gateway({});
    await assert.rejects(runRequirements({ json: true, providerAgentId: "abc", outcomeId: "create-server" }, unused.factory),
      (error: unknown) => error instanceof CliError && error.code === "DASKI_FLAG_INVALID");
    assert.equal(unused.calls.length, 0);
  });
});

test("provider values are the required fields that carry one", () => {
  assert.deepEqual(providerValues({ a: { value: 1 }, b: { required: true }, c: { value: null }, d: "x" }), { a: 1 });
  assert.deepEqual(providerValues(null), {});
});
