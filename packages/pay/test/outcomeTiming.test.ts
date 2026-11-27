import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAgainWords, outcomeKnownBy } from "../src/gateway/outcomeTiming.js";

const pending = (until: unknown) => ({ code: "PAYMENT_PENDING_RECONCILIATION", until });

test("takes only a pending settlement's until, as a full ISO 8601 instant at most a day ahead", () => {
  const soon = new Date(Date.now() + 5 * 60_000);
  assert.equal(outcomeKnownBy(pending(soon.toISOString())), soon.toISOString());
  assert.equal(outcomeKnownBy(pending("2026-11-27T18:21:42Z")), "2026-11-27T18:21:42.000Z");
  assert.equal(outcomeKnownBy(pending("2026-11-27T11:21:42-07:00")), "2026-11-27T18:21:42.000Z");
  assert.equal(outcomeKnownBy({ code: "SALES_PAUSED", until: soon.toISOString() }), undefined);
  assert.equal(outcomeKnownBy(pending("2026-11-27")), undefined);
  assert.equal(outcomeKnownBy(pending("1")), undefined);
  assert.equal(outcomeKnownBy(pending("soon")), undefined);
  assert.equal(outcomeKnownBy(pending(1_795_000_000)), undefined);
  assert.equal(outcomeKnownBy(pending(new Date(Date.now() + 2 * 86_400_000).toISOString())), undefined);
  assert.equal(outcomeKnownBy(pending("+275760-09-13T00:00:00.000Z")), undefined);
  assert.equal(outcomeKnownBy({ code: "PAYMENT_PENDING_RECONCILIATION" }), undefined);
  assert.equal(outcomeKnownBy(undefined), undefined);
});

test("says when to check again: after a future time; now, or again in a few minutes after a pending read", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  const command = "daski order reconcile int_1";
  const expects = `The gateway expects to know the outcome by ${future}: run ${command} after that, ` +
    "and again later if it is still pending.";
  assert.equal(checkAgainWords(future, command), expects);
  assert.equal(checkAgainWords(future, command, { stillPending: true }), expects);
  assert.equal(checkAgainWords(past, command),
    `The gateway expected to know the outcome by ${past}: run ${command} now, and again later if it is still pending.`);
  assert.equal(checkAgainWords(past, command, { stillPending: true }),
    `The gateway expected to know the outcome by ${past} and it is still pending: run ${command} again in a few minutes.`);
  assert.equal(checkAgainWords(undefined, command), `Check again with ${command}.`);
  assert.equal(checkAgainWords(undefined, command, { stillPending: true }), `Check again later with ${command}.`);
});
