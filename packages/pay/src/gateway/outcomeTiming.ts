/** When a payment the gateway could not yet confirm will have a known outcome. */

/**
 * When an ambiguous answer says the payment's outcome will be known: its
 * `until` (a settlement the gateway could not confirm, or a captured
 * authorization waiting for sales to reopen), as ISO 8601. Undefined when the
 * answer names no readable time.
 */
export function outcomeKnownBy(body: Record<string, unknown> | undefined): string | undefined {
  const until = body?.until;
  if (typeof until !== "string" || until.length > 64) return undefined;
  const at = Date.parse(until);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

/** The wait before reconciling again, in words, for an outcome known at `checkAgainAfter`. */
export function checkAgainWords(checkAgainAfter: string | undefined, command: string): string {
  if (checkAgainAfter === undefined) return `Check again with ${command}.`;
  return Date.parse(checkAgainAfter) > Date.now()
    ? `The gateway will know the outcome by ${checkAgainAfter}: run ${command} after that.`
    : `The gateway expected to know the outcome by ${checkAgainAfter}: run ${command} now.`;
}
