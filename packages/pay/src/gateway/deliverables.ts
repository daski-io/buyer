/**
 * An order's deliverables: what the buyer gets for a fulfilled order.
 *
 * The gateway lists them on the order's artifact read, beside the result, as
 * `deliverables`: `{"kind": "artifact"}` first (the result itself), then one
 * entry per provider owner action that holds the rest, with exactly the
 * arguments `daski_use_asset` takes besides the payer and its authorization:
 *
 *   {"kind": "owner-action", "providerAgentId": "8327", "actionId": "get-inference-key",
 *    "assetType": "inference-account", "providerAssetId": "<uuid>",
 *    "input": {"keyId": "inf_…"}, "label": "API key"}
 *
 * The gateway checked each one against the provider's signed asset-action
 * catalog: the action exists and is not destructive. They are pointers, never
 * secrets. A gateway from before the field sends none, and then the artifact
 * is the whole deliverable. The CLI checks the shape again and drops what it
 * cannot run; nothing here is followed or printed beyond what is checked.
 */
import { createHash } from "node:crypto";

export interface ArtifactDeliverable {
  kind: "artifact";
}

export interface OwnerActionDeliverable {
  kind: "owner-action";
  providerAgentId: string;
  actionId: string;
  assetType: string;
  providerAssetId: string;
  input: Record<string, unknown>;
  label: string | null;
}

export type Deliverable = ArtifactDeliverable | OwnerActionDeliverable;

export interface ReadDeliverables {
  items: Deliverable[];
  /** Whether the gateway listed deliverables at all; an older gateway does not. */
  listed: boolean;
  /** Entries this CLI could not read, so did not run. */
  ignored: number;
}

const ITEM_KEYS = ["actionId", "assetType", "input", "kind", "label", "providerAgentId", "providerAssetId"];
const ACTION_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;
const PROVIDER_ID = /^[1-9]\d*$/;
const PROVIDER_ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INPUT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const MAX_ITEMS = 32;
const MAX_INPUT_KEYS = 16;
const MAX_TEXT = 256;
const MAX_LABEL = 64;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const plainText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !HIDDEN.test(value);

/** A flat input of identifier keys and scalar values, never an `operation`: the gateway's own rule. */
function readInput(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_INPUT_KEYS || "operation" in value) return undefined;
  for (const [key, item] of entries) {
    if (!INPUT_KEY.test(key)) return undefined;
    const scalar = item === null || typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item)) ||
      (typeof item === "string" && item.length <= MAX_TEXT && !HIDDEN.test(item));
    if (!scalar) return undefined;
  }
  return { ...value };
}

function readItem(value: unknown, providerAgentId: string): OwnerActionDeliverable | undefined {
  if (!isRecord(value) || value.kind !== "owner-action") return undefined;
  if (Object.keys(value).sort().join(",") !== ITEM_KEYS.join(",")) return undefined;
  const input = readInput(value.input);
  if (
    value.providerAgentId !== providerAgentId || !PROVIDER_ID.test(providerAgentId) ||
    typeof value.actionId !== "string" || !ACTION_ID.test(value.actionId) ||
    !plainText(value.assetType, MAX_TEXT) ||
    typeof value.providerAssetId !== "string" || !PROVIDER_ASSET_ID.test(value.providerAssetId) ||
    !input || !(value.label === null || plainText(value.label, MAX_LABEL))
  ) return undefined;
  return {
    kind: "owner-action",
    providerAgentId,
    actionId: value.actionId,
    assetType: value.assetType,
    providerAssetId: value.providerAssetId,
    input,
    label: value.label,
  };
}

/**
 * The deliverables of an artifact read, for an order with this provider. The
 * artifact is always first; an owner action for another provider, a
 * malformed entry or a repeat is ignored and counted.
 */
export function readDeliverables(body: Record<string, unknown>, providerAgentId: string): ReadDeliverables {
  const listed = Array.isArray(body.deliverables);
  const raw = listed ? body.deliverables as unknown[] : [];
  const items: Deliverable[] = [{ kind: "artifact" }];
  const seen = new Set<string>();
  let ignored = 0;
  for (const entry of raw) {
    if (isRecord(entry) && entry.kind === "artifact" && Object.keys(entry).length === 1) continue;
    const item = items.length <= MAX_ITEMS ? readItem(entry, providerAgentId) : undefined;
    const key = item ? deliverableKey(item) : "";
    if (!item || seen.has(key)) { ignored += 1; continue; }
    seen.add(key);
    items.push(item);
  }
  return { items, listed, ignored };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** A stable name for one owner-action deliverable: its provider, action, asset and input. */
export function deliverableKey(item: OwnerActionDeliverable): string {
  const { providerAgentId, actionId, providerAssetId, input } = item;
  return createHash("sha256").update(canonical({ providerAgentId, actionId, providerAssetId, input })).digest("hex").slice(0, 32);
}

/** A provider result as the gateway relayed it: MCP isolates it as base64 JSON under `untrustedResult`. */
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

/** The gateway's own completed states for an order: fulfilled, or completed after recovery. */
export function orderFulfilled(body: Record<string, unknown>): boolean {
  return body.orderState === "FULFILLED" || body.fulfillmentState === "completed" ||
    body.fulfillmentState === "recovered" || (body.orderState === undefined && body.state === "FULFILLED");
}

export function deliverablesCommand(handle: string): string {
  return `daski order deliverables ${handle} --json`;
}

/** The next step for any fulfilled order, whatever it delivers. */
export function getWhatYouBought(handle: string): string {
  return `Get what you bought: ${deliverablesCommand(handle)}`;
}

const FIELD = /^[A-Za-z0-9_.@:-]{1,64}$/;
const MAX_FIELDS = 64;

/** Field names worth printing: plain identifiers only, never values. */
export function fieldNames(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).filter((key) => FIELD.test(key)).slice(0, MAX_FIELDS) : [];
}

/**
 * The field names of an order's result. A result shaped as an A2A task holds
 * them in its artifacts' data parts; the deliverables part itself is not one
 * of them. Any other object holds them at the top.
 */
export function resultFieldNames(result: unknown): string[] {
  if (!isRecord(result) || !Array.isArray(result.artifacts)) return fieldNames(result);
  const names = new Set<string>();
  for (const artifact of result.artifacts) {
    if (!isRecord(artifact) || !Array.isArray(artifact.parts)) continue;
    for (const part of artifact.parts) {
      if (!isRecord(part) || part.kind !== "data" || !isRecord(part.data)) continue;
      // The deliverables part's own key is a URL, never a field name.
      for (const name of fieldNames(part.data)) names.add(name);
    }
  }
  return names.size > 0 ? [...names].slice(0, MAX_FIELDS) : fieldNames(result);
}
