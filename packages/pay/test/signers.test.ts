/**
 * The Circle adapter: it refuses without credentials, a wallet id, or the
 * SDK; it refuses smart-contract accounts; and for an EOA it forwards exactly
 * the typed data it was given — nothing added, nothing rewritten — and hands
 * back exactly the signature Circle returned.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress } from "viem";
import type { TypedDataRequest } from "@daski/x402-scheme";
import { CliError } from "../src/cli/errors.js";
import {
  createCircleSigner,
  serializeTypedData,
  type CircleModule,
  type CircleWallet,
} from "../src/signers/circle.js";
import { createSigner } from "../src/signers/index.js";

const ENV = ["CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET", "DASKI_CIRCLE_WALLET"] as const;
type EnvName = (typeof ENV)[number];

/** Runs `fn` with exactly these Circle variables set, restoring the environment after. */
async function withEnv<T>(values: Partial<Record<EnvName, string>>, fn: () => Promise<T>): Promise<T> {
  const previous: Partial<Record<EnvName, string>> = {};
  for (const name of ENV) {
    const before = process.env[name];
    if (before !== undefined) previous[name] = before;
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const name of ENV) {
      const before = previous[name];
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    }
  }
}

const CREDENTIALS = { CIRCLE_API_KEY: "test-api-key", CIRCLE_ENTITY_SECRET: "test-entity-secret" };
const WALLET_ID = "223d9a78-ca33-4cbd-ab83-8f083e3c045b";
// Lowercase, as a wallet API tends to return it; the adapter must checksum it.
const WALLET_ADDRESS = "0x161f376d31f7f575e9c4cb865a50c3b0fec6ddc4";
const SIGNATURE = `0x${"ab".repeat(64)}1b`;

interface FakeCalls {
  init: unknown[];
  getWallet: unknown[];
  signTypedData: unknown[];
}

/** A stand-in for `@circle-fin/developer-controlled-wallets` that records what it was asked. */
function fakeSdk(wallet: Partial<CircleWallet> = {}): { sdk: CircleModule; calls: FakeCalls } {
  const calls: FakeCalls = { init: [], getWallet: [], signTypedData: [] };
  const sdk: CircleModule = {
    initiateDeveloperControlledWalletsClient(config) {
      calls.init.push(config);
      return {
        async getWallet(input) {
          calls.getWallet.push(input);
          return {
            data: {
              wallet: {
                address: WALLET_ADDRESS, accountType: "EOA", blockchain: "BASE-SEPOLIA", ...wallet,
              },
            },
          };
        },
        async signTypedData(input) {
          calls.signTypedData.push(input);
          return { data: { signature: SIGNATURE } };
        },
      };
    },
  };
  return { sdk, calls };
}

const cliErrorWithCode = (code: string) => (error: unknown): boolean =>
  error instanceof CliError && error.code === code;

const AUTHORIZATION: TypedDataRequest = {
  domain: {
    name: "USDC", version: "2", chainId: 84532,
    verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  types: {
    TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" },
      { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization",
  message: {
    from: "0x1111111111111111111111111111111111111111",
    to: "0xE25be9CAAa546a55b2a2e8aF812E8Db51E3eDfd1",
    value: "9990000",
    validAfter: "0",
    validBefore: "1788214451",
    nonce: "0xa2fe873efb98107270107019a13434f7b65e84269d0ea5047b20b7a009525911",
  },
};

test("circle: without credentials it refuses before touching the SDK or the wallet", async () => {
  await withEnv({ DASKI_CIRCLE_WALLET: WALLET_ID }, async () => {
    const { sdk, calls } = fakeSdk();
    await assert.rejects(
      () => createCircleSigner({ sdk }),
      cliErrorWithCode("DASKI_CIRCLE_CREDENTIALS_UNSET"),
    );
    assert.equal(calls.init.length, 0, "no client is built without credentials");
  });
  await withEnv({ CIRCLE_API_KEY: "key-only", DASKI_CIRCLE_WALLET: WALLET_ID }, async () => {
    await assert.rejects(
      () => createCircleSigner({ sdk: fakeSdk().sdk }),
      cliErrorWithCode("DASKI_CIRCLE_CREDENTIALS_UNSET"),
      "both variables are required, not either",
    );
  });
});

test("circle: without a wallet id it refuses, and names the flag and the variable", async () => {
  await withEnv(CREDENTIALS, async () => {
    await assert.rejects(
      () => createCircleSigner({ sdk: fakeSdk().sdk }),
      (error: unknown) =>
        cliErrorWithCode("DASKI_CIRCLE_WALLET_UNSET")(error) &&
        /DASKI_CIRCLE_WALLET/.test((error as CliError).remediation) &&
        /--circle-wallet/.test((error as CliError).remediation),
    );
  });
});

test("circle: a missing SDK is a named error carrying the install command", async () => {
  await withEnv({ ...CREDENTIALS, DASKI_CIRCLE_WALLET: WALLET_ID }, async () => {
    await assert.rejects(
      () => createCircleSigner({
        sdk: async () => { throw new Error("Cannot find package '@circle-fin/developer-controlled-wallets'"); },
      }),
      (error: unknown) =>
        cliErrorWithCode("DASKI_CIRCLE_SDK_MISSING")(error) &&
        /npm install @circle-fin\/developer-controlled-wallets/.test((error as CliError).remediation),
    );
  });
});

test("circle: a smart-contract account is refused with the ERC-1271 explanation", async () => {
  await withEnv(CREDENTIALS, async () => {
    const { sdk, calls } = fakeSdk({ accountType: "SCA" });
    await assert.rejects(
      () => createCircleSigner({ wallet: WALLET_ID, sdk }),
      (error: unknown) =>
        cliErrorWithCode("DASKI_CIRCLE_SCA_UNSUPPORTED")(error) &&
        /ERC-1271/.test((error as CliError).message) &&
        /low-s ECDSA recovery/.test((error as CliError).message),
    );
    assert.equal(calls.signTypedData.length, 0, "an SCA wallet never gets to sign");
  });
});

test("circle: an EOA wallet reports its checksummed address and signs exactly what it was given", async () => {
  await withEnv(CREDENTIALS, async () => {
    const { sdk, calls } = fakeSdk();
    const signer = await createCircleSigner({ wallet: WALLET_ID, sdk });

    assert.deepEqual(calls.init, [{ apiKey: "test-api-key", entitySecret: "test-entity-secret" }],
      "the client is built from the environment credentials and nothing else");
    assert.deepEqual(calls.getWallet, [{ id: WALLET_ID }]);
    assert.equal(await signer.getAddress(), getAddress(WALLET_ADDRESS));
    assert.deepEqual(signer.describe(), {
      provider: "circle",
      accountType: "eoa",
      conformance: "candidate-pending-conformance",
    });

    const signature = await signer.signTypedData(AUTHORIZATION);
    assert.equal(signature, SIGNATURE, "the signature is Circle's, byte for byte");
    assert.equal(calls.signTypedData.length, 1);
    const call = calls.signTypedData[0] as { walletId: string; data: string; memo?: string };
    assert.equal(call.walletId, WALLET_ID);
    assert.equal(typeof call.data, "string", "Circle takes the typed data as a JSON string");
    const sent = JSON.parse(call.data) as Record<string, unknown>;
    assert.deepEqual(sent, AUTHORIZATION, "domain, types, primaryType, message — unchanged");
    assert.deepEqual(Object.keys(sent).sort(), ["domain", "message", "primaryType", "types"],
      "nothing beyond the four EIP-712 members is sent");
    assert.equal("EIP712Domain" in (sent.types as object), false,
      "EIP712Domain is derived from the domain, never declared");
  });
});

test("circle: bigint fields go out as decimal strings, the wire form of an authorization", () => {
  const sent = JSON.parse(serializeTypedData({
    ...AUTHORIZATION,
    message: { ...AUTHORIZATION.message, value: 9_990_000n, validAfter: 0n, validBefore: 1_788_214_451n },
  })) as { message: Record<string, unknown> };
  assert.deepEqual(sent.message, AUTHORIZATION.message);
});

test("circle: the wallet id may come from DASKI_CIRCLE_WALLET, and the flag wins over it", async () => {
  await withEnv({ ...CREDENTIALS, DASKI_CIRCLE_WALLET: WALLET_ID }, async () => {
    const fromEnv = fakeSdk();
    await createCircleSigner({ sdk: fromEnv.sdk });
    assert.deepEqual(fromEnv.calls.getWallet, [{ id: WALLET_ID }]);

    const fromFlag = fakeSdk();
    await createCircleSigner({ wallet: "flag-wallet", sdk: fromFlag.sdk });
    assert.deepEqual(fromFlag.calls.getWallet, [{ id: "flag-wallet" }]);
  });
});

test("createSigner routes kind \"circle\" to the Circle adapter", async () => {
  // Without credentials the adapter's first refusal is the proof of routing:
  // no other signer knows that code.
  await withEnv({}, async () => {
    await assert.rejects(
      () => createSigner({ kind: "circle", profile: "sandbox", circleWallet: WALLET_ID }),
      cliErrorWithCode("DASKI_CIRCLE_CREDENTIALS_UNSET"),
    );
  });
});

test("createSigner still refuses a signer it does not know, and now lists circle", async () => {
  await assert.rejects(
    () => createSigner({ kind: "ledger" as never, profile: "sandbox" }),
    (error: unknown) =>
      cliErrorWithCode("DASKI_SIGNER_UNKNOWN")(error) &&
      /local, cdp, circle/.test((error as CliError).remediation),
  );
});
