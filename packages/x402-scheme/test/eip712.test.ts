import assert from "node:assert/strict";
import { test } from "node:test";
import { hashTypedData } from "viem";
import { typedDataV4, type TypedDataRequest } from "../src/eip712.js";

const REQUEST: TypedDataRequest = {
  domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  types: { TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ] },
  primaryType: "TransferWithAuthorization",
  message: {
    from: "0x1111111111111111111111111111111111111111", to: "0x2222222222222222222222222222222222222222",
    value: 1n, validAfter: 0n, validBefore: 2n, nonce: `0x${"00".repeat(32)}`,
  },
};

test("typedDataV4 derives EIP712Domain from the domain's present fields, in the standard order", () => {
  const v4 = typedDataV4(REQUEST);
  assert.deepEqual(v4.types.EIP712Domain, [
    { name: "name", type: "string" }, { name: "version", type: "string" },
    { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
  ]);
  assert.deepEqual(Object.keys(v4.types), ["EIP712Domain", "TransferWithAuthorization"]);
  assert.deepEqual(v4.types.TransferWithAuthorization, REQUEST.types.TransferWithAuthorization);
  assert.equal(v4.domain, REQUEST.domain);
  assert.equal(v4.message, REQUEST.message);
  assert.equal("EIP712Domain" in REQUEST.types, false, "the input is not mutated");
});

test("a domain without a verifying contract yields only the fields it has", () => {
  const v4 = typedDataV4({ ...REQUEST, domain: { name: "DaskiStandardWallet", version: "1", chainId: 8453 } as never });
  assert.deepEqual(v4.types.EIP712Domain, [
    { name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" },
  ]);
});

test("the v4 form hashes to the same digest as the request", () => {
  assert.equal(hashTypedData(typedDataV4(REQUEST) as never), hashTypedData(REQUEST as never));
});
