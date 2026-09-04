/**
 * Reconciliation is decided by the gateway's own answers, never by a local
 * ledger message, a balance reading, or a hardcoded code list. On 2026-09-04
 * a PAYMENT_IDENTIFIER_CONFLICT (flagged paymentMayHaveSettled: true) was not
 * in the code list, so the CLI recorded PENDING_RECONCILIATION without
 * reconciling, and `order status` then told the operator's agent to re-run
 * `daski buy`; the agent re-signed against a gateway answer that said not to.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isAmbiguousPurchaseAnswer,
  readSettlement,
  reconcileIdentifierRows,
} from "../src/gateway/purchase.js";

test("the gateway's paymentMayHaveSettled flag decides ambiguity; the code list is only a fallback", () => {
  assert.equal(isAmbiguousPurchaseAnswer("PAYMENT_IDENTIFIER_CONFLICT", { paymentMayHaveSettled: true }), true);
  assert.equal(isAmbiguousPurchaseAnswer("PAYMENT_PENDING_RECONCILIATION", { paymentMayHaveSettled: true }), true);
  // A definitive refusal: nothing settled, whatever the code.
  assert.equal(isAmbiguousPurchaseAnswer("PAYMENT_IDENTIFIER_UNKNOWN", { paymentMayHaveSettled: false }), false);
  assert.equal(isAmbiguousPurchaseAnswer("PAYMENT_PENDING_RECONCILIATION", { paymentMayHaveSettled: false }), false);
  // Older gateways without the flag: the known ambiguous codes still reconcile.
  assert.equal(isAmbiguousPurchaseAnswer("PAYMENT_PENDING_RECONCILIATION", {}), true);
  assert.equal(isAmbiguousPurchaseAnswer("PAYMENT_OUTCOME_PENDING", undefined), true);
  assert.equal(isAmbiguousPurchaseAnswer("REQUEST_SCHEMA_INVALID", {}), false);
  assert.equal(isAmbiguousPurchaseAnswer(undefined, undefined), false);
});

test("gateway order states read as settled, in flight, ambiguous, or not settled; unknown is ambiguous", () => {
  for (const state of ["DRAFT", "CHALLENGE_ISSUED", "VERIFY_REJECTED", "SETTLEMENT_FAILED", "NOT_SETTLED"]) {
    assert.equal(readSettlement(state), "not_settled", state);
  }
  for (const state of ["ATTEMPT_OPENED", "VERIFIED", "SETTLE_INVOKED"]) {
    assert.equal(readSettlement(state), "in_flight", state);
  }
  for (const state of ["SETTLEMENT_AMBIGUOUS", "EXTERNAL_OR_UNPROVEN_DEPOSIT", "DISPATCH_AMBIGUOUS", "SOMETHING_NEW"]) {
    assert.equal(readSettlement(state), "ambiguous", state);
  }
  for (const state of ["DEPOSIT_FINAL", "RELEASE_FINAL", "DISPATCHED", "FULFILLED", "PROVIDER_FAILED", "INPUT_REQUIRED", "LEGAL_HOLD"]) {
    assert.equal(readSettlement(state), "settled", state);
  }
});

test("an identifier the gateway lists nothing for is absent: nothing settled under it", () => {
  // The 0.1.0 ledger key from the 2026-09-04 session: the gateway never issued
  // it, so no order can exist for it, and that is the whole answer.
  const outcome = reconcileIdentifierRows("daski-e1f3f326f4e5ea9a5546bbb34538daaf", [
    {
      orderHandle: "handle-other",
      paymentIdentifier: "int_00000000-0000-4000-8000-000000000002",
      providerAgentId: "8327",
      outcomeId: "register-domain",
      grossAmount: "5990000",
      state: "FULFILLED",
      createdAt: "2026-09-04T16:50:48.000Z",
    },
  ]);
  assert.equal(outcome.status, "absent");
  assert.equal(outcome.orderHandle, undefined);
  assert.match(outcome.evidence, /lists no order for payment identifier daski-e1f3/);
});

test("a listed order settles the record by the gateway's state", () => {
  const row = {
    orderHandle: "handle-1",
    paymentIdentifier: "int_00000000-0000-4000-8000-000000000002",
    providerAgentId: "8327",
    outcomeId: "register-domain",
    grossAmount: "5990000",
    createdAt: "2026-09-04T16:50:48.000Z",
  };
  assert.deepEqual(reconcileIdentifierRows(row.paymentIdentifier, [{ ...row, state: "FULFILLED" }]), {
    status: "settled",
    orderHandle: "handle-1",
    gatewayState: "FULFILLED",
    evidence: "the gateway lists order handle-1 for int_00000000-0000-4000-8000-000000000002 in state FULFILLED",
  });
  // An unpaid draft is listed but nothing settled under it.
  assert.equal(reconcileIdentifierRows(row.paymentIdentifier, [{ ...row, state: "CHALLENGE_ISSUED" }]).status, "absent");
  assert.equal(reconcileIdentifierRows(row.paymentIdentifier, [{ ...row, state: "SETTLE_INVOKED" }]).status, "in_flight");
  assert.equal(reconcileIdentifierRows(row.paymentIdentifier, [{ ...row, state: "SETTLEMENT_AMBIGUOUS" }]).status, "ambiguous");
});
