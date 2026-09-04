import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWallet, walletAddress } from "../src/commands/wallet.js";
import { CliError } from "../src/cli/errors.js";

test("missing-wallet setup names the authorized command, while an existing signer is reused", async () => {
  const keys = ["DASKI_HOME", "DASKI_DISABLE_KEYCHAIN", "DASKI_PAYER_PRIVATE_KEY"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const home = mkdtempSync(join(tmpdir(), "daski-wallet-setup-"));
  process.env.DASKI_HOME = home; process.env.DASKI_DISABLE_KEYCHAIN = "1";
  delete process.env.DASKI_PAYER_PRIVATE_KEY;
  try {
    await assert.rejects(createWallet({}), (error: unknown) => error instanceof CliError &&
      error.code === "DASKI_KEY_CREATION_NEEDS_HUMAN" && error.remediation.includes("--yes-human-approved"));
    assert.equal(existsSync(join(home, "keystore.json")), false);
    process.env.DASKI_PAYER_PRIVATE_KEY = `0x${"11".repeat(32)}`;
    const before = await walletAddress({});
    await assert.rejects(createWallet({ yesHumanApproved: true }), (error: unknown) =>
      error instanceof CliError && error.code === "DASKI_KEY_ALREADY_EXISTS");
    assert.deepEqual(await walletAddress({}), before);
    assert.equal(existsSync(join(home, "keystore.json")), false);
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(home, { recursive: true, force: true });
  }
});
