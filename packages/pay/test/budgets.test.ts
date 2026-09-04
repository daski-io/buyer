import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCapOverrides, configureBudgets, loadConfig } from "../src/config.js";

test("new profiles approve paid quotes; upgrades preserve budgets until explicitly changed", () => {
  const previous = process.env.DASKI_HOME;
  const home = mkdtempSync(join(tmpdir(), "daski-budget-test-"));
  process.env.DASKI_HOME = home;
  try {
    const loaded = loadConfig();
    assert.equal(loaded.profile.maxPerOrderUsdc, null);
    assert.equal(loaded.profile.sessionCapUsdc, null);
    assert.equal(loaded.profile.requireApprovalAboveUsdc, "0.00");
    assert.equal(applyCapOverrides(loaded.profile, { maxPerOrderUsdc: "30" }).maxPerOrderUsdc, "30");
    const config = loaded.config;
    config.version = 1;
    Object.assign(config.profiles.sandbox!, { maxPerOrderUsdc: "25.00", sessionCapUsdc: "100.00", requireApprovalAboveUsdc: "1.00" });
    const file = join(home, "config.json");
    writeFileSync(file, JSON.stringify(config));
    const existing = readFileSync(file, "utf8");
    assert.equal(loadConfig().profile.maxPerOrderUsdc, "25.00");
    assert.equal(configureBudgets({}).changed, false);
    assert.equal(readFileSync(file, "utf8"), existing, "reading and upgrading do not rewrite user settings");
    configureBudgets({ perOrder: "30" });
    assert.equal(loadConfig().profile.maxPerOrderUsdc, "30");
    assert.equal(loadConfig().profile.sessionCapUsdc, "100.00");
    configureBudgets({ perOrder: "none", total: "none", approvalAbove: "0" });
    assert.equal(loadConfig().profile.maxPerOrderUsdc, null);
    assert.equal(loadConfig().profile.sessionCapUsdc, null);
    assert.equal(loadConfig().config.version, 2);
    assert.deepEqual(loadConfig().config.profiles.mainnet, config.profiles.mainnet);
  } finally {
    if (previous === undefined) delete process.env.DASKI_HOME; else process.env.DASKI_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
