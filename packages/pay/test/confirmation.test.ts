import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import { canonicalHash, type TypedDataRequest } from "@daski/x402-scheme";
import { confirmOrder, validateConfirmationPreparation, type ConfirmationFacts } from "../src/commands/confirmation.js";
import { readWithCapability } from "../src/commands/order.js";
import type { CommandContext } from "../src/context.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { findByIntent, upsertOrder } from "../src/store/orders.js";
import { CliError } from "../src/cli/errors.js";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const facts: ConfirmationFacts = { chainId: 84532, eas: "0x2222222222222222222222222222222222222222",
  schemaUid: canonicalHash("schema"), orderKey: canonicalHash("order"), recipient: account.address,
  currentUid: canonicalHash("previous review"), nonce: "4", transitionsUsed: 1 };
function preparation() {
  const now = Math.floor(Date.now() / 1000);
  return { preparationId: "preparation-fixture", orderKey: facts.orderKey, currentRefUid: facts.currentUid, transitionsUsed: 1,
    signableTypedData: { domain: { name: "EAS", version: "1.2.0", chainId: facts.chainId, verifyingContract: facts.eas },
      primaryType: "Attest", types: { Attest: [
        { name: "schema", type: "bytes32" }, { name: "recipient", type: "address" }, { name: "expirationTime", type: "uint64" },
        { name: "revocable", type: "bool" }, { name: "refUID", type: "bytes32" }, { name: "data", type: "bytes" },
        { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" },
      ] }, message: { schema: facts.schemaUid, recipient: facts.recipient, expirationTime: "0", revocable: true,
        refUID: facts.currentUid, value: "0", nonce: facts.nonce, deadline: String(now + 300),
        data: encodeAbiParameters(parseAbiParameters("bytes32 orderKey,uint8 confirmation"), [facts.orderKey, 1]) } } };
}

test("review signing binds the selected label, order, schema, recipient, chain, nonce and final transition", () => {
  assert.equal(validateConfirmationPreparation(preparation(), facts, "Confirmed", false).primaryType, "Attest");
  assert.throws(() => validateConfirmationPreparation(preparation(), facts, "NotConfirmed", false));
  for (const patch of [{ orderKey: canonicalHash("other") }, { schemaUid: canonicalHash("other") },
    { recipient: facts.eas }, { chainId: 1 }, { nonce: "5" }, { currentUid: canonicalHash("other") }]) {
    assert.throws(() => validateConfirmationPreparation(preparation(), { ...facts, ...patch }, "Confirmed", false));
  }
  const final = { ...preparation(), transitionsUsed: 2 };
  assert.throws(() => validateConfirmationPreparation(final, { ...facts, transitionsUsed: 2 }, "Confirmed", false));
  assert.equal(validateConfirmationPreparation(final, { ...facts, transitionsUsed: 2 }, "Confirmed", true).primaryType, "Attest");
  const invalid = preparation(); invalid.signableTypedData.message.value = "1";
  assert.throws(() => validateConfirmationPreparation(invalid, facts, "Confirmed", false));
});

test("review retries preserve the EAS signature and read access uses grant-read and readCapability", async () => {
  const previous = process.env.DASKI_HOME;
  const home = mkdtempSync(join(tmpdir(), "daski-review-test-"));
  process.env.DASKI_HOME = home;
  const profile = DEFAULT_CONFIG.profiles.sandbox!;
  const signatures: TypedDataRequest[] = [];
  const submitted: unknown[] = [];
  let pending = true;
  const json = (structuredContent: Record<string, unknown>, isError = false) => ({ content: [], structuredContent, isError });
  const context = { profile, profileName: "sandbox", payerAddress: account.address,
    signer: { signTypedData: async (data: TypedDataRequest) => { signatures.push(data); return account.signTypedData(data as never); } },
    client: { hasTool: async () => true, callTool: async (name: string, args: Record<string, unknown>) => {
      if (name === "daski_get_order_status" && args.readCapability) {
        assert.equal(args.readCapability, "fixture-capability"); return json({ state: "FULFILLED" });
      }
      const action = name === "daski_get_order_access" ? "grant-read" : "confirmation";
      const request = args.request as Record<string, unknown> ?? {};
      if (!args.authorization) {
        const now = Math.floor(Date.now() / 1000);
        return json({ authorizationRequired: true, challenge: { orderId: "id", action, method: "POST",
          absoluteResourceUri: `${profile.gatewayUrl}/orders/handle/actions/${action}`, requestHash: canonicalHash(request),
          nonce: canonicalHash(`${name}-${signatures.length}`), issuedAt: now, validBefore: now + 120 } });
      }
      if (action === "grant-read") return json({ readCapability: "fixture-capability", expiresAt: Math.floor(Date.now() / 1000) + 600 });
      if (request.phase === "prepare") return json(preparation());
      submitted.push(request);
      return pending ? json({ code: "CONFIRMATION_SUBMISSION_PENDING" }, true) : json({ state: "completed" });
    } } } as unknown as CommandContext;
  try {
    const record = upsertOrder({ intentId: "intent", handle: "handle", profile: "sandbox", providerAgentId: "1", outcomeId: "form",
      payer: account.address, amount: "27100000", state: "FULFILLED", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await assert.rejects(confirmOrder(context, record, { handle: "handle", json: true }, async () => facts),
      (error: unknown) => error instanceof CliError && error.code === "DASKI_CONFIRMATION_CHOICE_REQUIRED");
    assert.equal(signatures.length, 0);
    const read = { toolName: "daski_get_order_status", action: "status" as const, request: {} };
    await readWithCapability(context, record, read);
    await readWithCapability(context, findByIntent("intent")!, read);
    assert.equal(signatures.length, 1, "read capability is cached and reused");
    assert.equal((await confirmOrder(context, findByIntent("intent")!, { handle: "handle", json: true, confirmation: "Confirmed" }, async () => facts)).status, "pending");
    assert.equal(signatures.filter((data) => data.primaryType === "Attest").length, 1);
    pending = false;
    await confirmOrder(context, findByIntent("intent")!, { handle: "handle", json: true, resume: true }, async () => { throw new Error("resume must reuse its preparation"); });
    assert.deepEqual(submitted[0], submitted[1]);
    assert.equal(signatures.filter((data) => data.primaryType === "Attest").length, 1);
    assert.equal(findByIntent("intent")?.confirmationSubmission, undefined);
  } finally {
    if (previous === undefined) delete process.env.DASKI_HOME; else process.env.DASKI_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
