/**
 * The gateway's public service registry: `/public/v3/services`.
 *
 * Each registered service lists its paid listings (`skills`, with their
 * contracts), the wallet-authorized actions its owners can run on an asset
 * they bought (`ownerActions`), the free skills its provider serves on its
 * own A2A endpoint (`freeSkills`), and the provider's agent card URL. These
 * are public reads: no signer, no MCP session.
 *
 * Everything here is display and routing data. Nothing read here is ever
 * signed or allowed to widen what a command does: an asset action is still
 * authorized and checked by the gateway, and a free skill is free by
 * construction.
 */
import { CliError } from "../cli/errors.js";

export type Fetch = typeof fetch;

const TIMEOUT_MS = 15_000;

export interface OwnerAction {
  actionId: string;
  name: string;
  description: string | null;
  assetType: string | null;
  destructive: boolean;
}

export interface FreeSkill {
  skillId: string;
  name: string;
  description: string | null;
  documentationUrl: string | null;
}

export interface ServiceSkill {
  skillId: string;
  assetType: string | null;
  paymentRequired: boolean;
  requiresAssetOwnership: boolean;
  name: string | null;
  description: string | null;
  documentationUrl: string | null;
}

export interface PublicService {
  providerAgentId: string;
  serviceId: string;
  slug: string;
  agentCardUrl: string | null;
  skills: ServiceSkill[];
  ownerActions: OwnerAction[];
  freeSkills: FreeSkill[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const text = (value: unknown): string | null => typeof value === "string" ? value : null;

function parseService(value: unknown): PublicService | undefined {
  if (!isRecord(value) || typeof value.providerAgentId !== "string" || typeof value.serviceId !== "string") {
    return undefined;
  }
  const service = isRecord(value.service) ? value.service : {};
  const skills = (Array.isArray(value.skills) ? value.skills : []).flatMap((item): ServiceSkill[] => {
    if (!isRecord(item) || typeof item.skillId !== "string") return [];
    const contract = isRecord(item.contract) ? item.contract : {};
    const presentation = isRecord(item.presentation) ? item.presentation : {};
    return [{
      skillId: item.skillId,
      assetType: text(contract.assetType),
      paymentRequired: contract.paymentRequired !== false,
      requiresAssetOwnership: contract.requiresAssetOwnership === true,
      name: text(presentation.name),
      description: text(presentation.description),
      documentationUrl: text(presentation.documentationUrl),
    }];
  });
  const ownerActions = (Array.isArray(value.ownerActions) ? value.ownerActions : []).flatMap((item): OwnerAction[] => {
    if (!isRecord(item) || typeof item.actionId !== "string") return [];
    return [{
      actionId: item.actionId,
      name: text(item.name) ?? item.actionId,
      description: text(item.description),
      assetType: text(item.assetType),
      // Anything not explicitly non-destructive is treated as destructive.
      destructive: item.destructive !== false,
    }];
  });
  const freeSkills = (Array.isArray(value.freeSkills) ? value.freeSkills : []).flatMap((item): FreeSkill[] => {
    if (!isRecord(item) || typeof item.skillId !== "string") return [];
    return [{
      skillId: item.skillId,
      name: text(item.name) ?? item.skillId,
      description: text(item.description),
      documentationUrl: text(item.documentationUrl),
    }];
  });
  return {
    providerAgentId: value.providerAgentId,
    serviceId: value.serviceId.toLowerCase(),
    slug: text(service.slug) ?? value.serviceId,
    agentCardUrl: text(value.agentCardUrl),
    skills,
    ownerActions,
    freeSkills,
  };
}

/** Plain HTTP reads of the gateway's public service registry. */
export class ServiceDirectory {
  readonly #gatewayUrl: string;
  readonly #fetch: Fetch;

  constructor(gatewayUrl: string, fetchImpl: Fetch = fetch) {
    this.#gatewayUrl = gatewayUrl.replace(/\/$/, "");
    this.#fetch = fetchImpl;
  }

  /** Every visible service a provider registered with this gateway. */
  async forProvider(providerAgentId: string): Promise<PublicService[]> {
    const url = `${this.#gatewayUrl}/public/v3/services?providerAgentId=${encodeURIComponent(providerAgentId)}&limit=100`;
    const body = await this.#read(url);
    const services = Array.isArray(body.services) ? body.services : [];
    return services.flatMap((item) => {
      const parsed = parseService(item);
      return parsed && parsed.providerAgentId === providerAgentId ? [parsed] : [];
    });
  }

  /** One service by its bytes32 id. */
  async byId(serviceId: string): Promise<PublicService> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(serviceId)) {
      throw new CliError({
        code: "DASKI_SERVICE_ID_INVALID",
        message: `"${serviceId}" is not a bytes32 service id.`,
        remediation: "Read the service id from the outcome: the gateway's daski_get_outcome tool returns it as serviceId.",
      });
    }
    const body = await this.#read(`${this.#gatewayUrl}/public/v3/services/${serviceId.toLowerCase()}`);
    const parsed = parseService(body);
    if (!parsed) throw unreadable(`${this.#gatewayUrl}/public/v3/services/${serviceId}`, "no service in the answer");
    return parsed;
  }

  async #read(url: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new CliError({
        code: "DASKI_SERVICE_REGISTRY_UNREACHABLE",
        message: `Could not read ${url}: ${(error as Error).message}`,
        remediation: "Check network access and the profile's gatewayUrl, then run: daski doctor --json",
      });
    }
    if (!response.ok) {
      throw new CliError({
        code: response.status === 404 ? "DASKI_SERVICE_NOT_FOUND" : "DASKI_SERVICE_REGISTRY_UNREACHABLE",
        message: `${url} answered HTTP ${response.status}.`,
        remediation: response.status === 404
          ? "Check the provider and service ids with the gateway's daski_list_outcomes tool."
          : "Retry in a moment; run daski doctor --json if it persists.",
      });
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw unreadable(url, (error as Error).message);
    }
    if (!isRecord(body)) throw unreadable(url, "the answer is not a JSON object");
    return body;
  }
}

function unreadable(url: string, reason: string): CliError {
  return new CliError({
    code: "DASKI_SERVICE_REGISTRY_UNREADABLE",
    message: `${url} answered with something this CLI cannot read: ${reason}.`,
    remediation: "Upgrade to the @daski/pay version the gateway pins, then run daski doctor --json.",
  });
}
