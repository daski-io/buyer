/**
 * Keys must never reach output. Nothing is supposed to pass one to a printer,
 * but a leaked key is unrecoverable, so the printer checks anyway.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactValue, redactText } from "../src/cli/redact.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

test("key-shaped fields are redacted by name whatever they contain", () => {
  const redacted = redactValue({
    privateKey: "hunter2",
    mnemonic: "correct horse battery staple",
    passphrase: "letmein",
    address: "0x161f376d31f7f575E9C4Cb865A50C3b0FEC6DDc4",
  }) as Record<string, string>;
  assert.equal(redacted.privateKey, "[redacted]");
  assert.equal(redacted.mnemonic, "[redacted]");
  assert.equal(redacted.passphrase, "[redacted]");
  assert.equal(redacted.address, "0x161f376d31f7f575E9C4Cb865A50C3b0FEC6DDc4",
    "an address is public and must survive");
});

test("hashes survive redaction", () => {
  // A private key and a hash are the same shape, and this CLI exists to print
  // hashes. Blanking them by shape would stop an operator checking the nonce
  // their own wallet signed.
  const nonce = "0xa2fe873efb98107270107019a13434f7b65e84269d0ea5047b20b7a009525911";
  const redacted = redactValue({
    authorizationNonce: nonce,
    requestHash: nonce,
    orderHandle: "ord_123",
  }) as Record<string, string>;
  assert.equal(redacted.authorizationNonce, nonce);
  assert.equal(redacted.requestHash, nonce);
  assert.equal(redacted.orderHandle, "ord_123");
});

test("a key placed in a secret-named field is redacted whatever its shape", () => {
  const redacted = redactValue({ privateKey: KEY, seed: KEY }) as Record<string, string>;
  assert.equal(redacted.privateKey, "[redacted]");
  assert.equal(redacted.seed, "[redacted]");
});

test("redaction recurses through arrays and nested objects", () => {
  const redacted = redactValue({
    calls: [{ request: { secret: "abc" } }, { request: { note: `raw ${KEY}` } }],
  }) as { calls: { request: Record<string, string> }[] };
  assert.equal(redacted.calls[0]!.request.secret, "[redacted]");
  assert.equal(redacted.calls[1]!.request.note, `raw ${KEY}`,
    "a hash-shaped value in a neutral field is left alone");
});

test("signatures are redacted only when asked", () => {
  const payload = { signature: `0x${"ab".repeat(65)}` };
  assert.equal(
    (redactValue(payload) as Record<string, string>).signature,
    payload.signature,
    "signatures are kept by default",
  );
  assert.equal(
    (redactValue(payload, { signatures: true }) as Record<string, string>).signature,
    "[redacted]",
  );
});

test("a BIP-39 style phrase is redacted", () => {
  const phrase = "abandon ability able about above absent absorb abstract absurd abuse access accident";
  assert.equal(redactText(`seed: ${phrase}`), "seed: [redacted]");
});

test("the fields the CLI exists to print survive redaction", () => {
  // Regression: `authorization` and `token` sound sensitive in other domains.
  // Here they are the EIP-3009 authorization that `sign-payment` prints and an
  // ERC-20 contract address. Blanking either makes the output useless.
  const payload = {
    payload: {
      authorization: {
        from: "0x1111111111111111111111111111111111111111",
        to: "0xE25be9CAAa546a55b2a2e8aF812E8Db51E3eDfd1",
        value: "9990000",
        validAfter: "0",
        validBefore: "1788214451",
        nonce: "0xa2fe873efb98107270107019a13434f7b65e84269d0ea5047b20b7a009525911",
      },
      signature: `0x${"ab".repeat(65)}`,
    },
    token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  };
  const redacted = redactValue(payload) as typeof payload;
  assert.deepEqual(redacted, payload);
});
