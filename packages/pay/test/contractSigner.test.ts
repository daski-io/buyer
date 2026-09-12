/**
 * Contract-account signers: the self-test verifies the DaskiDoctor vector
 * through the wallet's own isValidSignature with a bounded call; a wallet
 * must be deployed and the gateway must verify contract accounts before a
 * purchase asks for a challenge; and an EOA signer costs no RPC at all.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, hashTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { SignerAdapter, TypedDataRequest } from "@daski/x402-scheme";
import { ERC1271_ABI, ERC1271_CALL_GAS, type ChainReader } from "../src/chain/reader.js";
import { CliError } from "../src/cli/errors.js";
import { runBuy } from "../src/commands/buy.js";
import type { CommandContext } from "../src/context.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { parseGatewayMetadata } from "../src/gateway/metadata.js";
import { assertContractSignerUsable, checkDeployment, NOT_DEPLOYED_REMEDIATION } from "../src/signers/contract.js";
import { runSignerSelfTest, selfTestVector } from "../src/signers/selfTest.js";

const code = (wanted: string) => (error: unknown): boolean => error instanceof CliError && error.code === wanted;
const WALLET = "0x161f376d31f7f575E9C4Cb865A50C3b0FEC6DDc4" as Address;
const MAGIC = `0x1626ba7e${"00".repeat(28)}` as Hex;
const OPAQUE = `0x${"cd".repeat(96)}` as Hex;

function contractSigner(signature: Hex | (() => Promise<Hex>) = OPAQUE): SignerAdapter {
  return {
    getAddress: async () => WALLET,
    signTypedData: async () => (typeof signature === "function" ? signature() : signature),
    describe: () => ({ provider: "circle-agent", accountType: "contract", conformance: "candidate-pending-conformance" }),
  };
}

function chain(overrides: Partial<ChainReader> = {}) {
  const calls: { method: string; args: unknown }[] = [];
  const reader: ChainReader = {
    getCode: async (address) => { calls.push({ method: "getCode", args: address }); return "0x6080"; },
    call: async (args) => { calls.push({ method: "call", args }); return { data: MAGIC, reverted: false }; },
    getTransactionReceipt: async () => null,
    readContract: async () => { throw new Error("unexpected contract read"); },
    ...overrides,
  };
  return { reader, calls };
}

test("a contract signer passes when its wallet answers isValidSignature with the magic value for the vector hash", async () => {
  const { reader, calls } = chain();
  const result = await runSignerSelfTest(contractSigner(), 84532, reader);
  assert.deepEqual(result, { passed: true, verifiedVia: "erc1271", recovered: null, lowS: null });
  const call = calls.find((entry) => entry.method === "call")!.args as { to: Address; data: Hex; gas: bigint };
  assert.equal(call.to, WALLET, "the wallet itself is asked");
  assert.equal(call.gas, ERC1271_CALL_GAS);
  const decoded = decodeFunctionData({ abi: ERC1271_ABI, data: call.data });
  assert.equal(decoded.functionName, "isValidSignature");
  assert.equal(decoded.args[0], hashTypedData(selfTestVector(WALLET, 84532) as never), "the hash is computed locally");
  assert.equal(decoded.args[1], OPAQUE);
});

test("a contract signer fails on the wrong magic, a revert, a transport failure, an ERC-6492 wrapper, or an oversized signature", async () => {
  const wrong = await runSignerSelfTest(contractSigner(), 84532, chain({ call: async () => ({ data: `0xffffffff${"00".repeat(28)}`, reverted: false }) }).reader);
  assert.equal(wrong.passed, false);
  assert.match(wrong.reason ?? "", /not the ERC-1271 magic value/);
  const short = await runSignerSelfTest(contractSigner(), 84532, chain({ call: async () => ({ data: "0x1626ba7e", reverted: false }) }).reader);
  assert.equal(short.passed, false, "a 4-byte return is not the 32-byte ABI encoding");
  const reverted = await runSignerSelfTest(contractSigner(), 84532, chain({ call: async () => ({ data: undefined, reverted: true }) }).reader);
  assert.match(reverted.reason ?? "", /reverted/);
  const offline = await runSignerSelfTest(contractSigner(), 84532, chain({ call: async () => { throw new CliError({ code: "DASKI_RPC_UNAVAILABLE", message: "timeout", remediation: "retry" }); } }).reader);
  assert.match(offline.reason ?? "", /could not be called: timeout/);
  const { reader, calls } = chain();
  const wrapped = await runSignerSelfTest(contractSigner(`0x${"11".repeat(64)}${"6492".repeat(16)}`), 84532, reader);
  assert.match(wrapped.reason ?? "", /ERC-6492/);
  assert.equal(calls.length, 0, "a counterfactual signature never reaches the chain");
  const oversized = await runSignerSelfTest(contractSigner(`0x${"ab".repeat(4097)}`), 84532, reader);
  assert.match(oversized.reason ?? "", /malformed signature/);
  const threw = await runSignerSelfTest(contractSigner(async () => { throw new Error("not logged in"); }), 84532, reader);
  assert.match(threw.reason ?? "", /the signer threw: not logged in/);
  const noChain = await runSignerSelfTest(contractSigner(), 84532);
  assert.match(noChain.reason ?? "", /no RPC reader/);
});

test("an EOA signer is verified by recovery and never touches the chain", async () => {
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const signer: SignerAdapter = {
    getAddress: async () => account.address,
    signTypedData: (payload: TypedDataRequest) => account.signTypedData(payload as never),
    describe: () => ({ provider: "local", accountType: "eoa", conformance: "verified" }),
  };
  const { reader, calls } = chain();
  const result = await runSignerSelfTest(signer, 84532, reader);
  assert.equal(result.verifiedVia, "recovery");
  assert.equal(calls.length, 0);
});

test("deployment and gateway account types gate a contract signer before any challenge; an EOA passes for free", async () => {
  const eoa: SignerAdapter = { getAddress: async () => WALLET, signTypedData: async () => OPAQUE,
    describe: () => ({ provider: "local", accountType: "eoa" }) };
  const untouched = chain();
  let metadataReads = 0;
  const metadata = (types: string[]) => async () => { metadataReads += 1; return parseGatewayMetadata({ payerAccounts: { types, counterfactual: false } }); };
  await assertContractSignerUsable({ signer: eoa, chain: untouched.reader, metadata: metadata(["eoa"]), gatewayUrl: "https://g.example" });
  assert.equal(untouched.calls.length, 0);
  assert.equal(metadataReads, 0);
  assert.equal(await checkDeployment(eoa, untouched.reader), "not-applicable");

  await assert.rejects(assertContractSignerUsable({ signer: contractSigner(), chain: untouched.reader, metadata: metadata(["eoa"]), gatewayUrl: "https://g.example" }),
    code("DASKI_GATEWAY_EOA_ONLY"));
  assert.equal(untouched.calls.length, 0, "the gateway is asked before the chain");
  const empty = chain({ getCode: async () => "0x" });
  await assert.rejects(assertContractSignerUsable({ signer: contractSigner(), chain: empty.reader, metadata: metadata(["eoa", "contract"]), gatewayUrl: "https://g.example" }),
    (error: unknown) => code("DASKI_SIGNER_NOT_DEPLOYED")(error) && (error as CliError).remediation === NOT_DEPLOYED_REMEDIATION);
  assert.equal(await checkDeployment(contractSigner(), empty.reader), "not-deployed");
  const deployed = chain();
  await assertContractSignerUsable({ signer: contractSigner(), chain: deployed.reader, metadata: metadata(["eoa", "contract"]), gatewayUrl: "https://g.example" });
  assert.equal(await checkDeployment(contractSigner(), deployed.reader), "deployed");
});

test("buy refuses an undeployed or unverifiable contract signer before requesting a challenge", async () => {
  const home = mkdtempSync(join(tmpdir(), "daski-contract-buy-"));
  const previous = process.env.DASKI_HOME;
  process.env.DASKI_HOME = home;
  const requestFile = join(home, "request.json");
  writeFileSync(requestFile, "{}");
  try {
    const profile = DEFAULT_CONFIG.profiles.sandbox!;
    let toolCalls = 0;
    const context = { profile, profileName: "sandbox", payerAddress: WALLET, signer: contractSigner(),
      resolveSigner: async () => contractSigner(), chain: chain({ getCode: async () => "0x" }).reader,
      metadata: async () => parseGatewayMetadata({ payerAccounts: { types: ["eoa", "contract"], counterfactual: false } }),
      client: { callTool: async () => { toolCalls += 1; throw new Error("no challenge expected"); }, hasTool: async () => true },
      close: async () => {} } as unknown as CommandContext;
    await assert.rejects(runBuy({ providerAgentId: "1", outcomeId: "x", requestFile, json: true }, async () => context),
      code("DASKI_SIGNER_NOT_DEPLOYED"));
    assert.equal(toolCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.DASKI_HOME; else process.env.DASKI_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
