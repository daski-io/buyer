/**
 * The input request and documents a provider adds to an order status read,
 * parsed from the gateway's vendored wire fixture, and the support request
 * the CLI signs.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inputRequest, orderDocuments } from "../src/gateway/inputRequest.js";
import { supportRequest } from "../src/commands/order.js";
import { CliError } from "../src/cli/errors.js";

function fixture(name: string): Record<string, unknown> {
  let directory = process.env.DASKI_GATEWAY_WIRE_FIXTURES ?? dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8 && !process.env.DASKI_GATEWAY_WIRE_FIXTURES; depth += 1) {
    if (existsSync(join(directory, "test", "fixtures", "gateway-wire", name))) {
      directory = join(directory, "test", "fixtures", "gateway-wire");
      break;
    }
    directory = dirname(directory);
  }
  return JSON.parse(readFileSync(join(directory, name), "utf8")) as Record<string, unknown>;
}

const additions = fixture("order-status-input-request.json");

test("the gateway's input request reads as the values on file, withheld values and what may change", () => {
  const request = inputRequest(additions);
  assert.ok(request);
  assert.equal(request.cause, "supplier_attention");
  assert.equal(request.reason, null);
  assert.match(request.summary, /resubmit the complete request/);
  assert.equal(request.requestedAt, new Date(1_756_769_000 * 1000).toISOString());
  const byPath = new Map(request.fields.map((entry) => [entry.path, entry]));
  assert.deepEqual(byPath.get("formData.responsible_party.last_name"), {
    path: "formData.responsible_party.last_name", label: "Responsible Party: Last Name",
    value: "personally", status: "as_submitted", editable: true,
  });
  assert.equal(byPath.get("formData.ssn")?.status, "withheld");
  assert.equal(byPath.get("formData.ssn")?.value, null);
  assert.equal(byPath.get("entity")?.editable, false);
  assert.equal(byPath.get("formData.ein_has_employees")?.value, false);
  assert.equal(byPath.get("filingProfile.presidents[0].lastName")?.status, "set_by_daski");
});

test("the gateway's order documents read with their download IDs", () => {
  assert.deepEqual(orderDocuments(additions), [{
    documentId: "8d42e3f9-1111-4222-8333-944455556666", title: "Rejection Notice", type: "Rejection Notice",
    receivedAt: new Date(1_756_769_000 * 1000).toISOString(),
  }]);
  assert.equal(orderDocuments({}), undefined);
});

test("provider text cannot drive the terminal, and a malformed request is not shown", () => {
  const request = inputRequest({ inputRequest: {
    schemaVersion: 1, requestedAt: 1, cause: "validation", summary: "Fix\u001b[2J this", reason: "bell\u0007",
    fields: [{ path: "formData.x", label: "X\u0000", value: "a\u009bb", status: "as_submitted", editable: true }],
  } });
  assert.equal(JSON.stringify(request).match(/\\u00(1b|07|00|9b)/), null);
  assert.equal(inputRequest({ inputRequest: { schemaVersion: 2 } }), undefined);
  assert.equal(inputRequest({ inputRequest: { schemaVersion: 1, requestedAt: 1, cause: "x", summary: "s",
    fields: [{ path: "p", label: "l", value: "v", status: "guessed", editable: true }] } }), undefined);
  assert.equal(inputRequest({}), undefined);
});

test("a support request is checked before signing and keeps a caller's request ID", () => {
  const generated = supportRequest("Everything shown is correct.");
  assert.match(generated.requestId, /^support_[0-9a-f]{32}$/);
  assert.deepEqual(supportRequest("Same message", "support_retry_1"), { requestId: "support_retry_1", message: "Same message" });
  assert.deepEqual(supportRequest("Line one\nLine two\ttab", "id-1").message, "Line one\nLine two\ttab");
  for (const message of ["", "   ", "bell\u0007", "x".repeat(4001)]) {
    assert.throws(() => supportRequest(message), (error: unknown) =>
      error instanceof CliError && error.code === "DASKI_SUPPORT_MESSAGE_INVALID");
  }
  assert.throws(() => supportRequest("ok", "bad id"), (error: unknown) =>
    error instanceof CliError && error.code === "DASKI_SUPPORT_REQUEST_ID_INVALID");
});
