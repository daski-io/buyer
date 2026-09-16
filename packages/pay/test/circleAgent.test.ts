/**
 * The Circle agent wallet adapter: it runs the vendor CLI with an argument
 * array, hands it exactly the typed data it was given, keeps only the
 * signature, and describes itself as a contract account pending conformance.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { getAddress, type Hex } from "viem";
import type { TypedDataRequest } from "@daski/x402-scheme";
import { CliError } from "../src/cli/errors.js";
import {
  circleChainName, createCircleAgentSigner, signatureFromOutput, vendorEnvironment, walletAddressesFromListing,
  type CommandResult, type CommandRunner,
} from "../src/signers/circleAgent.js";
import { hasErc6492Suffix, isBoundedSignature } from "../src/signers/signature.js";

const code = (wanted: string) => (error: unknown): boolean => error instanceof CliError && error.code === wanted;
const WALLET = "0x161f376d31f7f575e9c4cb865a50c3b0fec6ddc4";
const OTHER = "0x2222222222222222222222222222222222222222";
const SIGNATURE = `0x${"ab".repeat(100)}`;

const TYPED_DATA: TypedDataRequest = {
  domain: { name: "DaskiDoctor", version: "1", chainId: 84532, verifyingContract: "0x0000000000000000000000000000000000000000" },
  types: { TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ] },
  primaryType: "TransferWithAuthorization",
  message: { from: getAddress(WALLET), to: "0x0000000000000000000000000000000000000000", value: 0n, validAfter: 0n, validBefore: 0n,
    nonce: `0x${"00".repeat(32)}` },
};

/** A scripted vendor CLI that records every argument array it receives. */
function fakeCircle(script: (args: readonly string[]) => Partial<CommandResult> | Error) {
  const calls: (readonly string[])[] = [];
  const run: CommandRunner = async (args, options) => {
    assert.equal(options.timeoutMs, 30_000, "every command has the 30-second deadline");
    calls.push(args);
    const answer = script(args);
    if (answer instanceof Error) throw answer;
    return { status: 0, signal: null, timedOut: false, stdout: "", ...answer };
  };
  return { run, calls };
}

const listing = (...addresses: string[]) => JSON.stringify({ wallets: addresses.map((address) => ({ address, blockchain: "BASE-SEPOLIA", type: "agent" })) });

test("chain names map from the profile chain id and nothing else", () => {
  assert.equal(circleChainName(8453), "BASE");
  assert.equal(circleChainName(84532), "BASE-SEPOLIA");
  assert.throws(() => circleChainName(1), code("DASKI_CIRCLE_AGENT_CHAIN_UNSUPPORTED"));
});

test("wallet addresses are found in the listing whatever its envelope", () => {
  assert.deepEqual(walletAddressesFromListing([{ address: WALLET }]), [getAddress(WALLET)]);
  assert.deepEqual(walletAddressesFromListing({ wallets: [{ address: WALLET }, { address: WALLET }] }), [getAddress(WALLET)]);
  assert.deepEqual(walletAddressesFromListing({ data: { wallets: [{ address: WALLET }, { address: OTHER }] } }),
    [getAddress(WALLET), getAddress(OTHER)]);
  assert.deepEqual(walletAddressesFromListing({ wallets: [{ address: "not-an-address" }] }), []);
});

test("the signature is the bounded hex the vendor printed, bare or in JSON", () => {
  assert.equal(signatureFromOutput(`${SIGNATURE}\n`), SIGNATURE);
  assert.equal(signatureFromOutput(JSON.stringify({ signature: SIGNATURE })), SIGNATURE);
  assert.equal(signatureFromOutput("Signed!\n"), undefined);
  assert.equal(signatureFromOutput(`0x${"ab".repeat(4097)}`), undefined, "more than 4,096 bytes is not a signature");
  assert.equal(isBoundedSignature("0xabc"), false, "odd hex is refused");
  assert.equal(hasErc6492Suffix(`0x${"11".repeat(40)}${"6492".repeat(16)}` as Hex), true);
  assert.equal(hasErc6492Suffix(SIGNATURE as Hex), false);
});

test("the address comes from the wallet list and the signature from sign typed-data, with argument arrays", async () => {
  const { run, calls } = fakeCircle((args) =>
    args[1] === "list" ? { stdout: listing(WALLET) } : { stdout: `${SIGNATURE}\n` });
  const signer = await createCircleAgentSigner({ chainId: 84532, run });
  assert.equal(await signer.getAddress(), getAddress(WALLET));
  assert.deepEqual(signer.describe(), { provider: "circle-agent", accountType: "contract", conformance: "candidate-pending-conformance" });
  assert.deepEqual(calls[0], ["wallet", "list", "--chain", "BASE-SEPOLIA", "--type", "agent", "--output", "json"]);

  const signature = await signer.signTypedData(TYPED_DATA);
  assert.equal(signature, SIGNATURE, "the signature is the vendor's, byte for byte");
  const sign = calls[1]!;
  assert.deepEqual([sign[0], sign[1], sign[2], ...sign.slice(4)],
    ["wallet", "sign", "typed-data", "--address", getAddress(WALLET), "--chain", "BASE-SEPOLIA", "--quiet"]);
  const sent = JSON.parse(sign[3]!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent).sort(), ["domain", "message", "primaryType", "types"], "typed data only, as one argument");
  assert.deepEqual((sent.types as Record<string, unknown>).EIP712Domain, [
    { name: "name", type: "string" }, { name: "version", type: "string" },
    { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
  ], "the v4 form Circle requires: EIP712Domain derived from the domain, nothing else added");
  assert.deepEqual(sent.domain, TYPED_DATA.domain);
  assert.deepEqual((sent.message as Record<string, unknown>).value, "0", "bigints travel as decimal strings");
});

test("wallet selection: none, several, an explicit address, and an unknown one", async () => {
  await assert.rejects(createCircleAgentSigner({ chainId: 84532, run: fakeCircle(() => ({ stdout: listing() })).run }),
    (error: unknown) => code("DASKI_CIRCLE_AGENT_WALLET_MISSING")(error) && /circle wallet create/.test((error as CliError).remediation));
  await assert.rejects(createCircleAgentSigner({ chainId: 84532, run: fakeCircle(() => ({ stdout: listing(WALLET, OTHER) })).run }),
    code("DASKI_CIRCLE_AGENT_WALLET_AMBIGUOUS"));
  const chosen = await createCircleAgentSigner({ chainId: 84532, address: OTHER, run: fakeCircle(() => ({ stdout: listing(WALLET, OTHER) })).run });
  assert.equal(await chosen.getAddress(), getAddress(OTHER));
  await assert.rejects(createCircleAgentSigner({ chainId: 84532, address: "0x3333333333333333333333333333333333333333",
    run: fakeCircle(() => ({ stdout: listing(WALLET) })).run }), code("DASKI_CIRCLE_AGENT_WALLET_NOT_FOUND"));
});

test("vendor failures are named without repeating the vendor's output", async () => {
  const missing = Object.assign(new Error("spawn circle ENOENT"), { code: "ENOENT" });
  await assert.rejects(createCircleAgentSigner({ chainId: 84532, run: fakeCircle(() => missing).run }),
    (error: unknown) => code("DASKI_CIRCLE_CLI_MISSING")(error) && /@circle-fin\/cli/.test((error as CliError).remediation));
  await assert.rejects(createCircleAgentSigner({ chainId: 84532, run: fakeCircle(() => ({ status: 1, stdout: "SECRET-VENDOR-TEXT" })).run }),
    (error: unknown) => code("DASKI_CIRCLE_CLI_FAILED")(error) && !JSON.stringify((error as CliError).toJSON()).includes("SECRET-VENDOR-TEXT"));
  await assert.rejects(createCircleAgentSigner({ chainId: 84532, run: fakeCircle(() => ({ status: null, signal: "SIGKILL", timedOut: true })).run }),
    code("DASKI_CIRCLE_CLI_TIMEOUT"));
  await assert.rejects(createCircleAgentSigner({ chainId: 84532, run: fakeCircle(() => ({ stdout: "not json" })).run }),
    code("DASKI_CIRCLE_CLI_OUTPUT_INVALID"));
  const garbled = await createCircleAgentSigner({ chainId: 84532,
    run: fakeCircle((args) => (args[1] === "list" ? { stdout: listing(WALLET) } : { stdout: "Signed: yes\n" })).run });
  await assert.rejects(garbled.signTypedData(TYPED_DATA), code("DASKI_CIRCLE_CLI_OUTPUT_INVALID"));
  const oversized = await createCircleAgentSigner({ chainId: 84532,
    run: fakeCircle((args) => (args[1] === "list" ? { stdout: listing(WALLET) } : { stdout: `0x${"ab".repeat(4097)}` })).run });
  await assert.rejects(oversized.signTypedData(TYPED_DATA), code("DASKI_CIRCLE_CLI_OUTPUT_INVALID"));
});

test("an ERC-6492 (counterfactual) signature is refused with the not-deployed code, bare or in JSON", async () => {
  const wrapped = `0x${"11".repeat(40)}${"6492".repeat(16)}`;
  for (const output of [`${wrapped}\n`, JSON.stringify({ signature: wrapped })]) {
    const signer = await createCircleAgentSigner({ chainId: 84532,
      run: fakeCircle((args) => (args[1] === "list" ? { stdout: listing(WALLET) } : { stdout: output })).run });
    await assert.rejects(signer.signTypedData(TYPED_DATA),
      (error: unknown) => code("DASKI_SIGNER_NOT_DEPLOYED")(error) && /ERC-6492/.test((error as CliError).message) &&
        /zero-value transfer/.test((error as CliError).remediation), output);
  }
});

test("the vendor CLI's environment carries no DASKI_ variable, and everything else", () => {
  const scrubbed = vendorEnvironment({ PATH: "/usr/bin", HOME: "/home/u", DASKI_PAYER_PRIVATE_KEY: "0x11", DASKI_KEYSTORE_PASSPHRASE_FILE: "/p", DASKI_HOME: "/h", CIRCLE_KEEP: "1" });
  assert.deepEqual(scrubbed, { PATH: "/usr/bin", HOME: "/home/u", CIRCLE_KEEP: "1" });
});

test("a fake circle on PATH is spawned directly with the argument array intact and without any DASKI_ variable", { skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "daski-fake-circle-"));
  const argsFile = join(directory, "args.txt");
  const envFile = join(directory, "env.txt");
  const script = join(directory, "circle");
  writeFileSync(script, [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > "${argsFile}"`,
    `env > "${envFile}"`,
    'if [ "$2" = "list" ]; then',
    `  printf '%s' '${listing(WALLET)}'`,
    "else",
    `  printf '%s\\n' '${SIGNATURE}'`,
    "fi",
  ].join("\n"));
  chmodSync(script, 0o755);
  const previous = Object.fromEntries(["PATH", "DASKI_PAYER_PRIVATE_KEY", "DASKI_KEYSTORE_PASSPHRASE_FILE", "DASKI_HOME", "CIRCLE_TEST_KEEP"]
    .map((name) => [name, process.env[name]]));
  process.env.PATH = `${directory}${delimiter}${previous.PATH ?? ""}`;
  process.env.DASKI_PAYER_PRIVATE_KEY = `0x${"11".repeat(32)}`;
  process.env.DASKI_KEYSTORE_PASSPHRASE_FILE = join(directory, "passphrase");
  process.env.DASKI_HOME = directory;
  process.env.CIRCLE_TEST_KEEP = "kept";
  try {
    const signer = await createCircleAgentSigner({ chainId: 8453 });
    assert.equal(await signer.getAddress(), getAddress(WALLET));
    assert.equal(await signer.signTypedData(TYPED_DATA), SIGNATURE);
    const received = readFileSync(argsFile, "utf8").split("\n").filter((line) => line.length > 0);
    assert.deepEqual([received[0], received[1], received[2], ...received.slice(4)],
      ["wallet", "sign", "typed-data", "--address", getAddress(WALLET), "--chain", "BASE", "--quiet"]);
    assert.deepEqual(JSON.parse(received[3]!).domain, TYPED_DATA.domain, "the typed data arrived as one argument, unshelled");
    const names = readFileSync(envFile, "utf8").split("\n").map((line) => line.split("=")[0]!);
    assert.ok(!names.some((name) => name.startsWith("DASKI_")), `the vendor saw ${names.filter((name) => name.startsWith("DASKI_")).join(", ")}`);
    assert.ok(!readFileSync(envFile, "utf8").includes("11".repeat(32)), "the key never reached the vendor's environment");
    assert.ok(names.includes("PATH"));
    assert.ok(names.includes("CIRCLE_TEST_KEEP"), "unrelated variables are passed through");
  } finally {
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(directory, { recursive: true, force: true });
  }
});
