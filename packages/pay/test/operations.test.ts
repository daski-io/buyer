import assert from "node:assert/strict";
import { test } from "node:test";
import { operationalStatus } from "../src/gateway/operations.js";
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
