/**
 * A fake of the gateway's wallet-authorized MCP tools: the wallet challenge
 * as the gateway issues it (unbound for a query, provider-bound for an asset
 * action), and the authorized retry, whose signature is checked against the
 * payer before the canned answer is returned.
 */
import { canonicalHash, walletActionTypedData, type WalletActionChallenge } from "@daski/x402-scheme";
import { keccak256, stringToHex, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { CommandContext } from "../src/context.js";
import { assetActionName } from "../src/gateway/lifecycle.js";

export const PROFILE = DEFAULT_CONFIG.profiles.sandbox!;
export const ACCOUNT = privateKeyToAccount(`0x${"11".repeat(32)}`);
const ZERO = `0x${"00".repeat(32)}`;
const hash = (text: string): Hex => keccak256(stringToHex(text));

export function walletChallenge(args: {
  action: string;
  request: Record<string, unknown>;
  resource: string;
  providerAgentId?: string;
  payer?: string;
}): WalletActionChallenge {
  const now = Math.floor(Date.now() / 1000);
  const bound = args.providerAgentId !== undefined;
  return {
    domain: { name: "DaskiStandardWallet", version: "1", chainId: PROFILE.chainId },
    primaryType: "WalletActionAuthorizationV1",
    message: {
      payer: (args.payer ?? ACCOUNT.address).toLowerCase(),
      providerAgentId: args.providerAgentId ?? "0",
      serviceId: bound ? `0x${"ee".repeat(32)}` : ZERO,
      providerControlProfileHash: bound ? `0x${"01".repeat(32)}` : ZERO,
      servicingAdmissionHash: bound ? `0x${"02".repeat(32)}` : ZERO,
      actionCatalogHash: bound ? `0x${"03".repeat(32)}` : ZERO,
      actionCatalogSchemaHash: bound ? `0x${"04".repeat(32)}` : ZERO,
      actionDefinitionHash: bound ? `0x${"05".repeat(32)}` : ZERO,
      actionCatalogEpoch: bound ? 7 : 0,
      actionHash: hash(args.action),
      methodHash: hash("POST"),
      absoluteResourceUriHash: hash(`${PROFILE.gatewayUrl}${args.resource}`),
      requestHash: canonicalHash(args.request),
      audienceHash: hash(PROFILE.gatewayUrl),
      nonce: canonicalHash(`${args.action}-${now}-${Math.random()}`),
      issuedAt: now - 1,
      validBefore: now + 299,
    },
  };
}

export const mcp = (body: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, ...(isError ? { isError: true } : {}),
});

/** The MCP server's isolation of a provider result: base64 JSON under `untrustedResult`. */
export function isolated(result: unknown): Record<string, unknown> {
  const encoded = Buffer.from(JSON.stringify(result), "utf8");
  return { mediaType: "application/json", contentEncoding: "base64", byteLength: encoded.byteLength, content: encoded.toString("base64") };
}

export interface FakeCall { tool: string; args: Record<string, unknown> }

export type Answer = (args: Record<string, unknown>) => unknown;

/**
 * A gateway whose wallet tools issue a challenge, then check the signature
 * on the retry and return `answers[tool]`. Other tools answer from `reads`.
 */
export function fakeGateway(options: {
  answers?: Record<string, Answer>;
  reads?: Record<string, Answer>;
  /** Overrides the challenge a tool issues, e.g. to bind another provider. */
  challenge?: Record<string, (args: Record<string, unknown>) => WalletActionChallenge>;
  tools?: string[];
}) {
  const calls: FakeCall[] = [];
  const issued = new Map<string, WalletActionChallenge>();
  const client = {
    hasTool: async (name: string) => (options.tools ?? ["daski_list_assets", "daski_use_asset", "daski_get_order_status",
      "daski_get_order_access"]).includes(name),
    callTool: async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      if (tool === "daski_list_assets" || tool === "daski_use_asset") {
        if (!args.authorization) {
          const challenge = options.challenge?.[tool]?.(args) ?? (tool === "daski_list_assets"
            ? walletChallenge({ action: "list-assets", resource: "/wallet/assets",
              request: { providerAgentId: args.providerAgentId, limit: args.limit, cursor: args.cursor } })
            : walletChallenge({ action: assetActionName(String(args.providerAgentId), String(args.actionId),
              args.input as Record<string, unknown>),
              resource: "/wallet/assets/action", providerAgentId: String(args.providerAgentId),
              request: { actionId: args.actionId, providerAssetId: args.providerAssetId, input: args.input } }));
          issued.set(tool, challenge);
          return mcp({ authorizationRequired: true, code: "WALLET_AUTHORIZATION_REQUIRED", challenge });
        }
        const authorization = args.authorization as { message: Record<string, unknown>; signature: Hex };
        const challenge = issued.get(tool)!;
        const typed = walletActionTypedData({ ...challenge, message: authorization.message });
        const valid = await verifyTypedData({ address: ACCOUNT.address, ...(typed as object), signature: authorization.signature } as never);
        if (!valid) return mcp({ code: "WALLET_ACCESS_DENIED", message: "Wallet authorization rejected" }, true);
        const answer = options.answers?.[tool]?.(args);
        return answer && typeof answer === "object" && "content" in (answer as object) ? answer : mcp(answer);
      }
      const read = options.reads?.[tool];
      if (!read) throw new Error(`unexpected tool ${tool}`);
      const answer = read(args);
      return answer && typeof answer === "object" && "content" in (answer as object) ? answer : mcp(answer);
    },
  };
  return { client, calls };
}

export function fakeContext(client: unknown, extra: Record<string, unknown> = {}): CommandContext {
  const signer = {
    getAddress: async () => ACCOUNT.address,
    describe: () => ({ provider: "local", accountType: "eoa", conformance: "verified" }),
    signTypedData: async (data: unknown) => ACCOUNT.signTypedData(data as never),
  };
  return {
    profile: PROFILE, profileName: "sandbox", payerAddress: ACCOUNT.address, signer,
    resolveSigner: async () => signer, client, close: async () => {}, ...extra,
  } as unknown as CommandContext;
}
