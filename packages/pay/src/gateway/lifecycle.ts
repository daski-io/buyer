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
import { GatewayClient, type McpToolResult } from "./client.js";

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
    throw lifecycleFailure(toolName, challengeResult);
  }
  // A gateway that answers without asking for authorization has already done
  // the work; there is nothing to sign.
  if (challengeBody.authorizationRequired !== true) {
    if (challengeResult.isError) throw lifecycleFailure(toolName, challengeResult);
    return challengeBody;
  }

  const challenge = validateOrderActionChallenge(challengeBody.challenge, {
    orderHandle,
    action: options.action,
    gatewayUrl: options.gatewayUrl,
    request,
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
  if (authorized.isError || !body) throw lifecycleFailure(toolName, authorized);
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
}

/**
 * Runs one payer-scoped wallet query. The unbound variant is asserted: a
 * wallet challenge must not smuggle a provider binding past a read.
 */
export async function callWalletQuery(
  options: WalletQueryOptions,
): Promise<Record<string, unknown>> {
  const { client, toolName, payer, request } = options;
  const challengeResult = await client.callTool(toolName, { payer, ...request });
  const challengeBody = GatewayClient.json(challengeResult);
  if (!challengeBody) throw lifecycleFailure(toolName, challengeResult);
  if (challengeBody.authorizationRequired !== true) {
    if (challengeResult.isError) throw lifecycleFailure(toolName, challengeResult);
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
  if (authorized.isError || !body) throw lifecycleFailure(toolName, authorized);
  return body;
}

function lifecycleFailure(toolName: string, result: McpToolResult): CliError {
  const body = GatewayClient.json(result);
  const code = typeof body?.code === "string" ? body.code : "DASKI_LIFECYCLE_CALL_FAILED";
  const message = typeof body?.message === "string"
    ? body.message
    : `${toolName} was rejected by the gateway.`;
  return new CliError({
    code,
    message,
    remediation: typeof body?.next_action === "string"
      ? body.next_action
      : `Run \`daski order status <handle>\` to see the order's current state.`,
    details: { tool: toolName, gateway: body ?? null },
  });
}
