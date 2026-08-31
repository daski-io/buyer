/**
 * The gateway transport.
 *
 * Deliberately hand-rolled rather than delegated to `@x402/mcp`'s payment
 * wrapper: the CLI must sit between the challenge and the signature to run
 * §4, and must own the ambiguous-outcome path so an interrupted purchase gets
 * reconciled instead of re-signed. A wrapper that signs for us would take
 * both of those decisions away.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TransferAuthorization } from "@daski/x402-scheme";
import { CliError } from "../cli/errors.js";

export interface McpToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean | undefined;
  _meta?: Record<string, unknown> | undefined;
}

export interface GatewayCallLog {
  tool: string;
  at: string;
  /** Request arguments, already redacted by the caller. */
  request: unknown;
  response: unknown;
  isError: boolean;
}

export interface GatewayClientOptions {
  gatewayUrl: string;
  /** Every call is appended here; the conformance suite byte-logs from it. */
  onCall?: (entry: GatewayCallLog) => void;
  clientName?: string;
  clientVersion?: string;
}

/** The x402 v2 challenge as the gateway issues it. */
export interface PaymentChallenge {
  x402Version: number;
  resource: Record<string, unknown>;
  accepts: PaymentRequirement[];
  extensions?: Record<string, unknown> | undefined;
}

export interface PaymentRequirement {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: { assetTransferMethod?: string; name?: string; version?: string } | undefined;
}

/** The exact five-key payload the gateway accepts. Any other shape is refused. */
export interface PaymentSubmission {
  x402Version: number;
  resource: Record<string, unknown>;
  accepted: PaymentRequirement;
  payload: { authorization: TransferAuthorization; signature: string };
  extensions: Record<string, unknown>;
}

export class GatewayClient {
  readonly gatewayUrl: string;
  #client: Client | undefined;
  #tools: Set<string> | undefined;
  #callCount = 0;
  readonly #options: GatewayClientOptions;

  constructor(options: GatewayClientOptions) {
    this.gatewayUrl = options.gatewayUrl.replace(/\/$/, "");
    this.#options = options;
  }

  /** Daski tool calls made on this connection — the §6 budget is counted here. */
  get callCount(): number {
    return this.#callCount;
  }

  async connect(): Promise<void> {
    if (this.#client) return;
    const client = new Client({
      name: this.#options.clientName ?? "daski-pay",
      version: this.#options.clientVersion ?? "0.1.0",
    });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${this.gatewayUrl}/mcp`)) as never,
      );
    } catch (error) {
      throw new CliError({
        code: "DASKI_GATEWAY_UNREACHABLE",
        message: `Could not reach the gateway at ${this.gatewayUrl}: ${(error as Error).message}`,
        remediation:
          "Check network access and the profile's gatewayUrl, then run: daski doctor --json",
      });
    }
    this.#client = client;
  }

  async close(): Promise<void> {
    await this.#client?.close();
    this.#client = undefined;
  }

  /** Tool names the gateway actually advertises, cached per connection. */
  async availableTools(): Promise<Set<string>> {
    if (this.#tools) return this.#tools;
    await this.connect();
    const listed = await this.#client!.listTools();
    this.#tools = new Set(listed.tools.map((tool) => tool.name));
    return this.#tools;
  }

  async hasTool(name: string): Promise<boolean> {
    return (await this.availableTools()).has(name);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<McpToolResult> {
    await this.connect();
    this.#callCount += 1;
    const params: Record<string, unknown> = { name, arguments: args };
    if (meta) params._meta = meta;
    let result: McpToolResult;
    try {
      result = await this.#client!.callTool(params as never) as unknown as McpToolResult;
    } catch (error) {
      this.#options.onCall?.({
        tool: name, at: new Date().toISOString(),
        request: { args, meta }, response: { transportError: (error as Error).message },
        isError: true,
      });
      throw error;
    }
    this.#options.onCall?.({
      tool: name, at: new Date().toISOString(),
      request: { args, meta }, response: result, isError: Boolean(result.isError),
    });
    return result;
  }

  /** The first JSON object in a tool result's content, if there is one. */
  static json(result: McpToolResult): Record<string, unknown> | undefined {
    for (const item of result.content ?? []) {
      if (item.type !== "text" || typeof item.text !== "string") continue;
      try {
        const parsed: unknown = JSON.parse(item.text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Non-JSON text content is informational; keep looking.
      }
    }
    return undefined;
  }

  /** Reads the challenge from `_meta`, falling back to the content body. */
  static challenge(result: McpToolResult): PaymentChallenge | undefined {
    const fromMeta = result._meta?.["x402/payment-required"];
    const candidate = (fromMeta ?? GatewayClient.json(result)) as PaymentChallenge | undefined;
    return candidate && Array.isArray(candidate.accepts) ? candidate : undefined;
  }
}

/** Health and version, for `doctor`. Plain HTTP; no MCP session needed. */
export async function readiness(gatewayUrl: string, timeoutMs = 10_000): Promise<{
  reachable: boolean;
  status?: string | undefined;
  version?: string | undefined;
  error?: string | undefined;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${gatewayUrl.replace(/\/$/, "")}/health/ready`, {
      signal: controller.signal,
    });
    const body = await response.json() as { status?: string; version?: string };
    return { reachable: response.ok, status: body.status, version: body.version };
  } catch (error) {
    return { reachable: false, error: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
