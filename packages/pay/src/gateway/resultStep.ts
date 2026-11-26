/**
 * The step after FULFILLED, for an order whose result sits behind one of its
 * provider's owner actions.
 *
 * Some outcomes deliver a handle to an asset rather than the thing the buyer
 * wanted: an inference account's order result carries its `keyId`, and the
 * key itself comes from the provider's `get-inference-key` action on the
 * asset. Agents that read `FULFILLED` stopped there without the key.
 *
 * Whether an order is such an order is read from what the gateway publishes,
 * never from a provider id:
 *
 *   - the order is complete (FULFILLED, or completed after recovery);
 *   - its outcome creates a persistent asset (`persistentAsset` in the
 *     gateway's outcome detail);
 *   - the outcome's service lists a non-destructive owner action for that
 *     asset type in the gateway's public service registry; and
 *   - the order's own result, which the gateway validated against the
 *     listing's signed schema, names that action.
 *
 * The last condition is what separates "the result is behind an action" from
 * "the asset also has actions": a server order's result already carries the
 * server, and names none of them. The result is only searched for the ids
 * the gateway listed; nothing in it is printed or followed.
 *
 * The result's text is read because nothing structured says it yet: no
 * listing contract, owner action or order status field names the action that
 * holds an order's result, so the gateway cannot state it until providers
 * declare it.
 */
import type { Catalog } from "./catalog.js";
import type { OwnerAction, ServiceDirectory } from "./services.js";

export interface ResultStep {
  actionId: string;
  name: string;
  assetType: string | null;
  /** The exact command that runs it for this order. */
  command: string;
  next: string;
}

const MAX_DEPTH = 8;
const MAX_STRINGS = 4_000;

/** The order's result as the gateway relayed it: MCP isolates it as base64 JSON under `untrustedResult`. */
export function decodeOrderResult(body: Record<string, unknown>): unknown {
  const isolated = body.untrustedResult as { contentEncoding?: unknown; content?: unknown } | undefined;
  if (isolated && typeof isolated === "object" && typeof isolated.content === "string") {
    try {
      const raw = isolated.contentEncoding === "base64"
        ? Buffer.from(isolated.content, "base64").toString("utf8")
        : isolated.content;
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }
  return "result" in body ? body.result : undefined;
}

/** Every string in a result, each with the field name it sits under. Bounded. */
export function resultStrings(value: unknown): { key: string | null; value: string; depth: number }[] {
  const found: { key: string | null; value: string; depth: number }[] = [];
  const walk = (item: unknown, key: string | null, depth: number): void => {
    if (found.length >= MAX_STRINGS || depth > MAX_DEPTH) return;
    if (typeof item === "string") { found.push({ key, value: item, depth }); return; }
    if (Array.isArray(item)) { for (const entry of item) walk(entry, key, depth + 1); return; }
    if (item && typeof item === "object") {
      for (const [name, entry] of Object.entries(item as Record<string, unknown>)) walk(entry, name, depth + 1);
    }
  };
  walk(value, null, 0);
  return found;
}

/** The gateway's own completed states for an order. */
export function orderComplete(body: Record<string, unknown>): boolean {
  return body.orderState === "FULFILLED" || body.fulfillmentState === "completed" ||
    body.fulfillmentState === "recovered" || (body.orderState === undefined && body.state === "FULFILLED");
}

/** An action id as the gateway admits one: also safe to print inside a shell command. */
const ACTION_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;

/** Where in `text` the action id appears as a whole word, or -1. */
function position(text: string, actionId: string): number {
  const match = new RegExp(`(^|[^a-z0-9-])${actionId}($|[^a-z0-9-])`).exec(text);
  return match ? match.index + match[1]!.length : -1;
}

export function resultStepCommand(handle: string, actionId: string): string {
  return `daski asset action --order ${handle} --action ${actionId} --json`;
}

/**
 * The result step for one order read, or undefined when the order has none.
 * Never throws: a lookup that fails leaves the status read as it was.
 */
export async function resultStep(args: {
  catalog: Pick<Catalog, "getOutcome">;
  services: Pick<ServiceDirectory, "byId">;
  providerAgentId: string;
  outcomeId: string;
  handle: string;
  body: Record<string, unknown>;
}): Promise<ResultStep | undefined> {
  try {
    if (!orderComplete(args.body)) return undefined;
    const strings = resultStrings(decodeOrderResult(args.body));
    if (strings.length === 0) return undefined;
    let outcome = await args.catalog.getOutcome(args.providerAgentId, args.outcomeId);
    // A cached summary from before 0.5.15 lacks these fields.
    if (outcome.persistentAsset === undefined || outcome.serviceId === undefined) {
      outcome = await args.catalog.getOutcome(args.providerAgentId, args.outcomeId, { refresh: true });
    }
    if (outcome.persistentAsset !== true || !outcome.serviceId) return undefined;
    const service = await args.services.byId(outcome.serviceId);
    const skillId = outcome.skillId ?? args.outcomeId;
    const assetType = service.skills.find((skill) => skill.skillId === skillId)?.assetType ?? null;
    const candidates = service.ownerActions.filter((action: OwnerAction) => ACTION_ID.test(action.actionId) &&
      !action.destructive && (assetType === null || action.assetType === null || action.assetType === assetType));
    // When the result names several, the one it names first: results read "call X, then Y".
    let named: OwnerAction | undefined;
    for (const item of strings) {
      let earliest = Number.POSITIVE_INFINITY;
      for (const action of candidates) {
        const at = position(item.value, action.actionId);
        if (at >= 0 && at < earliest) { earliest = at; named = action; }
      }
      if (named) break;
    }
    if (!named) return undefined;
    const command = resultStepCommand(args.handle, named.actionId);
    return {
      actionId: named.actionId,
      name: named.name,
      assetType,
      command,
      next:
        `The order is fulfilled, and its result points to the provider's owner action ${named.actionId} on the asset ` +
        `it created: the purchase is done once you have what that action returns. Run: ${command}. ` +
        "It writes the action's result to a file with mode 600 and prints only the path.",
    };
  } catch {
    return undefined;
  }
}
