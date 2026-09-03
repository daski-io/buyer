/**
 * The gateway result reader.
 *
 * On 2026-09-03 the published CLI could not complete one gateway call: the
 * gateway carried every payload in MCP `structuredContent` and the reader
 * stopped at the text block. These tests pin where a payload and a challenge
 * are read from, and that a success this client cannot read is reported as a
 * protocol mismatch — never as "not found" or "rejected".
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GatewayClient,
  probeGatewayProtocol,
  unreadableResultError,
  type McpToolResult,
} from "../src/gateway/client.js";

const challenge = {
  x402Version: 2,
  resource: { url: "https://gateway.example/outcomes/8327/register-domain" },
  accepts: [{
    scheme: "exact",
    network: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    amount: "5990000",
    payTo: "0x2222222222222222222222222222222222222222",
    maxTimeoutSeconds: 300,
  }],
  extensions: {},
};
const PLACEHOLDER = { type: "text", text: "Daski tool call succeeded." };
const text = (value: unknown) => ({ type: "text", text: JSON.stringify(value) });

test("json: structuredContent is authoritative; a JSON text block is the fallback", () => {
  const structuredOnly: McpToolResult = {
    content: [PLACEHOLDER],
    structuredContent: { orderHandle: "h", state: "FULFILLED" },
  };
  assert.deepEqual(GatewayClient.json(structuredOnly), { orderHandle: "h", state: "FULFILLED" });
  assert.equal(GatewayClient.unreadable(structuredOnly), false);

  const textOnly: McpToolResult = { content: [text({ a: 1 })] };
  assert.deepEqual(GatewayClient.json(textOnly), { a: 1 });

  const both: McpToolResult = { content: [text({ from: "text" })], structuredContent: { from: "structured" } };
  assert.deepEqual(GatewayClient.json(both), { from: "structured" });

  const arrayIsNotAPayload: McpToolResult = { content: [text([1, 2])], structuredContent: [1, 2] };
  assert.equal(GatewayClient.json(arrayIsNotAPayload), undefined);
});

test("unreadable: a success with no payload is a protocol mismatch; a refusal is not", () => {
  const blind: McpToolResult = { content: [PLACEHOLDER] };
  assert.equal(GatewayClient.json(blind), undefined);
  assert.equal(GatewayClient.unreadable(blind), true);
  assert.equal(GatewayClient.unreadable({ ...blind, isError: true }), false);
  assert.equal(GatewayClient.unreadable({ content: [text({ code: "X" })], isError: true }), false);
});

test("challenge: _meta first, then the prepare tool's nested body, then a bare body", () => {
  const prepared = {
    orderHandle: "h",
    paymentRequired: challenge,
    preflight: { sufficient: true, approvalSummary: "Buy it." },
  };
  const nested: McpToolResult = { content: [text(prepared)], structuredContent: prepared };
  assert.deepEqual(GatewayClient.challenge(nested), challenge);
  assert.deepEqual(GatewayClient.preflight(nested), prepared.preflight);

  const viaMeta: McpToolResult = {
    content: [text(challenge)],
    structuredContent: challenge,
    _meta: { "x402/payment-required": challenge },
    isError: true,
  };
  assert.deepEqual(GatewayClient.challenge(viaMeta), challenge);

  const bare: McpToolResult = { content: [text(challenge)] };
  assert.deepEqual(GatewayClient.challenge(bare), challenge);
  assert.equal(GatewayClient.preflight(bare), undefined);

  assert.equal(GatewayClient.challenge({ content: [text({ orderHandle: "h" })] }), undefined);
  assert.equal(GatewayClient.challenge({ content: [PLACEHOLDER] }), undefined);
});

test("unreadableResultError attaches the result shape and picks the remediation by phase", () => {
  const result: McpToolResult = { content: [PLACEHOLDER] };
  const before = unreadableResultError("daski_get_outcome", result);
  assert.equal(before.code, "DASKI_GATEWAY_RESULT_UNREADABLE");
  assert.match(before.remediation, /Nothing was signed/);
  assert.equal(before.details.tool, "daski_get_outcome");

  const after = unreadableResultError("daski_buy_outcome", result, { afterSubmit: true });
  assert.match(after.remediation, /Do not re-run/);
  const gateway = after.details.gateway as {
    isError: boolean; hasStructuredContent: boolean; textPreview: string[];
  };
  assert.equal(gateway.isError, false);
  assert.equal(gateway.hasStructuredContent, false);
  assert.deepEqual(gateway.textPreview, ["Daski tool call succeeded."]);
});

function fakeTarget(tools: string[], answer: (name: string) => McpToolResult) {
  const calls: string[] = [];
  const target = {
    calls,
    closed: false,
    availableTools: async (): Promise<Set<string>> => new Set(tools),
    callTool: async (name: string): Promise<McpToolResult> => {
      calls.push(name);
      return answer(name);
    },
    close: async (): Promise<void> => {
      target.closed = true;
    },
  };
  return target;
}

test("probe: a readable read-only result passes and the connection is closed", async () => {
  const guide = { markdown: "# Set up Daski", sha256: "00", topic: "setup" };
  const target = fakeTarget(["daski_buy_outcome", "daski_get_setup_guide"], () => ({
    content: [text(guide)], structuredContent: guide,
  }));
  const probe = await probeGatewayProtocol(target);
  assert.equal(probe.reachable, true);
  assert.equal(probe.readableVia, "daski_get_setup_guide");
  assert.deepEqual(probe.tools, ["daski_buy_outcome", "daski_get_setup_guide"]);
  assert.equal(target.closed, true);
});

test("probe: placeholder-only results are a protocol mismatch, tried on every read-only tool", async () => {
  const target = fakeTarget(
    ["daski_buy_outcome", "daski_get_setup_guide", "daski_list_outcomes"],
    () => ({ content: [PLACEHOLDER] }),
  );
  const probe = await probeGatewayProtocol(target);
  assert.equal(probe.reachable, true);
  assert.equal(probe.readableVia, null);
  assert.deepEqual(target.calls, ["daski_get_setup_guide", "daski_list_outcomes"]);
  assert.equal(target.closed, true);
});

test("probe: a transport failure reports unreachable with the cause", async () => {
  const target = fakeTarget([], () => ({ content: [] }));
  target.availableTools = async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:443");
  };
  const probe = await probeGatewayProtocol(target);
  assert.equal(probe.reachable, false);
  assert.equal(probe.readableVia, null);
  assert.match(probe.error ?? "", /ECONNREFUSED/);
  assert.equal(target.closed, true);
});
