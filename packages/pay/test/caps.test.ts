/** Temporary purchase limits fit within existing configured budgets. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCapOverrides, atomicUsdc, type ProfileConfig } from "../src/config.js";
import { CliError } from "../src/cli/errors.js";

const PROFILE: ProfileConfig = {
  gatewayUrl: "https://sandbox-gateway.daski.io",
  network: "eip155:84532",
  chainId: 84532,
  usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  rpcUrl: "https://sepolia.base.org",
  maxPerOrderUsdc: "25.00",
  sessionCapUsdc: "100.00",
  requireApprovalAboveUsdc: "1.00",
  signer: "local",
  enabled: true,
};

test("a flag may lower the per-order cap", () => {
  const tightened = applyCapOverrides(PROFILE, { maxPerOrderUsdc: "5.00" });
  assert.equal(tightened.maxPerOrderUsdc, "5.00");
  assert.equal(tightened.sessionCapUsdc, "100.00", "untouched caps stay as configured");
});

test("a flag may not raise the per-order cap", () => {
  assert.throws(
    () => applyCapOverrides(PROFILE, { maxPerOrderUsdc: "1000.00" }),
    (error: unknown) => error instanceof CliError &&
      error.code === "DASKI_CAP_OVERRIDE_WOULD_RAISE",
  );
});

test("a flag may not raise the session cap", () => {
  assert.throws(
    () => applyCapOverrides(PROFILE, { sessionCapUsdc: "100.000001" }),
    (error: unknown) => error instanceof CliError &&
      error.code === "DASKI_CAP_OVERRIDE_WOULD_RAISE",
  );
});

test("an equal cap is accepted, since it raises nothing", () => {
  assert.equal(applyCapOverrides(PROFILE, { maxPerOrderUsdc: "25.00" }).maxPerOrderUsdc, "25.00");
});

test("a malformed cap is refused rather than coerced", () => {
  for (const bad of ["twenty", "-5", "5.0.0", ""]) {
    assert.throws(
      () => applyCapOverrides(PROFILE, { maxPerOrderUsdc: bad }),
      (error: unknown) => error instanceof CliError,
      `"${bad}" should be refused`,
    );
  }
});

test("cap parsing is exact, with no floating point", () => {
  assert.equal(atomicUsdc("0.000001"), 1n);
  assert.equal(atomicUsdc("9.99"), 9_990_000n);
  assert.equal(atomicUsdc("25.00"), 25_000_000n);
  // 0.07 and 0.1 + 0.2 are the classic float traps.
  assert.equal(atomicUsdc("0.07"), 70_000n);
  assert.equal(atomicUsdc("0.30000"), 300_000n);
  assert.equal(atomicUsdc("1000000"), 1_000_000_000_000n);
});
