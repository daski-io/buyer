/**
 * `daski asset action` is `daski_use_asset`: a provider-bound wallet
 * challenge this CLI validates before the wallet signs it, then the
 * authorized retry. The result goes to a mode-600 file and never to stdout.
 * `--asset` also takes an identifier. `daski asset list` is
 * `daski_list_assets`. What an order delivered comes from
 * `daski order deliverables` (deliverables.test.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalHash, walletActionTypedData } from "@daski/x402-scheme";
import { CliError } from "../src/cli/errors.js";
import { assetAction, assetList } from "../src/commands/asset.js";
import { assetActionName, callAssetAction } from "../src/gateway/lifecycle.js";
import { ACCOUNT, PROFILE, fakeContext, fakeGateway, isolated, mcp, walletChallenge } from "./walletFakes.js";

const code = (wanted: string) => (error: unknown): boolean => error instanceof CliError && error.code === wanted;
/** The x402-scheme validator's refusal code. */
const refusal = (error: unknown): string | undefined => (error as { detail?: { code?: string } }).detail?.code;
const ENV = ["DASKI_HOME", "DASKI_PAYER_PRIVATE_KEY"] as const;
const ASSET = "8d42e3f9-1111-4222-8333-944455556666";
const KEY_ID = "inf_0123456789abcdef01234567";
const SECRET = "sk-the-secret-never-printed";
const EXECUTION = `0x${"ab".repeat(32)}`;

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  const home = mkdtempSync(join(tmpdir(), "daski-asset-"));
  for (const key of ENV) delete process.env[key];
  process.env.DASKI_HOME = home;
  try {
    await run(home);
  } finally {
    for (const key of ENV) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(home, { recursive: true, force: true });
  }
}

/** The perform answer as the MCP server relays it. */
function performed(args: Record<string, unknown>, result: unknown, status = "completed", errorClass: string | null = null) {
  return {
    providerAgentId: args.providerAgentId, payer: ACCOUNT.address.toLowerCase(), actionExecutionId: EXECUTION, status,
    responseNonce: `0x${"cd".repeat(32)}`, requestHash: canonicalHash({ actionId: args.actionId,
      providerAssetId: args.providerAssetId, input: args.input }), errorClass,
    untrustedResult: isolated(result),
  };
}

const keyResult = { keyId: KEY_ID, status: "active", apiKey: SECRET, keyPrefix: "sk-th", next: "Call the models." };
const assets = (list: Record<string, unknown>[], nextCursor: string | null = null) => ({
  providers: [{ providerAgentId: "8327", availability: "available", assets: list, nextCursor }], warning: null,
});
const inferenceAsset = { providerAssetId: ASSET, serviceSlug: "ai-inference", type: "inference-account", identifier: KEY_ID,
  status: "active", createdAt: "2026-11-26T00:00:00Z", expiresAt: null };

test("the wallet action an asset action signs is the gateway's name for it", () => {
  assert.equal(assetActionName("8327", "get-inference-key", { keyId: KEY_ID }), "use-asset:8327:get-inference-key");
  assert.equal(assetActionName("8327", "delete-server", { operation: "confirm-destructive" }), "confirm-destructive:8327:delete-server");
  assert.equal(assetActionName("8327", "get-server", { operation: "recover-action" }), "recover-action:8327:get-server");
});

test("an asset action signs only a challenge bound to the named provider, action and request", async () => {
  const input = { keyId: KEY_ID };
  const { client, calls } = fakeGateway({ answers: { daski_use_asset: (args) => performed(args, keyResult) } });
  const body = await callAssetAction({ client: client as never, signer: fakeContext(client).signer, payer: ACCOUNT.address,
    providerAgentId: "8327", actionId: "get-inference-key", providerAssetId: ASSET, input, chainId: PROFILE.chainId,
    gatewayUrl: PROFILE.gatewayUrl });
  assert.equal(body.status, "completed");
  assert.deepEqual(calls.map((call) => Object.keys(call.args).sort()), [
    ["actionId", "input", "payer", "providerAgentId", "providerAssetId"],
    ["actionId", "authorization", "input", "payer", "providerAgentId", "providerAssetId"],
  ], "the MCP tool's own arguments, and the authorization on the retry");

  for (const [label, challenge, wanted] of [
    ["another provider", (args: Record<string, unknown>) => walletChallenge({ action: "use-asset:8327:get-inference-key",
      resource: "/wallet/assets/action", providerAgentId: "10763", request: { actionId: args.actionId, providerAssetId: args.providerAssetId, input: args.input } }),
      "DASKI_WALLET_PROVIDER_MISMATCH"],
    ["an unbound challenge", (args: Record<string, unknown>) => walletChallenge({ action: "use-asset:8327:get-inference-key",
      resource: "/wallet/assets/action", request: { actionId: args.actionId, providerAssetId: args.providerAssetId, input: args.input } }),
      "DASKI_WALLET_PROVIDER_BINDING_MISSING"],
    ["another action", (args: Record<string, unknown>) => walletChallenge({ action: "use-asset:8327:rotate-inference-key",
      resource: "/wallet/assets/action", providerAgentId: "8327", request: { actionId: args.actionId, providerAssetId: args.providerAssetId, input: args.input } }),
      "DASKI_WALLET_ACTION_MISMATCH"],
    ["another request", (args: Record<string, unknown>) => walletChallenge({ action: "use-asset:8327:get-inference-key",
      resource: "/wallet/assets/action", providerAgentId: "8327", request: { actionId: args.actionId, providerAssetId: args.providerAssetId, input: {} } }),
      "DASKI_WALLET_REQUEST_HASH_MISMATCH"],
  ] as const) {
    const refusing = fakeGateway({ challenge: { daski_use_asset: challenge } });
    await assert.rejects(callAssetAction({ client: refusing.client as never, signer: fakeContext(refusing.client).signer,
      payer: ACCOUNT.address, providerAgentId: "8327", actionId: "get-inference-key", providerAssetId: ASSET, input,
      chainId: PROFILE.chainId, gatewayUrl: PROFILE.gatewayUrl }), (error: unknown) => refusal(error) === wanted, label);
    assert.equal(refusing.calls.length, 1, `${label}: nothing was signed or sent`);
  }
});

test("the result goes to a mode-600 file, replacing a wider one, and only its path and field names are printed", async () => {
  await withHome(async (home) => {
    const { client, calls } = fakeGateway({ answers: { daski_use_asset: (args) => performed(args, keyResult) } });
    const output = join(home, "key.json");
    writeFileSync(output, "old", { mode: 0o644 });
    chmodSync(output, 0o644);
    const printed = await assetAction({ json: true, actionId: "get-inference-key", providerAgentId: "8327", asset: ASSET.toUpperCase(),
      input: { keyId: KEY_ID }, output }, async () => fakeContext(client));
    assert.equal(printed.resultWrittenTo, output);
    assert.equal(printed.providerAssetId, ASSET, "a UUID is sent lowercase, without a list");
    assert.deepEqual(printed.resultFields, ["keyId", "status", "apiKey", "keyPrefix", "next"]);
    assert.ok(!JSON.stringify(printed).includes(SECRET), "the secret is not in the output");
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), keyResult);
    if (process.platform !== "win32") assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.deepEqual(calls.map((call) => call.tool), ["daski_use_asset", "daski_use_asset"]);
  });
});

test("an output the result cannot be written to is refused before anything runs", async () => {
  await withHome(async (home) => {
    const { client, calls } = fakeGateway({ answers: { daski_use_asset: (args) => performed(args, keyResult) } });
    await assert.rejects(assetAction({ json: true, actionId: "get-inference-key", providerAgentId: "8327", asset: ASSET,
      input: { keyId: KEY_ID }, output: join(home, "missing-dir", "key.json") }, async () => fakeContext(client)),
      code("DASKI_OUTPUT_UNWRITABLE"));
    await assert.rejects(assetAction({ json: true, actionId: "get-inference-key", providerAgentId: "8327", asset: ASSET,
      input: { keyId: KEY_ID }, output: home }, async () => fakeContext(client)), code("DASKI_OUTPUT_UNWRITABLE"));
    assert.equal(calls.length, 0);
  });
});

test("--asset takes an identifier, found in the payer's own asset list", async () => {
  await withHome(async (home) => {
    const { client, calls } = fakeGateway({ answers: {
      daski_list_assets: (args) => args.cursor === null
        ? assets([{ ...inferenceAsset, providerAssetId: "00000000-0000-4000-8000-000000000000", identifier: "inf_other" }], "page-2")
        : assets([inferenceAsset]),
      daski_use_asset: (args) => performed(args, keyResult),
    } });
    const printed = await assetAction({ json: true, actionId: "get-inference-key", providerAgentId: "8327", asset: KEY_ID,
      input: { keyId: KEY_ID }, output: join(home, "k.json") }, async () => fakeContext(client));
    assert.equal(printed.providerAssetId, ASSET);
    assert.deepEqual(printed.asset, { identifier: KEY_ID, type: "inference-account", serviceSlug: "ai-inference" });
    const lists = calls.filter((call) => call.tool === "daski_list_assets" && call.args.authorization);
    assert.deepEqual(lists.map((call) => [call.args.providerAgentId, call.args.cursor]), [["8327", null], ["8327", "page-2"]]);

    const missing = fakeGateway({ answers: { daski_list_assets: () => assets([]) } });
    await assert.rejects(assetAction({ json: true, actionId: "get-inference-key", providerAgentId: "8327", asset: "inf_nope" },
      async () => fakeContext(missing.client)),
      (error: unknown) => code("DASKI_ASSET_NOT_FOUND")(error) && /daski asset list --provider 8327/.test((error as CliError).remediation));
  });
});

test("the CLI signs the gateway's challenge itself, with any signer, and a signer that cannot sign says so", async () => {
  await withHome(async (home) => {
    // A challenge carrying the gateway's sign-ready proposal, which agrees with what the CLI recomputes.
    const { client, calls } = fakeGateway({
      challenge: { daski_use_asset: (args) => {
        const challenge = walletChallenge({ action: "use-asset:8327:get-inference-key", resource: "/wallet/assets/action",
          providerAgentId: "8327", request: { actionId: args.actionId, providerAssetId: args.providerAssetId, input: args.input } });
        const typed = walletActionTypedData(challenge);
        return { ...challenge, signRequest: { domain: challenge.domain, types: typed.types, primaryType: typed.primaryType,
          message: challenge.message } } as never;
      } },
      answers: { daski_use_asset: (args) => performed(args, keyResult) },
    });
    // A contract-account signer, as the Circle agent wallet is.
    const circle = fakeContext(client);
    circle.signer.describe = () => ({ provider: "circle-agent", accountType: "contract", conformance: "verified" }) as never;
    const printed = await assetAction({ json: true, actionId: "get-inference-key", providerAgentId: "8327", asset: ASSET,
      input: { keyId: KEY_ID }, output: join(home, "k.json") }, async () => circle);
    assert.equal(printed.status, "completed");
    assert.ok(calls[1]!.args.authorization, "the retry carries the CLI's own signature");

    const failing = fakeGateway({ answers: { daski_use_asset: () => { throw new Error("nothing may be sent"); } } });
    const broken = fakeContext(failing.client);
    broken.signer.describe = () => ({ provider: "circle-agent", accountType: "contract", conformance: "verified" }) as never;
    broken.signer.signTypedData = async () => { throw new CliError({ code: "DASKI_CIRCLE_AGENT_LOGIN_REQUIRED",
      message: "The Circle session expired.", remediation: "Log in with circle wallet login." }); };
    await assert.rejects(assetAction({ json: true, actionId: "get-inference-key", providerAgentId: "8327", asset: ASSET,
      input: { keyId: KEY_ID }, output: join(home, "k2.json") }, async () => broken), (error: unknown) => {
      const failure = error as CliError;
      assert.equal(failure.code, "DASKI_CIRCLE_AGENT_LOGIN_REQUIRED");
      assert.match(failure.message, /^The circle-agent signer could not sign the wallet authorization for the asset action/);
      assert.match(failure.remediation, /^Log in with circle wallet login\. Nothing was sent, so the asset action did not run\./);
      assert.match(failure.remediation, /There is no separate signing step/);
      return true;
    });
    assert.equal(failing.calls.filter((call) => call.args.authorization).length, 0, "nothing unsigned or half-signed was sent");
  });
});

test("an execution id that is not the gateway's shape never becomes part of a path, and errors never carry the result", async () => {
  await withHome(async (home) => {
    const { client } = fakeGateway({ answers: { daski_use_asset: (args) => ({ ...performed(args, keyResult), actionExecutionId: "../../escape" }) } });
    const printed = await assetAction({ json: true, actionId: "get-inference-key", providerAgentId: "8327", asset: ASSET,
      input: { keyId: KEY_ID } }, async () => fakeContext(client));
    assert.match(String(printed.resultWrittenTo), new RegExp(`^${join(home, "results")}/get-inference-key-[0-9a-f]{12}\\.json$`));

    const leaking = fakeGateway({ answers: { daski_use_asset: () => mcp({ code: "SOMETHING_NEW", message: "unexpected",
      untrustedResult: isolated(keyResult), result: keyResult }, true) } });
    await assert.rejects(assetAction({ json: true, actionId: "get-inference-key", providerAgentId: "8327", asset: ASSET,
      input: { keyId: KEY_ID } }, async () => fakeContext(leaking.client)), (error: unknown) => {
      const text = JSON.stringify((error as CliError).toJSON());
      return !text.includes(SECRET) && !text.includes(isolated(keyResult).content as string);
    });
  });
});

test("an identifier past the lookup's page limit is reported as such, not as missing", async () => {
  await withHome(async () => {
    const { client } = fakeGateway({ answers: { daski_list_assets: (args) =>
      assets([{ ...inferenceAsset, identifier: `inf_${String(args.cursor)}` }], `page-${Math.random()}`) } });
    await assert.rejects(assetAction({ json: true, actionId: "get-inference-key", providerAgentId: "8327", asset: "inf_far_away" },
      async () => fakeContext(client)), (error: unknown) => code("DASKI_ASSET_LIST_TOO_LONG")(error) &&
        /daski asset list --provider 8327 --cursor page-/.test((error as CliError).remediation));
  });
});

test("a destructive action is only staged, and the answer names the exact confirm command", async () => {
  await withHome(async (home) => {
    const { client } = fakeGateway({ answers: { daski_use_asset: (args) => {
      const { untrustedResult: _none, errorClass: _class, ...rest } = performed(args, null, "staged");
      return { ...rest, effectSummary: { serverId: "srv_1" }, confirmationHash: `0x${"ef".repeat(32)}`,
        earliestExecutionAt: 1_900_000_000, stageValidBefore: 1_900_000_600 };
    } } });
    const printed = await assetAction({ json: true, actionId: "delete-server", providerAgentId: "8327", asset: ASSET,
      input: { serverId: "srv_1" }, output: join(home, "x.json") }, async () => fakeContext(client));
    assert.equal(printed.status, "staged");
    assert.deepEqual(printed.effectSummary, { serverId: "srv_1" });
    assert.ok(String(printed.next).includes(`daski asset action --provider 8327 --asset ${ASSET} --action delete-server --input ` +
      `'{"operation":"confirm-destructive","actionExecutionId":"${EXECUTION}","confirmationHash":"0x${"ef".repeat(32)}"}' --json`));
  });
});

test("a failed action, and the gateway's refusals, carry their own next step", async () => {
  await withHome(async (home) => {
    const failing = fakeGateway({ answers: { daski_use_asset: (args) => {
      const { untrustedResult: _none, ...rest } = performed(args, null, "failed", "provider_retryable");
      return { ...rest, untrustedResult: isolated(null) };
    } } });
    await assert.rejects(assetAction({ json: true, actionId: "get-inference-key", providerAgentId: "8327", asset: ASSET,
      input: { keyId: KEY_ID }, output: join(home, "x.json") }, async () => fakeContext(failing.client)),
      (error: unknown) => code("DASKI_ASSET_ACTION_FAILED")(error) && (error as CliError).details.retryable === true);

    const refused = fakeGateway({ answers: { daski_use_asset: () => mcp({ code: "ASSET_ACTION_NOT_ADMITTED",
      message: "The wallet request could not be completed" }, true) } });
    await assert.rejects(assetAction({ json: true, actionId: "get-inference-ky", providerAgentId: "8327", asset: ASSET,
      output: join(home, "x.json") }, async () => fakeContext(refused.client)),
      (error: unknown) => code("ASSET_ACTION_NOT_ADMITTED")(error) &&
        (error as CliError).remediation.includes(`${PROFILE.gatewayUrl}/public/v3/services?providerAgentId=8327`));
  });
});

test("the target is --provider with --asset, and flags are checked before anything is called", async () => {
  const unreachable = async () => { throw new Error("no context may be built"); };
  await assert.rejects(assetAction({ json: true, actionId: "get-inference-key" }, unreachable),
    (error: unknown) => code("DASKI_ASSET_TARGET_REQUIRED")(error) &&
      (error as CliError).remediation.includes("daski order deliverables <handle> --json"));
  await assert.rejects(assetAction({ json: true, actionId: "get-inference-key", asset: ASSET }, unreachable), code("DASKI_FLAG_REQUIRED"));
  await assert.rejects(assetAction({ json: true, actionId: "Get Key", providerAgentId: "8327", asset: ASSET }, unreachable),
    code("DASKI_ASSET_ACTION_ID_INVALID"));
  await assert.rejects(assetAction({ json: true, actionId: "get-inference-key", providerAgentId: "x", asset: ASSET }, unreachable),
    code("DASKI_PROVIDER_ID_INVALID"));
});

test("asset list is daski_list_assets under an unbound wallet authorization", async () => {
  const { client, calls } = fakeGateway({ answers: { daski_list_assets: () => assets([inferenceAsset], "more") } });
  const printed = await assetList({ json: true, providerAgentId: "8327" }, async () => fakeContext(client));
  assert.deepEqual((printed.providers as { assets: unknown[] }[])[0]!.assets, [inferenceAsset]);
  assert.match(String(printed.next), /daski asset list --provider 8327 --cursor more --json/);
  assert.deepEqual(calls[0]!.args, { payer: ACCOUNT.address, providerAgentId: "8327", limit: 100, cursor: null });
  await assert.rejects(assetList({ json: true, cursor: "c" }, async () => { throw new Error("unreachable"); }), code("DASKI_FLAG_REQUIRED"));
  // A refused list is explained in asset terms, not as an order's.
  const denied = fakeGateway({ answers: { daski_list_assets: () => mcp({ code: "WALLET_ACCESS_DENIED", message: "Wallet authorization rejected" }, true) } });
  await assert.rejects(assetList({ json: true, providerAgentId: "8327" }, async () => fakeContext(denied.client)),
    (error: unknown) => code("WALLET_ACCESS_DENIED")(error) && !/order status/.test((error as CliError).remediation) &&
      (error as CliError).details.tool === "daski_list_assets");
  // A challenge that smuggles a provider binding into the list is refused.
  const smuggling = fakeGateway({ challenge: { daski_list_assets: (args) => walletChallenge({ action: "list-assets", resource: "/wallet/assets",
    providerAgentId: "8327", request: { providerAgentId: args.providerAgentId, limit: args.limit, cursor: args.cursor } }) } });
  await assert.rejects(assetList({ json: true, providerAgentId: "8327" }, async () => fakeContext(smuggling.client)),
    (error: unknown) => refusal(error) === "DASKI_WALLET_UNEXPECTED_PROVIDER_BINDING");
});
