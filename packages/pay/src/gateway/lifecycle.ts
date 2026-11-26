/**
 * The lifecycle round trip: ask, validate, sign, retry.
 *
 * The gateway hands out a short-lived challenge; §4.1 check 8 decides whether
 * it describes the call we actually intend to make; only then does the wallet
 * see it. The handle alone is never authority.
 */
import {
  orderActionTypedData,
  validateOrderActionChallenge,
  validateWalletActionChallenge,
  walletActionTypedData,
  type OrderAction,
  type SignerAdapter,
} from "@daski/x402-scheme";
import type { Address } from "viem";
import { CliError } from "../cli/errors.js";
import {
  describeResult,
  GatewayClient,
  gatewayRefusalRemediation,
  isRetryableGatewayCode,
  reviewHeldForOperator,
  unreadableResultError,
  type McpToolResult,
} from "./client.js";

export interface LifecycleCallOptions {
  client: GatewayClient;
  signer: SignerAdapter;
  toolName: string;
  action: OrderAction;
  orderHandle: string;
  request: Record<string, unknown>;
  chainId: number;
  /** The gateway URL, which is also the audience. */
  gatewayUrl: string;
  nowSeconds?: number;
}

/**
 * Runs one authorized lifecycle call. Two gateway calls: the challenge, then
 * the authorized retry.
 */
export async function callAuthorizedLifecycleTool(
  options: LifecycleCallOptions,
): Promise<Record<string, unknown>> {
  const { client, toolName, orderHandle, request } = options;
  const challengeResult = await client.callTool(toolName, { orderHandle, request });
  const challengeBody = GatewayClient.json(challengeResult);
  if (!challengeBody) {
    throw lifecycleFailure(toolName, challengeResult, orderHandle);
  }
  // A gateway that answers without asking for authorization has already done
  // the work; there is nothing to sign.
  if (challengeBody.authorizationRequired !== true) {
    if (challengeResult.isError) throw lifecycleFailure(toolName, challengeResult, orderHandle);
    return challengeBody;
  }

  const challenge = validateOrderActionChallenge(challengeBody.challenge, {
    orderHandle,
    action: options.action,
    gatewayUrl: options.gatewayUrl,
    request,
    chainId: options.chainId,
    ...(options.nowSeconds === undefined ? {} : { nowSeconds: options.nowSeconds }),
  });
  const signature = await options.signer.signTypedData(
    orderActionTypedData(challenge, options.chainId, options.gatewayUrl),
  );
  const authorized = await client.callTool(toolName, {
    orderHandle,
    request,
    authorization: { ...challenge, signature },
  });
  const body = GatewayClient.json(authorized);
  if (authorized.isError || !body) throw lifecycleFailure(toolName, authorized, orderHandle);
  return body;
}

export interface WalletQueryOptions {
  client: GatewayClient;
  signer: SignerAdapter;
  toolName: string;
  /** The wallet action name, e.g. `list-orders`. */
  action: string;
  payer: Address;
  request: Record<string, unknown>;
  chainId: number;
  gatewayUrl: string;
  nowSeconds?: number;
  /** The refusal to raise instead of the order-centred default. */
  failure?: ((result: McpToolResult) => CliError) | undefined;
}

/**
 * Runs one payer-scoped wallet query. The unbound variant is asserted: a
 * wallet challenge must not smuggle a provider binding past a read.
 */
export async function callWalletQuery(
  options: WalletQueryOptions,
): Promise<Record<string, unknown>> {
  const { client, toolName, payer, request } = options;
  const fail = options.failure ?? ((result: McpToolResult) => lifecycleFailure(toolName, result));
  const challengeResult = await client.callTool(toolName, { payer, ...request });
  const challengeBody = GatewayClient.json(challengeResult);
  if (!challengeBody) throw fail(challengeResult);
  if (challengeBody.authorizationRequired !== true) {
    if (challengeResult.isError) throw fail(challengeResult);
    return challengeBody;
  }

  const challenge = validateWalletActionChallenge(challengeBody.challenge, options.chainId, {
    payer,
    action: options.action,
    audience: options.gatewayUrl,
    request,
    requireProviderBinding: false,
    ...(options.nowSeconds === undefined ? {} : { nowSeconds: options.nowSeconds }),
  });
  const signature = await options.signer.signTypedData(walletActionTypedData(challenge));
  const authorized = await client.callTool(toolName, {
    payer,
    ...request,
    authorization: { message: challenge.message, signature },
  });
  const body = GatewayClient.json(authorized);
  if (authorized.isError || !body) throw fail(authorized);
  return body;
}

export interface AssetActionCallOptions {
  client: GatewayClient;
  signer: SignerAdapter;
  payer: Address;
  providerAgentId: string;
  actionId: string;
  /** The provider's asset id, a lowercase UUID. */
  providerAssetId: string;
  input: Record<string, unknown>;
  chainId: number;
  gatewayUrl: string;
  nowSeconds?: number;
}

/**
 * The wallet action an asset action signs, as the gateway names it: a
 * destructive action's confirmation and a recovery have their own names, so
 * a signature for one can never stand in for another.
 */
export function assetActionName(providerAgentId: string, actionId: string, input: Record<string, unknown>): string {
  return input.operation === "confirm-destructive"
    ? `confirm-destructive:${providerAgentId}:${actionId}`
    : input.operation === "recover-action"
      ? `recover-action:${providerAgentId}:${actionId}`
      : `use-asset:${providerAgentId}:${actionId}`;
}

/**
 * Runs one asset action through `daski_use_asset`, the MCP tool's own two
 * calls: the challenge, then the authorized retry. The challenge must be
 * bound to the provider named here, for exactly the action and request this
 * CLI is about to send; only then does the wallet see it.
 */
export async function callAssetAction(options: AssetActionCallOptions): Promise<Record<string, unknown>> {
  const { client, payer, providerAgentId, actionId, providerAssetId, input } = options;
  const request = { actionId, providerAssetId, input };
  const args = { payer, providerAgentId, actionId, providerAssetId, input };
  const challengeResult = await client.callTool(ASSET_ACTION_TOOL, args);
  const challengeBody = GatewayClient.json(challengeResult);
  if (!challengeBody || challengeResult.isError || challengeBody.authorizationRequired !== true) {
    throw assetActionFailure(challengeResult, options);
  }
  const challenge = validateWalletActionChallenge(challengeBody.challenge, options.chainId, {
    payer,
    action: assetActionName(providerAgentId, actionId, input),
    audience: options.gatewayUrl,
    request,
    requireProviderBinding: true,
    providerAgentId,
    ...(options.nowSeconds === undefined ? {} : { nowSeconds: options.nowSeconds }),
  });
  const signature = await options.signer.signTypedData(walletActionTypedData(challenge));
  const authorized = await client.callTool(ASSET_ACTION_TOOL, {
    ...args,
    authorization: { message: challenge.message, signature },
  });
  const body = GatewayClient.json(authorized);
  if (authorized.isError || !body) throw assetActionFailure(authorized, options);
  return body;
}

export const ASSET_ACTION_TOOL = "daski_use_asset";

/** The gateway's refusal of an asset action, with a next step in command terms. */
export function assetActionFailure(
  result: McpToolResult,
  target: { providerAgentId: string; actionId: string; gatewayUrl: string },
  tool = ASSET_ACTION_TOOL,
): CliError {
  if (GatewayClient.unreadable(result)) return unreadableResultError(tool, result);
  const body = GatewayClient.json(result);
  const code = typeof body?.code === "string" ? body.code : "DASKI_ASSET_ACTION_REFUSED";
  const owner = `${target.gatewayUrl}/public/v3/services?providerAgentId=${target.providerAgentId}`;
  const remediation: Record<string, string> = {
    ASSET_ACTION_NOT_ADMITTED:
      `Provider ${target.providerAgentId} has no admitted action "${target.actionId}". Use an actionId ` +
      `from the service's ownerActions at ${owner}. Nothing was run.`,
    ASSET_ACTION_REJECTED:
      "The provider rejected the action, most often because --input does not match what the action " +
      `takes. Read the action's description in ownerActions at ${owner}, then retry with --input.`,
    WALLET_ACCESS_DENIED:
      "The gateway refused the wallet authorization: the asset must belong to this payer, bought from " +
      `this provider with this wallet. Check it with: daski asset list --provider ${target.providerAgentId} --json`,
    WALLET_QUERY_INVALID:
      "The gateway refused the request's shape: --asset must be the asset's providerAssetId (a UUID) " +
      "or its identifier, and --input a JSON object.",
    WALLET_RATE_LIMITED: "The provider is limiting asset actions for this wallet. Wait a minute, then retry.",
    WALLET_TEMPORARILY_UNAVAILABLE: "The wallet service could not complete the request right now. Retry the same command in a moment.",
    ASSET_DESTRUCTIVE_CONFIRMATION_REQUIRED:
      "This action is destructive and must be staged, then confirmed. Run it without an operation first; " +
      "the answer names the confirm command.",
    ASSET_DESTRUCTIVE_DELAY_ACTIVE:
      "The staged action cannot be confirmed yet. Wait until its earliestExecutionAt, then run the same confirm command.",
  };
  return new CliError({
    code,
    message: typeof body?.message === "string" ? body.message : `${tool} was refused by the gateway.`,
    remediation: remediation[code] ??
      (typeof body?.next_action === "string" ? body.next_action : "Run daski doctor --json, then retry."),
    details: {
      tool,
      gateway: body ?? describeResult(result),
      ...(code === "WALLET_TEMPORARILY_UNAVAILABLE" || code === "WALLET_RATE_LIMITED" ? { retryable: true } : {}),
    },
  });
}

/** The gateway's answer to a lifecycle or read call, as an operator-facing error. */
export function lifecycleFailure(toolName: string, result: McpToolResult, orderHandle?: string | undefined): CliError {
  // No payload in a success answer is a shape disagreement, not a refusal.
  if (GatewayClient.unreadable(result)) return unreadableResultError(toolName, result);
  const body = GatewayClient.json(result);
  const code = typeof body?.code === "string" ? body.code : "DASKI_LIFECYCLE_CALL_FAILED";
  const message = typeof body?.message === "string"
    ? body.message
    : `${toolName} was rejected by the gateway.`;
  return new CliError({
    code,
    message,
    remediation: gatewayRefusalRemediation(code, body, orderHandle) ?? (typeof body?.next_action === "string"
      ? body.next_action
      : `Run \`daski order status ${orderHandle ?? "<handle>"}\` to see the order's current state.`),
    details: {
      tool: toolName,
      gateway: body ?? describeResult(result),
      ...(isRetryableGatewayCode(code) && !reviewHeldForOperator(body) ? { retryable: true } : {}),
    },
  });
}
