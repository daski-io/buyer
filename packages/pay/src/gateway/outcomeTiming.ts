/** When a payment the gateway could not yet confirm is expected to have a known outcome. */

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** A time further ahead than this is not a settlement's, so it is not passed on as one. */
const MAX_AHEAD_MS = 24 * 60 * 60 * 1_000;

/**
 * When a PAYMENT_PENDING_RECONCILIATION answer says the payment's outcome is
 * expected to be known: its `until`, as ISO 8601. Only that answer's `until`
 * means this (a sales pause's `until` is when sales reopen), and only a full
 * ISO 8601 instant at most a day ahead is taken. Undefined otherwise.
 */
export function outcomeKnownBy(body: Record<string, unknown> | undefined): string | undefined {
  if (body?.code !== "PAYMENT_PENDING_RECONCILIATION") return undefined;
  const until = body.until;
  if (typeof until !== "string" || !ISO_INSTANT.test(until)) return undefined;
  const at = Date.parse(until);
  if (!Number.isFinite(at) || at - Date.now() > MAX_AHEAD_MS) return undefined;
  return new Date(at).toISOString();
}

/**
 * When to reconcile again, in words. `stillPending`: a read just found the
 * payment unresolved, so a time that has passed means "again in a few
 * minutes", not "now".
 */
export function checkAgainWords(
  checkAgainAfter: string | undefined,
  command: string,
  options: { stillPending?: boolean } = {},
): string {
  if (checkAgainAfter === undefined) {
    return options.stillPending ? `Check again later with ${command}.` : `Check again with ${command}.`;
  }
  if (Date.parse(checkAgainAfter) > Date.now()) {
    return `The gateway expects to know the outcome by ${checkAgainAfter}: run ${command} after that, ` +
      "and again later if it is still pending.";
  }
  return options.stillPending
    ? `The gateway expected to know the outcome by ${checkAgainAfter} and it is still pending: ` +
      `run ${command} again in a few minutes.`
    : `The gateway expected to know the outcome by ${checkAgainAfter}: run ${command} now, ` +
      "and again later if it is still pending.";
}
