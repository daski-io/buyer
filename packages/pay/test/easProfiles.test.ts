import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChainReader, ContractRead } from "../src/chain/reader.js";
import { discoverEasReviewProfile, EAS_REVIEW_PROFILES } from "../src/chain/easProfiles.js";
function fixture(name: string) {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let n = 0; n < 8; n++, directory = dirname(directory)) {
    const path = join(directory, "test/fixtures/eas/" + name);
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  }
  throw new Error("Missing pinned EAS runtime fixture");
}
const FIXTURES = [["base-8453.json", 8453, "eas-native-1.0.1"], ["base-84532.json", 84532, "eas-native-1.2.0"],
  ["base-84532-eas-1.4.1-beta.3.json", 84532, "eas-native-1.4.1-beta.3"],
  ["base-8453-eas-1.4.1-beta.3.json", 8453, "eas-native-1.4.1-beta.3"]] as const;
for (const [name, chainId, id] of FIXTURES) {
  test("buyer independently qualifies the EAS signing format " + id + " on " + chainId, async () => {
    const f = fixture(name);
    assert.equal(f.chainId, chainId);
    function reader(overrides: Record<string, unknown> = {}): ChainReader {
      const values: Record<string, unknown> = { version: f.version, getDomainSeparator: f.getDomainSeparator,
        getAttestTypeHash: f.getAttestTypeHash, getRevokeTypeHash: f.getRevokeTypeHash, ...overrides };
      return { getFinalBlockNumber: async () => BigInt(f.blockNumber),
        getStorageAt: async () => "0x" + "0".repeat(24) + f.eas.implementation.slice(2),
        getCode: async () => f.eas.runtimeCode,
        readContract: async ({ functionName }: { functionName: string }) => values[functionName],
      } as unknown as ChainReader;
    }
    assert.equal((await discoverEasReviewProfile(reader(), chainId, f.eas.address)).id, EAS_REVIEW_PROFILES[id].id);
    // A Base upgrade that keeps this signing format, under any contract version or bytecode, keeps qualifying.
    assert.equal((await discoverEasReviewProfile(reader({ version: "9.9.9" }), chainId, f.eas.address)).id, id);
    // Another chain's domain separator, or any other format's facts, never select a message.
    const others = FIXTURES.filter(([otherName]) => otherName !== name).map(([otherName]) => fixture(otherName));
    for (const change of [{ getDomainSeparator: "0x00" }, { getAttestTypeHash: "0x00" }, { getRevokeTypeHash: "0x00" },
      { getDomainSeparator: undefined }, { getAttestTypeHash: undefined },
      ...others.filter(other => other.getDomainSeparator !== f.getDomainSeparator).map(other => ({ getDomainSeparator: other.getDomainSeparator })),
      ...others.filter(other => other.getAttestTypeHash !== f.getAttestTypeHash).map(other => ({ getAttestTypeHash: other.getAttestTypeHash })),
      ...others.filter(other => other.getRevokeTypeHash !== f.getRevokeTypeHash).map(other => ({ getRevokeTypeHash: other.getRevokeTypeHash }))]) {
      await assert.rejects(discoverEasReviewProfile(reader(change), chainId, f.eas.address), { code: "DASKI_CONFIRMATION_EAS_INCOMPATIBLE" });
    }
    await assert.rejects(discoverEasReviewProfile(reader(), 1, f.eas.address), { code: "DASKI_CONFIRMATION_EAS_INCOMPATIBLE" });
    await assert.rejects(discoverEasReviewProfile(reader(), chainId, "0x1111111111111111111111111111111111111111"), { code: "DASKI_CONFIRMATION_EAS_INCOMPATIBLE" });
  });
}

test("Base's 2026-11-04 EAS upgrade presents the format Base Sepolia's 2026-10-22 upgrade qualified", () => {
  const mainnet = fixture("base-8453-eas-1.4.1-beta.3.json"), sepolia = fixture("base-84532-eas-1.4.1-beta.3.json");
  assert.equal(mainnet.version, sepolia.version);
  assert.notEqual(mainnet.eas.runtimeCodeHash, sepolia.eas.runtimeCodeHash, "different bytecode, same signing format");
  assert.equal(mainnet.getAttestTypeHash, sepolia.getAttestTypeHash);
  assert.equal(mainnet.getRevokeTypeHash, sepolia.getRevokeTypeHash);
});

test("each signing format is distinct, so at most one matches a deployment", () => {
  const profiles = Object.values(EAS_REVIEW_PROFILES);
  for (const key of ["domainVersion", "attestTypeHash", "revokeTypeHash"] as const) {
    assert.equal(new Set(profiles.map(profile => profile[key])).size, profiles.length, key);
  }
});

test("a batching reader answers the EAS identity getters in one call pinned at the final block", async () => {
  const f = fixture("base-8453.json");
  const values: Record<string, unknown> = { version: f.version, getDomainSeparator: f.getDomainSeparator,
    getAttestTypeHash: f.getAttestTypeHash, getRevokeTypeHash: f.getRevokeTypeHash };
  const batches: { functionNames: string[]; blockNumber: bigint | undefined }[] = [];
  const reader = { getFinalBlockNumber: async () => BigInt(f.blockNumber),
    getStorageAt: async () => "0x" + "0".repeat(24) + f.eas.implementation.slice(2),
    getCode: async () => f.eas.runtimeCode,
    readContract: async () => { throw new Error("an unbatched read"); },
    readContracts: async ({ reads, blockNumber }: { reads: readonly ContractRead[]; blockNumber?: bigint }) => {
      batches.push({ functionNames: reads.map((read) => read.functionName), blockNumber });
      return reads.map((read) => values[read.functionName]);
    },
  } as unknown as ChainReader;
  assert.equal((await discoverEasReviewProfile(reader, 8453, f.eas.address)).id, "eas-native-1.0.1");
  assert.deepEqual(batches, [{ functionNames: ["getDomainSeparator", "getAttestTypeHash", "getRevokeTypeHash"],
    blockNumber: BigInt(f.blockNumber) }]);
});
