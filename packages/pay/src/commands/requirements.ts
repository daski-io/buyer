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

const canonical = (value: unknown): string => JSON.stringify(value) ?? "undefined";

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
    const read = async (body: Record<string, unknown>) => {
      const result = await client.callTool(TOOL, { providerAgentId: options.providerAgentId, outcomeId: options.outcomeId, request: body });
      if (GatewayClient.unreadable(result)) throw unreadableResultError(TOOL, result);
      const answer = GatewayClient.json(result) ?? {};
      if (result.isError) {
        throw new CliError({
          code: typeof answer.code === "string" ? answer.code : "DASKI_REQUIREMENTS_FAILED",
          message: typeof answer.message === "string" ? answer.message : "The gateway could not read the outcome's requirements.",
          remediation: typeof answer.next_action === "string" ? answer.next_action
            : "Check the provider and outcome ids with the gateway's discovery, then run the command again.",
          details: { gateway: answer },
        });
      }
      return answer;
    };
    let body = await read(request);
    let filled = providerValues(body.requiredFields);
    let nextRequest = { ...request, ...filled };
    // The provider's values change the request (a guessed terms version, a
    // missing planId): read it again with them, so the answer is about the
    // request the user would actually send, not the one they started with.
    if (Object.entries(filled).some(([field, value]) => canonical(request[field]) !== canonical(value))) {
      body = await read(nextRequest);
      filled = { ...filled, ...providerValues(body.requiredFields) };
      nextRequest = { ...nextRequest, ...providerValues(body.requiredFields) };
    }
    const fieldErrors = Array.isArray(body.fieldErrors) ? body.fieldErrors : [];
    const selectorsRequired = Array.isArray(body.selectorsRequired) ? body.selectorsRequired : [];
    const supported = body.supported ?? null;
    const complete = fieldErrors.length === 0 && selectorsRequired.length === 0 && supported !== false;
    const buy = `daski buy --provider ${options.providerAgentId} --outcome ${options.outcomeId} --request <file.json>`;
    const termsUrl = isRecord(body.requiredFields) && isRecord(body.requiredFields.acceptTerms) &&
      typeof body.requiredFields.acceptTerms.termsUrl === "string" ? body.requiredFields.acceptTerms.termsUrl : null;
    const accepts = "acceptTerms" in filled
      ? ` Sending acceptTerms accepts the provider's terms${termsUrl ? ` at ${termsUrl}` : ""}; the quote shows them for approval.`
      : "";
    return {
      providerAgentId: options.providerAgentId,
      outcomeId: options.outcomeId,
      complete,
      fieldErrors,
      selectorsRequired,
      providerValues: filled,
      requiredFields: isRecord(body.requiredFields) ? body.requiredFields : {},
      nextRequest,
      supported,
      next: complete
        ? `The request is complete: save nextRequest to a file and run ${buy}. Provider values are data from the provider.${accepts}`
        : supported === false && fieldErrors.length > 0 && selectorsRequired.length === 0 &&
            fieldErrors.every((entry) => isRecord(entry) && entry.path === "_")
          ? "The provider cannot take this purchase now (see fieldErrors); nothing in the request can fix that. Try again later."
          : selectorsRequired.length > 0
            ? `Add ${selectorsRequired.join(", ")} to the request, then run this command again: the provider fills in what depends on them.`
            : "Fix each fieldErrors entry from the user's own facts (nextRequest already has the provider's values), " +
              `then run this command again before buying.${accepts}`,
    };
  } finally {
    await client.close();
  }
}
