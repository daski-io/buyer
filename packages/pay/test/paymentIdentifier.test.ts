/**
 * The payment identifier a submission carries is the gateway's.
 *
 * 0.1.1's `sign-payment` minted a fresh identifier for a challenge the agent
 * had obtained itself; the gateway looks a paid submission up by identifier,
 * found none, and refused every such payment with PAYMENT_IDENTIFIER_CONFLICT
 * before settlement (first live run of the harness's CLI lane, 2026-09-03).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CliError } from "../src/cli/errors.js";
import { challengeIntentId, issuedPaymentIdentifier, newIntentId, resolvePaymentIdentifier } from "../src/gateway/purchase.js";

const ISSUED = "int_00000000-0000-4000-8000-000000000002";

function fixtureExtensions(): Record<string, unknown> {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, "test", "fixtures", "gateway-wire", "payment-required-extensions.json");
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
    directory = dirname(directory);
  }
  throw new Error("gateway wire fixtures are missing: re-vendor test/fixtures/gateway-wire/ from the gateway");
}

test("the gateway's issued identifier is read from the vendored challenge extensions", () => {
  assert.equal(issuedPaymentIdentifier(fixtureExtensions()), ISSUED);
  assert.equal(issuedPaymentIdentifier({}), undefined);
  assert.equal(issuedPaymentIdentifier(undefined), undefined);
  assert.equal(issuedPaymentIdentifier({ "payment-identifier": { info: { required: true } } }), undefined);
});

test("a submission carries the issued identifier; a fresh one is used only when none was issued", () => {
  const extensions = fixtureExtensions();
  // sign-payment on an agent-obtained challenge: nothing proposed, the gateway's wins
  assert.equal(resolvePaymentIdentifier(extensions, undefined), ISSUED);
  // buy: the identifier we proposed at challenge time came back as the issued one
  assert.equal(resolvePaymentIdentifier(extensions, ISSUED), ISSUED);
  // a challenge without a pinned identifier keeps ours
  const proposed = newIntentId();
  assert.equal(resolvePaymentIdentifier({}, proposed), proposed);
  assert.equal(resolvePaymentIdentifier(undefined, undefined), undefined);
});

test("a challenge bound to a different identifier than the one proposed is refused, not signed", () => {
  const extensions = fixtureExtensions();
  assert.throws(
    () => resolvePaymentIdentifier(extensions, newIntentId()),
    (error: unknown) => error instanceof CliError && error.code === "DASKI_PAYMENT_IDENTIFIER_MISMATCH",
  );
});

test("buy adopts the identifier the challenge issued, so it can never mismatch its own challenge", () => {
  // 0.1.2's `buy` minted a fresh identifier after the challenge and then
  // refused the challenge with DASKI_PAYMENT_IDENTIFIER_MISMATCH: the gateway
  // never accepted a proposal, so a proposal was never anything but a mismatch
  // (2026-09-04). The ledger key is now the issued identifier.
  const extensions = fixtureExtensions();
  const intentId = challengeIntentId(extensions);
  assert.equal(intentId, ISSUED);
  assert.equal(resolvePaymentIdentifier(extensions, intentId), ISSUED);
  // A challenge without an identifier still gets a fresh reconciliation key.
  const minted = challengeIntentId({});
  assert.match(minted, /^daski-[0-9a-f]{32}$/);
  assert.equal(resolvePaymentIdentifier({}, minted), minted);
});
