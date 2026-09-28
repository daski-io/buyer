import assert from "node:assert/strict";
import { test } from "node:test";
import { operationalStatus, supportReply } from "../src/gateway/operations.js";
import { gatewayOrderState } from "../src/commands/order.js";

test("operational waits and recovery never replace financial history", () => {
  const status = { state: "failed", orderState: "PROVIDER_FAILED", operations: {
    schemaVersion: 1, fulfillment: { phase: "dns_pending" }, recovery: null,
  } };
  assert.equal(operationalStatus(status), "DNS pending");
  for (const [state, label] of Object.entries({ queued: "Recovery queued", pending: "Recovery waiting",
    running: "Recovering", attention: "Recovery needs operator attention", completed: "Completed after recovery", stopped: "Recovery stopped" })) {
    const recovered = { ...status, operations: { ...status.operations, recovery: { state } } };
    assert.equal(operationalStatus(recovered), label);
    assert.equal(gatewayOrderState(recovered), "PROVIDER_FAILED");
  }
  assert.equal(operationalStatus({ operations: { schemaVersion: 1, fulfillment: { phase: "waiting_capacity" } } }), "Ready, queued for capacity");
  assert.equal(operationalStatus({ operations: { schemaVersion: 2, recovery: { state: "completed" } } }), undefined);
  assert.equal(operationalStatus({}), undefined);
});

test("the operator's latest support reply is shown as provider-authored data", () => {
  const status = { operations: { schemaVersion: 1, support: { reviewId: "review", status: "open",
    lastAcceptedRequest: { requestId: "r1", messageId: "m1", acceptedAt: 1_800_000_000 },
    lastReply: { messageId: "m2", repliedAt: 1_800_000_060, message: "We are recovering your mailbox." } } } };
  assert.deepEqual(supportReply(status), { repliedAt: "2027-01-15T08:01:00.000Z", message: "We are recovering your mailbox." });
  const unreplied = { operations: { schemaVersion: 1, support: { reviewId: "review", status: "open" } } };
  assert.equal(supportReply(unreplied), undefined);
  assert.equal(supportReply({ operations: { schemaVersion: 2, support: status.operations.support } }), undefined);
  assert.equal(supportReply({}), undefined);
});
