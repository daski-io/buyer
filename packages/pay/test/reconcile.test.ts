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
import { CliError } from "../src/cli/errors.js";
import {
  isAmbiguousPurchaseAnswer,
  localOrderState,
  readPayerOrderRows,
  readSettlement,
  reconcileIdentifierRows,
} from "../src/gateway/purchase.js";

const code = (wanted: string) => (error: unknown): boolean => error instanceof CliError && error.code === wanted;

test("only the gateway's own paymentMayHaveSettled: false says nothing settled; a missing flag or an unreadable body is ambiguous", () => {
  assert.equal(isAmbiguousPurchaseAnswer({ code: "PAYMENT_IDENTIFIER_CONFLICT", paymentMayHaveSettled: true }), true);
  assert.equal(isAmbiguousPurchaseAnswer({ code: "PAYMENT_PENDING_RECONCILIATION", paymentMayHaveSettled: true }), true);
  // A definitive refusal: nothing settled, whatever the code.
  assert.equal(isAmbiguousPurchaseAnswer({ code: "PAYMENT_IDENTIFIER_UNKNOWN", paymentMayHaveSettled: false }), false);
  assert.equal(isAmbiguousPurchaseAnswer({ code: "PAYMENT_PENDING_RECONCILIATION", paymentMayHaveSettled: false }), false);
  // A refusal without the flag is never read as definitive non-settlement,
  // whatever its code; nor is a malformed flag or a body this CLI cannot read.
  assert.equal(isAmbiguousPurchaseAnswer({ code: "REQUEST_SCHEMA_INVALID" }), true);
  assert.equal(isAmbiguousPurchaseAnswer({ code: "PAYMENT_OUTCOME_PENDING" }), true);
  assert.equal(isAmbiguousPurchaseAnswer({ code: "X", paymentMayHaveSettled: "false" }), true);
  assert.equal(isAmbiguousPurchaseAnswer({}), true);
  assert.equal(isAmbiguousPurchaseAnswer(undefined), true);
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

test("history rows without a payment identifier or a decimal amount are unreadable, never matched by other invariants", () => {
  const good = { orderHandle: "h", paymentIdentifier: "int_a", providerAgentId: "1", outcomeId: "form",
    grossAmount: "27100000", state: "FULFILLED", createdAt: "2026-09-04T16:50:48.000Z" };
  assert.deepEqual(readPayerOrderRows({ orders: [good, { ...good, createdAt: undefined }] }), [good, { ...good, createdAt: undefined }]);
  const without = (field: string) => Object.fromEntries(Object.entries(good).filter(([key]) => key !== field));
  const cases: [string, unknown, RegExp][] = [
    ["no identifier", without("paymentIdentifier"), /paymentIdentifier/],
    ["an empty identifier", { ...good, paymentIdentifier: "" }, /paymentIdentifier/],
    ["no amount", without("grossAmount"), /grossAmount/],
    ["a non-atomic amount", { ...good, grossAmount: "27.1" }, /grossAmount/],
    ["no state", without("state"), /state/],
    ["no handle", without("orderHandle"), /orderHandle/],
    ["not an object", "row", /not an object/],
  ];
  for (const [label, row, reason] of cases) {
    assert.throws(() => readPayerOrderRows({ orders: [good, row] }),
      (error: unknown) => code("DASKI_ORDER_HISTORY_UNREADABLE")(error) && reason.test((error as CliError).message) && /row 1/.test((error as CliError).message),
      label);
  }
  assert.throws(() => readPayerOrderRows({}), code("DASKI_ORDER_HISTORY_UNREADABLE"));
  // Two rows for one identifier cannot be told apart: ambiguous, never absent.
  assert.equal(reconcileIdentifierRows("int_a", [good, { ...good, orderHandle: "h2" }]).status, "ambiguous");
});

test("the ledger state comes from the same table as the settlement reading; an unknown gateway state is refused, never SUBMITTED", () => {
  const expected: Record<string, string> = {
    FULFILLED: "FULFILLED", INPUT_REQUIRED: "INPUT_REQUIRED", PROVIDER_FAILED: "PROVIDER_FAILED",
    DISPATCHED: "SUBMITTED", DISPATCH_STARTED: "SUBMITTED", RELEASE_FINAL: "SUBMITTED", DEPOSIT_FINAL: "SUBMITTED",
    FACILITATOR_CONFIRMED: "SUBMITTED", LEGAL_HOLD: "SUBMITTED", DISPATCH_AMBIGUOUS: "SUBMITTED",
    SETTLE_INVOKED: "PENDING_RECONCILIATION", VERIFIED: "PENDING_RECONCILIATION", ATTEMPT_OPENED: "PENDING_RECONCILIATION",
    SETTLEMENT_AMBIGUOUS: "PENDING_RECONCILIATION", EXTERNAL_OR_UNPROVEN_DEPOSIT: "PENDING_RECONCILIATION",
    DRAFT: "NOT_SETTLED", CHALLENGE_ISSUED: "NOT_SETTLED", VERIFY_REJECTED: "NOT_SETTLED", SETTLEMENT_FAILED: "NOT_SETTLED", NOT_SETTLED: "NOT_SETTLED",
  };
  for (const [state, local] of Object.entries(expected)) {
    assert.equal(localOrderState(state, "ord_x"), local, state);
    assert.equal(readSettlement(state) === "not_settled", local === "NOT_SETTLED", `${state}: the budget and the ledger agree`);
  }
  for (const unknown of ["SOMETHING_NEW", "working", "completed", "canceled", "", undefined, 7]) {
    assert.throws(() => localOrderState(unknown, "ord_x"),
      (error: unknown) => code("DASKI_ORDER_STATE_UNREADABLE")(error) && /ord_x/.test((error as CliError).remediation), String(unknown));
  }
  assert.throws(() => localOrderState("SOMETHING_NEW"), (error: unknown) => code("DASKI_ORDER_STATE_UNREADABLE")(error) && /<handle>/.test((error as CliError).remediation));
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
