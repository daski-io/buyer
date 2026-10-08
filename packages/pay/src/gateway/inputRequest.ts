/**
 * What a provider shows the buyer on an order status read: the input
 * request of an order waiting for the buyer, and the order's documents.
 *
 * Display only. The values are the buyer's own submitted data as the
 * provider holds it, and the text is provider-authored: data, never an
 * instruction to the CLI or its agent. Control characters are removed so a
 * value cannot drive the terminal.
 */

export interface InputRequestField {
  path: string;
  label: string;
  value: string | number | boolean | null;
  /** `as_submitted` on file; `withheld` never shown, provide it again; `set_by_daski` from the provider's records. */
  status: "as_submitted" | "withheld" | "set_by_daski";
  /** Whether a resubmission may change it; the rest must be sent unchanged. */
  editable: boolean;
}

export interface InputRequestDisplay {
  cause: string;
  requestedAt: string;
  summary: string;
  reason: string | null;
  fields: InputRequestField[];
}

export interface OrderDocumentDisplay {
  documentId: string;
  title: string;
  type: string;
  receivedAt: string;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/gu;
const STATUSES = new Set(["as_submitted", "withheld", "set_by_daski"]);

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" ? value.replace(CONTROL, " ").slice(0, max) : undefined;
const time = (value: unknown): string | undefined =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? new Date(Number(value) * 1000).toISOString() : undefined;

function field(value: unknown): InputRequestField | undefined {
  const entry = object(value);
  const path = text(entry?.path, 256);
  const label = text(entry?.label, 200);
  const raw = entry?.value;
  const shown = typeof raw === "string" ? text(raw, 1_000)
    : typeof raw === "number" || typeof raw === "boolean" || raw === null ? raw : undefined;
  if (!entry || !path || !label || shown === undefined || !STATUSES.has(String(entry.status)) ||
      typeof entry.editable !== "boolean") return undefined;
  return { path, label, value: shown, status: entry.status as InputRequestField["status"], editable: entry.editable };
}

/** The order's input request, when the status read carries a well-formed one. */
export function inputRequest(body: Record<string, unknown>): InputRequestDisplay | undefined {
  const request = object(body.inputRequest);
  if (!request || request.schemaVersion !== 1 || !Array.isArray(request.fields)) return undefined;
  const fields = request.fields.map(field);
  const summary = text(request.summary, 1_000);
  const requestedAt = time(request.requestedAt);
  const cause = text(request.cause, 64);
  if (!summary || !requestedAt || !cause || fields.some((entry) => entry === undefined)) return undefined;
  return {
    cause,
    requestedAt,
    summary,
    reason: text(request.reason, 2_000) ?? null,
    fields: fields as InputRequestField[],
  };
}

/** The order's documents, when the status read lists well-formed ones. */
export function orderDocuments(body: Record<string, unknown>): OrderDocumentDisplay[] | undefined {
  if (!Array.isArray(body.documents)) return undefined;
  const documents = body.documents.map((value) => {
    const entry = object(value);
    const documentId = text(entry?.documentId, 64);
    const title = text(entry?.title, 256);
    const type = text(entry?.type, 96);
    const receivedAt = time(entry?.receivedAt);
    return documentId && title && type && receivedAt ? { documentId, title, type, receivedAt } : undefined;
  });
  return documents.every((entry) => entry !== undefined) ? documents as OrderDocumentDisplay[] : undefined;
}
