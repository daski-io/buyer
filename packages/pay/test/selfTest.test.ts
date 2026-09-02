/**
 * The doctor self-test is what stands between "the adapter returned 65 bytes"
 * and "the gateway will accept this". It must pass a correct signer, and it
 * must fail — with the right reason — each way a wrapper can be wrong:
 * claiming an address it did not sign with, emitting the high-s twin,
 * returning garbage, and throwing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { hexToBigInt, numberToHex, parseSignature, serializeSignature, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  isClosedTransferWithAuthorizationTypes,
  type SignerAdapter,
  type TypedDataRequest,
} from "@daski/x402-scheme";
import { LOW_S_MAX, runSignerSelfTest, selfTestVector } from "../src/signers/selfTest.js";

const CHAIN_ID = 84532;
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// A fixed key so the run is reproducible. It holds nothing anywhere.
const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

function signer(overrides: Partial<SignerAdapter> = {}): SignerAdapter {
  return {
    getAddress: async () => account.address,
    signTypedData: (payload: TypedDataRequest) => account.signTypedData(payload as never),
    describe: () => ({ provider: "test", accountType: "eoa" }),
    ...overrides,
  };
}

test("a correct EOA signer passes", async () => {
  const result = await runSignerSelfTest(signer(), CHAIN_ID);
  assert.deepEqual(result, { passed: true, recovered: account.address, lowS: true });
});

test("the vector has the shape of a purchase and can never be one", () => {
  const vector = selfTestVector(account.address, CHAIN_ID);
  assert.equal(isClosedTransferWithAuthorizationTypes(vector.types), true,
    "the exact type set a purchase signs, so an adapter that mishandles it is caught");
  assert.equal(vector.primaryType, "TransferWithAuthorization");
  assert.equal(vector.domain.name, "DaskiDoctor");
  assert.equal(vector.domain.chainId, CHAIN_ID);
  assert.equal(vector.domain.verifyingContract, "0x0000000000000000000000000000000000000000",
    "no token contract will ever verify this domain");
  assert.equal(vector.message.from, account.address);
  assert.equal(vector.message.to, "0x0000000000000000000000000000000000000000");
  assert.equal(vector.message.value, 0n);
  assert.equal(vector.message.validBefore, 0n, "the window is closed before it opens");
  assert.equal(LOW_S_MAX, SECP256K1_N / 2n);
});

test("an adapter that reports an address it did not sign with fails on recovery", async () => {
  const impostor = privateKeyToAccount(generatePrivateKey()).address;
  const result = await runSignerSelfTest(signer({ getAddress: async () => impostor }), CHAIN_ID);
  assert.equal(result.passed, false);
  assert.equal(result.recovered, account.address, "recovery names the key that actually signed");
  assert.equal(result.lowS, true, "the signature itself was fine; the claim was not");
  assert.match(result.reason ?? "", /recovered-address mismatch/);
});

test("a wrapper that emits the high-s twin fails the low-s check", async () => {
  const highS = signer({
    async signTypedData(payload) {
      const { r, s, yParity } = parseSignature(await account.signTypedData(payload as never));
      // (r, n - s) with the recovery bit flipped recovers to the same key: the
      // malleable twin the gateway refuses.
      return serializeSignature({
        r,
        s: numberToHex(SECP256K1_N - hexToBigInt(s), { size: 32 }),
        yParity: yParity ^ 1,
      });
    },
  });
  const result = await runSignerSelfTest(highS, CHAIN_ID);
  assert.equal(result.passed, false);
  assert.equal(result.lowS, false);
  assert.equal(result.recovered, account.address,
    "the twin still recovers to the right key, so low-s is the only failure");
  assert.match(result.reason ?? "", /high-s/);
});

test("a signature that is not 65 bytes is malformed, not recovered", async () => {
  const short = signer({ signTypedData: async () => "0x1234" as Hex });
  const result = await runSignerSelfTest(short, CHAIN_ID);
  assert.deepEqual(
    { passed: result.passed, recovered: result.recovered, lowS: result.lowS },
    { passed: false, recovered: null, lowS: false },
  );
  assert.match(result.reason ?? "", /malformed signature/);
});

test("a signer that throws fails the test instead of crashing doctor", async () => {
  const offline = signer({
    signTypedData: async () => { throw new Error("hsm offline"); },
  });
  const result = await runSignerSelfTest(offline, CHAIN_ID);
  assert.equal(result.passed, false);
  assert.equal(result.recovered, null);
  assert.equal(result.lowS, false);
  assert.match(result.reason ?? "", /the signer threw: hsm offline/);
});

test("a signer that cannot even report an address fails the same way", async () => {
  const broken = signer({
    getAddress: async () => { throw new Error("no wallet configured"); },
  });
  const result = await runSignerSelfTest(broken, CHAIN_ID);
  assert.equal(result.passed, false);
  assert.match(result.reason ?? "", /the signer threw: no wallet configured/);
});
