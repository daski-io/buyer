/**
 * §4.1 check 4 — independent splitter evidence.
 *
 * The address a challenge asks us to pay must be corroborated twice, by
 * sources that are not the challenge: the outcome's own catalog entry, and
 * the chain manifest at `.well-known/daski-chain.json`. Both are cached with a
 * TTL so the check costs at most one round trip per outcome per window, and
 * neither cache is ever consulted to *satisfy* the check when it is stale.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAddress, type Address } from "viem";
import type { SplitterEvidence } from "@daski/x402-scheme";
import { CliError } from "../cli/errors.js";
import { daskiHome } from "../paths.js";
import { GatewayClient, unreadableResultError } from "./client.js";

/** How long catalog evidence stays fresh. Short: splitters can be re-listed. */
export const CATALOG_TTL_SECONDS = 300;

interface CacheEntry<T> {
  fetchedAt: number;
  value: T;
}

interface CacheFile {
  version: 1;
  outcomes: Record<string, CacheEntry<OutcomeSummary>>;
  manifests: Record<string, CacheEntry<ChainManifest>>;
}

export interface OutcomeSummary {
  providerAgentId: string;
  outcomeId: string;
  payTo: Address;
  splitterAddress: Address;
  token: Address;
  pricingMode: "fixed" | "dynamic" | string;
  fixedGrossAmount?: string | undefined;
  bindingProfile?: string | undefined;
  providerAudience?: string | undefined;
  absoluteResourceUri?: string | undefined;
  /** Human-facing terms, used to build the approval summary. */
  terms?: Record<string, unknown> | undefined;
  commissionBps?: number | undefined;
  serviceName?: string | undefined;
  skillName?: string | undefined;
  requestSchema?: Record<string, unknown> | undefined;
}

export interface ChainManifest {
  chainId: number;
  outcomes: {
    providerAgentId: string;
    outcomeId: string;
    payTo: string;
    splitter?: { splitterAddress?: string } | undefined;
  }[];
}

const cachePath = (): string => join(daskiHome(), "cache.json");

function readCache(): CacheFile {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), "utf8")) as CacheFile;
    if (parsed.version !== 1) throw new Error("shape");
    return { version: 1, outcomes: parsed.outcomes ?? {}, manifests: parsed.manifests ?? {} };
  } catch {
    return { version: 1, outcomes: {}, manifests: {} };
  }
}

function writeCache(file: CacheFile): void {
  const path = cachePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function fresh<T>(entry: CacheEntry<T> | undefined, now: number): T | undefined {
  return entry && now - entry.fetchedAt < CATALOG_TTL_SECONDS ? entry.value : undefined;
}

/**
 * The catalog reader. One instance per command run, so the TTL cache and the
 * call budget are shared across every check a single purchase performs.
 */
export class Catalog {
  readonly #client: GatewayClient;
  readonly #now: () => number;

  constructor(client: GatewayClient, now: () => number = () => Math.floor(Date.now() / 1_000)) {
    this.#client = client;
    this.#now = now;
  }

  /** `daski_get_outcome`, cached. This is also the price and terms source. */
  async getOutcome(providerAgentId: string, outcomeId: string): Promise<OutcomeSummary> {
    const key = `${this.#client.gatewayUrl}|${providerAgentId}|${outcomeId}`;
    const cache = readCache();
    const cached = fresh(cache.outcomes[key], this.#now());
    if (cached) return cached;

    const result = await this.#client.callTool("daski_get_outcome", {
      providerAgentId,
      outcomeId,
    });
    // A success answer this client cannot read is a protocol mismatch, and
    // saying "no such outcome" about it sent operators to a catalog that
    // showed the outcome present and healthy (2026-09-03).
    if (GatewayClient.unreadable(result)) throw unreadableResultError("daski_get_outcome", result);
    const body = GatewayClient.json(result);
    if (result.isError || !body) {
      const gatewayCode = typeof body?.code === "string" ? body.code : "OUTCOME_NOT_FOUND";
      if (gatewayCode !== "OUTCOME_NOT_FOUND") {
        throw new CliError({
          code: gatewayCode,
          message: typeof body?.message === "string"
            ? body.message
            : `The gateway refused daski_get_outcome for ${providerAgentId}/${outcomeId}.`,
          remediation: typeof body?.next_action === "string"
            ? body.next_action
            : "Run `daski doctor --json`, then retry.",
          details: { gateway: body },
        });
      }
      throw new CliError({
        code: "DASKI_OUTCOME_NOT_FOUND",
        message: `The gateway has no outcome ${providerAgentId}/${outcomeId}.`,
        remediation:
          "List what is purchasable with the gateway's daski_list_outcomes tool, " +
          "then retry with a provider id and outcome id from that list.",
      });
    }
    const splitter = body.splitter as { splitterAddress?: string } | undefined;
    if (typeof body.payTo !== "string" || typeof splitter?.splitterAddress !== "string") {
      throw new CliError({
        code: "DASKI_OUTCOME_MISSING_SPLITTER",
        message: `Outcome ${providerAgentId}/${outcomeId} does not publish a splitter address.`,
        remediation:
          "Without independent splitter evidence the purchase cannot be validated. " +
          "Report this to the gateway operator.",
      });
    }
    const service = body.service as { name?: string } | undefined;
    const skill = body.skill as { name?: string } | undefined;
    const summary: OutcomeSummary = {
      providerAgentId,
      outcomeId,
      payTo: getAddress(body.payTo),
      splitterAddress: getAddress(splitter.splitterAddress),
      token: getAddress(String(body.token)),
      pricingMode: String(body.pricingMode),
      fixedGrossAmount: typeof body.fixedGrossAmount === "string" ? body.fixedGrossAmount : undefined,
      bindingProfile: typeof body.bindingProfile === "string" ? body.bindingProfile : undefined,
      providerAudience: typeof body.providerAudience === "string" ? body.providerAudience : undefined,
      absoluteResourceUri:
        typeof body.absoluteResourceUri === "string" ? body.absoluteResourceUri : undefined,
      terms: body.terms as Record<string, unknown> | undefined,
      commissionBps: typeof body.commissionBps === "number" ? body.commissionBps : undefined,
      serviceName: service?.name,
      skillName: skill?.name,
      requestSchema: body.requestSchema as Record<string, unknown> | undefined,
    };
    cache.outcomes[key] = { fetchedAt: this.#now(), value: summary };
    writeCache(cache);
    return summary;
  }

  /** `.well-known/daski-chain.json`, cached. The second, independent source. */
  async chainManifest(): Promise<ChainManifest> {
    const key = this.#client.gatewayUrl;
    const cache = readCache();
    const cached = fresh(cache.manifests[key], this.#now());
    if (cached) return cached;

    let manifest: ChainManifest;
    try {
      const response = await fetch(`${this.#client.gatewayUrl}/.well-known/daski-chain.json`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      manifest = await response.json() as ChainManifest;
    } catch (error) {
      throw new CliError({
        code: "DASKI_CHAIN_MANIFEST_UNAVAILABLE",
        message:
          `Could not read ${this.#client.gatewayUrl}/.well-known/daski-chain.json: ` +
          `${(error as Error).message}`,
        remediation:
          "The splitter allowlist needs this manifest as its second, independent " +
          "source. Without it no purchase can be validated. Check connectivity, " +
          "then run: daski doctor --json",
      });
    }
    if (!Array.isArray(manifest.outcomes)) {
      throw new CliError({
        code: "DASKI_CHAIN_MANIFEST_MALFORMED",
        message: "The chain manifest does not list any outcomes.",
        remediation: "Report this to the gateway operator; purchases cannot be validated.",
      });
    }
    cache.manifests[key] = { fetchedAt: this.#now(), value: manifest };
    writeCache(cache);
    return manifest;
  }

  /** The two-source evidence the policy validator consumes. */
  async splitterEvidence(providerAgentId: string, outcomeId: string): Promise<SplitterEvidence> {
    const [outcome, manifest] = await Promise.all([
      this.getOutcome(providerAgentId, outcomeId),
      this.chainManifest(),
    ]);
    const listed = manifest.outcomes.find(
      (entry) => entry.providerAgentId === providerAgentId && entry.outcomeId === outcomeId,
    );
    if (!listed) {
      throw new CliError({
        code: "DASKI_OUTCOME_NOT_IN_CHAIN_MANIFEST",
        message:
          `${providerAgentId}/${outcomeId} is offered by the gateway but is not ` +
          "listed in .well-known/daski-chain.json.",
        remediation:
          "One source offers it and the other does not, so the splitter cannot be " +
          "corroborated. Do not purchase; report this to the gateway operator.",
      });
    }
    const fromManifest = listed.splitter?.splitterAddress ?? listed.payTo;
    return {
      fromOutcome: outcome.splitterAddress,
      fromChainManifest: getAddress(String(fromManifest)),
    };
  }
}
