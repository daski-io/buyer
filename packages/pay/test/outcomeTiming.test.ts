import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAgainWords, outcomeKnownBy } from "../src/gateway/outcomeTiming.js";

test("reads the time an ambiguous answer names, and nothing else", () => {
  assert.equal(outcomeKnownBy({ until: "2026-11-27T18:21:42.000Z" }), "2026-11-27T18:21:42.000Z");
  assert.equal(outcomeKnownBy({ until: "2026-11-27T18:21:42Z" }), "2026-11-27T18:21:42.000Z");
  assert.equal(outcomeKnownBy({ until: "soon" }), undefined);
  assert.equal(outcomeKnownBy({ until: 1_795_000_000 }), undefined);
  assert.equal(outcomeKnownBy({ until: "x".repeat(65) }), undefined);
  assert.equal(outcomeKnownBy({}), undefined);
  assert.equal(outcomeKnownBy(undefined), undefined);
});

test("says when to check again: after a future time, now after a past one, plainly without one", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.equal(checkAgainWords(future, "daski order reconcile int_1"),
    `The gateway will know the outcome by ${future}: run daski order reconcile int_1 after that.`);
  assert.equal(checkAgainWords(past, "daski order reconcile int_1"),
    `The gateway expected to know the outcome by ${past}: run daski order reconcile int_1 now.`);
  assert.equal(checkAgainWords(undefined, "daski order reconcile int_1"), "Check again with daski order reconcile int_1.");
});
