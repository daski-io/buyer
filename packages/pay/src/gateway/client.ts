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
import { CLI_VERSION } from "../version.js";

export interface McpToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean | undefined;
  /** MCP structured tool output (spec 2025-06-18). The gateway carries every payload here. */
  structuredContent?: unknown;
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
      version: this.#options.clientVersion ?? CLI_VERSION,
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

  /**
   * The tool result's JSON payload. `structuredContent` is authoritative when
   * present (MCP structured tool output); the first JSON object in a text
   * block is the compatibility fallback. From gateway v0.28.0 (2026-09-01)
   * until the text copy was restored, ordinary results carried their payload
   * in `structuredContent` alone with a one-line summary in text, so a reader
   * that stopped at text saw nothing — and `@daski/pay` 0.1.0 did exactly that.
   */
  static json(result: McpToolResult): Record<string, unknown> | undefined {
    if (isRecord(result.structuredContent)) return result.structuredContent;
    for (const item of result.content ?? []) {
      if (item.type !== "text" || typeof item.text !== "string") continue;
      try {
        const parsed: unknown = JSON.parse(item.text);
        if (isRecord(parsed)) return parsed;
      } catch {
        // Non-JSON text content is informational; keep looking.
      }
    }
    return undefined;
  }

  /**
   * The x402 challenge in a tool result. Three places, in order: the x402 MCP
   * transport's `_meta["x402/payment-required"]`; the prepare tool's body,
   * which nests the challenge under `paymentRequired` beside its `preflight`;
   * and a bare PaymentRequired body, which the unpaid buy call returns.
   */
  static challenge(result: McpToolResult): PaymentChallenge | undefined {
    const fromMeta = result._meta?.["x402/payment-required"];
    if (isChallenge(fromMeta)) return fromMeta;
    const body = GatewayClient.json(result);
    const nested = body?.paymentRequired;
    if (isChallenge(nested)) return nested;
    return isChallenge(body) ? body : undefined;
  }

  /** The prepare tool's `preflight` block, when the result carries one. */
  static preflight(result: McpToolResult): Record<string, unknown> | undefined {
    const body = GatewayClient.json(result);
    const preflight = body?.preflight;
    return isRecord(preflight) ? preflight : undefined;
  }

  /**
   * A success result whose payload this client cannot find. That is a
   * protocol mismatch between the CLI and the gateway, never a refusal, and
   * it must never be reported as "not found" or "rejected".
   */
  static unreadable(result: McpToolResult): boolean {
    return !result.isError && GatewayClient.json(result) === undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isChallenge(value: unknown): value is PaymentChallenge {
  return isRecord(value) && Array.isArray(value.accepts);
}

/**
 * What a result looked like, for an error report. Results carry no key
 * material, so a bounded text preview is safe to print.
 */
export function describeResult(result: McpToolResult): Record<string, unknown> {
  const content = result.content ?? [];
  return {
    isError: Boolean(result.isError),
    hasStructuredContent: isRecord(result.structuredContent),
    contentTypes: content.map((item) => item.type),
    textPreview: content
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => (item.text as string).slice(0, 200)),
  };
}

/**
 * The gateway answered without an error and this CLI found no payload. The
 * remediation depends on whether a signature has already left the process.
 */
export function unreadableResultError(
  toolName: string,
  result: McpToolResult,
  options: { afterSubmit?: boolean | undefined } = {},
): CliError {
  return new CliError({
    code: "DASKI_GATEWAY_RESULT_UNREADABLE",
    message:
      `The gateway answered ${toolName} without an error, but this CLI found no JSON ` +
      "payload in the result: neither structuredContent nor a JSON text block.",
    remediation: options.afterSubmit
      ? "Do not re-run `daski buy`: the signature was submitted and the payment may have " +
        "settled. The intent is recorded in the order store. Upgrade to the @daski/pay " +
        "version the gateway's /skills/setup.md pins, run `daski doctor --json`, and " +
        "check the payer's order history before any new purchase."
      : "Nothing was signed. This CLI and the gateway disagree about the result shape: " +
        "upgrade to the @daski/pay version the gateway's /skills/setup.md pins, then " +
        "re-run `daski doctor --json`, which checks that gateway results are readable.",
    details: { tool: toolName, gateway: describeResult(result) },
  });
}

export interface GatewayProtocolProbe {
  reachable: boolean;
  tools: string[];
  /** The read-only tool whose payload this client could read, or null when none. */
  readableVia: string | null;
  error?: string | undefined;
}

/** The surface the probe needs, so `doctor` can be tested without a network. */
export interface ProbeTarget {
  availableTools(): Promise<Set<string>>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): Promise<void>;
}

/**
 * One read-only MCP round trip for `doctor`: list the tools, then read a
 * payload through a read-only tool with this client's own parser. A gateway
 * whose results this CLI cannot read blocks every purchase, and
 * `/health/ready` cannot see that: on 2026-09-03 a CLI that passed doctor
 * could not complete a single call.
 */
export async function probeGatewayProtocol(target: ProbeTarget): Promise<GatewayProtocolProbe> {
  try {
    const tools = [...await target.availableTools()].sort();
    const attempts: [string, Record<string, unknown>, (body: Record<string, unknown>) => boolean][] = [
      ["daski_get_setup_guide", { topic: "setup" }, (body) => typeof body.markdown === "string"],
      ["daski_list_outcomes", { limit: 1 }, (body) => Array.isArray(body.outcomes)],
    ];
    let readableVia: string | null = null;
    for (const [name, args, accept] of attempts) {
      if (!tools.includes(name)) continue;
      const result = await target.callTool(name, args);
      const body = GatewayClient.json(result);
      if (!result.isError && body && accept(body)) {
        readableVia = name;
        break;
      }
    }
    return { reachable: true, tools, readableVia };
  } catch (error) {
    return { reachable: false, tools: [], readableVia: null, error: (error as Error).message };
  } finally {
    await target.close().catch(() => undefined);
  }
}

/** The buyer CLI release a gateway pins, from its `/.well-known/mcp.json`. */
export interface PinnedBuyerCli {
  package: string;
  version: string;
  install?: string | undefined;
}

/**
 * Reads the gateway's pinned buyer CLI. Gateways before 2026-09-04 publish no
 * `buyerCli`; that reads as `null`, never as an error, because the pin is
 * advisory to the gateway's own operation and the doctor must not block on a
 * field the gateway does not have.
 */
export async function pinnedBuyerCli(
  gatewayUrl: string,
  timeoutMs = 10_000,
): Promise<PinnedBuyerCli | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${gatewayUrl.replace(/\/$/, "")}/.well-known/mcp.json`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json() as { buyerCli?: unknown };
    const pin = body.buyerCli as Partial<PinnedBuyerCli> | undefined;
    if (!pin || typeof pin !== "object") return null;
    if (typeof pin.package !== "string" || typeof pin.version !== "string") return null;
    return {
      package: pin.package,
      version: pin.version,
      install: typeof pin.install === "string" ? pin.install : undefined,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compares two `major.minor.patch` versions. Returns a negative number when
 * `installed` is older than `pinned`, zero when equal, positive when newer,
 * and `null` when either is not a plain release version (a build from source
 * reports `0.0.0-unknown`; a pre-release is not compared).
 */
export function compareReleaseVersions(installed: string, pinned: string): number | null {
  const parse = (value: string): number[] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const a = parse(installed);
  const b = parse(pinned);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! - b[index]!;
  }
  return 0;
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
