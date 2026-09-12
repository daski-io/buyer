/**
 * `doctor` reports each key-durability fact on its own, detects a legacy
 * session-keyring entry without using it, and checks the gateway's account
 * types and confirmation pins against the profile. Every probe is injected,
 * so the report is produced offline.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { runDoctor, type DoctorTransport } from "../src/commands/doctor.js";
import { EAS_PREDEPLOY } from "../src/config.js";
import { parseGatewayMetadata } from "../src/gateway/metadata.js";
import { legacyKeyringDescription, type HostEnvironment } from "../src/host.js";

const ENV = ["DASKI_HOME", "DASKI_PAYER_PRIVATE_KEY"] as const;
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  const home = mkdtempSync(join(tmpdir(), "daski-doctor-"));
  for (const key of ENV) delete process.env[key];
  process.env.DASKI_HOME = home;
  try {
    await run(home);
  } finally {
    for (const key of ENV) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(home, { recursive: true, force: true });
  }
}

function transport(overrides: Partial<DoctorTransport> = {}): DoctorTransport {
  return {
    readiness: async () => ({ reachable: true, status: "ready", version: "0.40.0" }),
    probe: async (target) => { await target.close(); return { reachable: true, tools: ["daski_buy_outcome"], readableVia: "daski_list_outcomes" }; },
    metadata: async () => parseGatewayMetadata({
      buyerCli: { package: "@daski/pay", version: "0.1.0" },
      confirmationSigning: { chainId: 84532, eas: EAS_PREDEPLOY, schemaUid: `0x${"11".repeat(32)}`, reputationStorage: "0x3333333333333333333333333333333333333333" },
      payerAccounts: { types: ["eoa"], counterfactual: false },
      confirmation: { modes: ["sponsored", "direct"], sponsoredRequires: "eoa", attestationCap: 3, revocationAfterCap: true },
      signerClis: { "circle-agent": { package: "@circle-fin/cli", version: "1.2.3", repository: "git+https://github.com/circlefin/cli.git" } },
    }),
    chain: () => ({
      getCode: async () => "0x", call: async () => ({ data: undefined, reverted: true }),
      getTransactionReceipt: async () => null, getFinalizedBlockNumber: async () => 0n, getBlockHash: async () => `0x${"00".repeat(32)}`, readContract: async () => { throw new Error("no read expected"); },
    }),
    balances: async () => ({ nativeWei: "0", native: "0 ETH", usdcAtomic: "5000000", usdc: "5 USDC" }),
    ...overrides,
  };
}

const host = (overrides: Partial<HostEnvironment> = {}): HostEnvironment => ({
  platform: "linux", hostClass: "undeclared", declaredBackend: undefined, passphraseFile: undefined, procKeysPath: "/nonexistent", ...overrides,
});

test("a legacy session-keyring entry reports session-memory durability and blocks, and the facts are stated separately", async () => {
  await withHome(async (home) => {
    const procKeys = join(home, "proc-keys");
    writeFileSync(procKeys, `1f2e3d4c I--Q---     1 perm 3f010000  1000  1000 user      ${legacyKeyringDescription("sandbox")}: 66\n`);
    const report = await runDoctor({ host: host({ hostClass: "ephemeral", procKeysPath: procKeys }), transport: transport() });
    assert.deepEqual(report.host, { hostClass: "ephemeral", keyBackend: "file", keyDurability: "session-memory" });
    assert.equal(report.signer.signerKind, "local");
    assert.equal(report.signer.deployment, "not-applicable");
    assert.equal(report.signer.verifiedVia, null);
    assert.equal(report.signer.address, null, "the key in session memory is never read");
    const blocking = report.issues.filter((issue) => issue.severity === "blocking").map((issue) => issue.code);
    assert.deepEqual(blocking, ["DASKI_KEY_NOT_DURABLE"]);
    assert.equal(report.ok, false);
    assert.equal(report.chain.easAddress, EAS_PREDEPLOY);
    assert.deepEqual(report.gateway.payerAccounts, { types: ["eoa"], counterfactual: false });
    assert.equal((report.gateway.signerClis as Record<string, { version: string }>)["circle-agent"]?.version, "1.2.3");
  });
});

test("a durable EOA key passes with recovery, and the gateway's EAS pin must equal the profile's", async () => {
  await withHome(async () => {
    process.env.DASKI_PAYER_PRIVATE_KEY = `0x${"11".repeat(32)}`;
    const ok = await runDoctor({ host: host(), transport: transport() });
    assert.equal(ok.ok, true, JSON.stringify(ok.issues));
    assert.deepEqual(ok.host, { hostClass: "undeclared", keyBackend: "file", keyDurability: "environment" });
    assert.equal(ok.signer.address, account.address);
    assert.equal(ok.signer.verifiedVia, "recovery");
    assert.equal(ok.signer.accountType, "eoa");
    assert.equal(ok.signer.conformance, "verified");
    assert.ok(ok.issues.some((issue) => issue.code === "DASKI_ENV_KEY_IN_USE" && issue.severity === "warning"));

    const mismatched = await runDoctor({ host: host(), transport: transport({ metadata: async () => parseGatewayMetadata({
      confirmationSigning: { chainId: 84532, eas: "0x3333333333333333333333333333333333333333", schemaUid: `0x${"11".repeat(32)}`, reputationStorage: "0x3333333333333333333333333333333333333333" },
    }) }) });
    assert.equal(mismatched.ok, false);
    assert.ok(mismatched.issues.some((issue) => issue.code === "DASKI_EAS_ADDRESS_MISMATCH" && issue.severity === "blocking"));

    const keychainOnLinux = await runDoctor({ host: host({ declaredBackend: "keychain" }), transport: transport() });
    assert.equal(keychainOnLinux.host.keyBackend, "keychain");
    assert.equal(keychainOnLinux.host.keyDurability, "environment", "the environment key still answers");
    const unreachable = await runDoctor({ host: host(), transport: transport({ readiness: async () => ({ reachable: false, error: "offline" }) }) });
    assert.ok(unreachable.issues.some((issue) => issue.code === "DASKI_GATEWAY_UNREACHABLE"));
    assert.equal(unreachable.gateway.payerAccounts, null, "no metadata is read from an unreachable gateway");
  });
});

test("without any key the keychain backend on Linux is refused and the file backend is named", async () => {
  await withHome(async () => {
    const report = await runDoctor({ host: host({ declaredBackend: "keychain" }), transport: transport() });
    const issue = report.issues.find((entry) => entry.code === "DASKI_KEYCHAIN_UNSUPPORTED_ON_LINUX");
    assert.ok(issue);
    assert.equal(issue.severity, "blocking");
    assert.match(issue.remediation, /DASKI_KEY_BACKEND=file/);
    assert.equal(report.host.keyDurability, "none");
  });
});
