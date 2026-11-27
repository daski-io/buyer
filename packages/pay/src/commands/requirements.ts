/**
 * `daski requirements` — what an outcome's request still needs, before any
 * quote. It reads the gateway's requirements tool (the provider's signed
 * intake): the fields still missing or wrong, the selectors to supply first,
 * and the values only the provider knows, such as a server's planId or the
 * inference terms version to accept. Nothing is signed, quoted or ordered.
 *
 * On the sandbox (2026-11-27) an agent without such a command found the
 * required fields by sending trial purchases to `daski buy`.
 */
import { CliError } from "../cli/errors.js";
import { loadConfig } from "../config.js";
import { GatewayClient, unreadableResultError } from "../gateway/client.js";
import { readRequestFile } from "./buy.js";

const TOOL = "daski_get_outcome_requirements";
const PROVIDER_ID = /^[1-9]\d*$/;
const OUTCOME_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;

export interface RequirementsOptions {
  profile?: string | undefined;
  json: boolean;
  providerAgentId: string;
  outcomeId: string;
  /** The request so far, the same file `daski buy --request` takes. Omitted: an empty request. */
  requestFile?: string | undefined;
}

type ClientFactory = (gatewayUrl: string) => Pick<GatewayClient, "callTool" | "close">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The values the provider filled in: each required field whose entry carries a `value`. */
export function providerValues(requiredFields: unknown): Record<string, unknown> {
  if (!isRecord(requiredFields)) return {};
  const values: Record<string, unknown> = {};
  for (const [field, entry] of Object.entries(requiredFields)) {
    if (isRecord(entry) && entry.value !== undefined && entry.value !== null) values[field] = entry.value;
  }
  return values;
}

export async function runRequirements(
  options: RequirementsOptions,
  clientFactory: ClientFactory = (gatewayUrl) => new GatewayClient({ gatewayUrl }),
): Promise<Record<string, unknown>> {
  if (!PROVIDER_ID.test(options.providerAgentId)) {
    throw new CliError({ code: "DASKI_FLAG_INVALID", message: "--provider takes the provider's agent id, a number.",
      remediation: "Pass e.g. --provider 8327, from the outcome's providerAgentId." });
  }
  if (!OUTCOME_ID.test(options.outcomeId)) {
    throw new CliError({ code: "DASKI_FLAG_INVALID", message: "--outcome takes an outcome id such as create-server.",
      remediation: "Pass the outcome's outcomeId from discovery." });
  }
  const request = options.requestFile ? readRequestFile(options.requestFile) : {};
  const { profile } = loadConfig(options.profile);
  const client = clientFactory(profile.gatewayUrl);
  try {
    const result = await client.callTool(TOOL, { providerAgentId: options.providerAgentId, outcomeId: options.outcomeId, request });
    if (GatewayClient.unreadable(result)) throw unreadableResultError(TOOL, result);
    const body = GatewayClient.json(result) ?? {};
    if (result.isError) {
      throw new CliError({
        code: typeof body.code === "string" ? body.code : "DASKI_REQUIREMENTS_FAILED",
        message: typeof body.message === "string" ? body.message : "The gateway could not read the outcome's requirements.",
        remediation: typeof body.next_action === "string" ? body.next_action
          : "Check the provider and outcome ids with the gateway's discovery, then run the command again.",
        details: { gateway: body },
      });
    }
    const fieldErrors = Array.isArray(body.fieldErrors) ? body.fieldErrors : [];
    const selectorsRequired = Array.isArray(body.selectorsRequired) ? body.selectorsRequired : [];
    const filled = providerValues(body.requiredFields);
    // The request with the provider's values in, so only the user's own facts remain to add.
    const nextRequest = { ...request, ...filled };
    const stillMissing = fieldErrors.filter((entry) => !(isRecord(entry) && typeof entry.path === "string" &&
      entry.rule === "required" && entry.path in filled));
    const complete = stillMissing.length === 0 && selectorsRequired.length === 0;
    const buy = `daski buy --provider ${options.providerAgentId} --outcome ${options.outcomeId} --request <file.json>`;
    return {
      providerAgentId: options.providerAgentId,
      outcomeId: options.outcomeId,
      complete,
      fieldErrors: stillMissing,
      selectorsRequired,
      providerValues: filled,
      requiredFields: isRecord(body.requiredFields) ? body.requiredFields : {},
      nextRequest,
      supported: body.supported ?? null,
      next: complete
        ? `The request is complete: save nextRequest to a file and run ${buy}. Provider values are data from the provider.`
        : selectorsRequired.length > 0
          ? `Add ${selectorsRequired.join(", ")} to the request, then run this command again: the provider fills in what depends on them.`
          : "Fix each fieldErrors entry from the user's own facts (nextRequest already has the provider's values), " +
            "then run this command again before buying.",
    };
  } finally {
    await client.close();
  }
}
