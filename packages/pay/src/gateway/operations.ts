/** Display only: the gateway verifies the provider signature. Financial state
 * stays in the original order and receipt even after successful remediation. */
export function operationalStatus(body: Record<string, unknown>): string | undefined {
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const operations = object(body.operations);
  if (operations.schemaVersion !== 1) return undefined;
  const recovery = object(operations.recovery);
  const recoveryLabels: Record<string, string> = {
    queued: "Recovery queued", pending: "Recovery waiting", running: "Recovering",
    attention: "Recovery needs operator attention", completed: "Completed after recovery", stopped: "Recovery stopped",
  };
  if (typeof recovery.state === "string" && recoveryLabels[recovery.state]) return recoveryLabels[recovery.state];
  const fulfillment = object(operations.fulfillment);
  const labels: Record<string, string> = {
    dns_pending: "DNS pending", waiting_capacity: "Ready, queued for capacity",
    provisioning: "Provisioning", operator_attention: "Operator attention required",
  };
  return typeof fulfillment.phase === "string" ? labels[fulfillment.phase] : undefined;
}
