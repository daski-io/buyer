import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChainReader } from "../src/chain/reader.js";
import { discoverEasReviewProfile, EAS_REVIEW_PROFILES } from "../src/chain/easProfiles.js";
function fixture(chainId: number) {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let n = 0; n < 8; n++, directory = dirname(directory)) {
    const path = join(directory, "test/fixtures/eas/base-" + chainId + ".json");
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  }
  throw new Error("Missing pinned EAS runtime fixture");
}
for (const chainId of [8453, 84532]) {
  test("buyer independently verifies pinned EAS runtime/getters for " + chainId, async () => {
    const f = fixture(chainId);
    function reader(overrides: Record<string, unknown> = {}): ChainReader {
      const values: Record<string, unknown> = { version: f.version, getDomainSeparator: f.getDomainSeparator,
        getAttestTypeHash: f.getAttestTypeHash, getRevokeTypeHash: f.getRevokeTypeHash, ...overrides };
      return { getFinalBlockNumber: async () => BigInt(f.blockNumber),
        getStorageAt: async () => overrides.slot ?? "0x" + "0".repeat(24) + f.eas.implementation.slice(2),
        getCode: async () => overrides.code ?? f.eas.runtimeCode,
        readContract: async ({ functionName }: { functionName: string }) => values[functionName],
      } as unknown as ChainReader;
    }
    assert.equal((await discoverEasReviewProfile(reader(), chainId, f.eas.address)).id, EAS_REVIEW_PROFILES[chainId]!.id);
    for (const change of [{ version: "1.4.1-beta.3" }, { code: "0x6000" }, { slot: "0x" + "0".repeat(64) },
      { getDomainSeparator: "0x00" }, { getAttestTypeHash: "0x00" }, { getRevokeTypeHash: "0x00" }]) {
      await assert.rejects(discoverEasReviewProfile(reader(change), chainId, f.eas.address), { code: "DASKI_CONFIRMATION_EAS_INCOMPATIBLE" });
    }
    await assert.rejects(discoverEasReviewProfile(reader(), 1, f.eas.address), { code: "DASKI_CONFIRMATION_EAS_INCOMPATIBLE" });
    await assert.rejects(discoverEasReviewProfile(reader(), chainId, "0x1111111111111111111111111111111111111111"), { code: "DASKI_CONFIRMATION_EAS_INCOMPATIBLE" });
  });
}
