/**
 * Output. Two modes, one rule: everything is redacted on the way out.
 */
import { redactValue } from "./redact.js";
import { CliError } from "./errors.js";

export interface OutputOptions {
  json: boolean;
}

export function emit(value: Record<string, unknown>, options: OutputOptions): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(redactValue(value), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderHuman(redactValue(value) as Record<string, unknown>)}\n`);
}

/** Human output goes to stdout; progress and prompts go to stderr. */
export function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function emitError(error: unknown, options: OutputOptions): number {
  const payload = errorPayload(error);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(redactValue(payload), null, 2)}\n`);
  } else {
    const redacted = redactValue(payload) as Record<string, unknown>;
    process.stderr.write(`error: ${String(redacted.message)}\n`);
    if (redacted.check) process.stderr.write(`  failed check: ${String(redacted.check)}\n`);
    if (redacted.expected) process.stderr.write(`  expected: ${String(redacted.expected)}\n`);
    if (redacted.actual) process.stderr.write(`  actual:   ${String(redacted.actual)}\n`);
    process.stderr.write(`  fix: ${String(redacted.remediation)}\n`);
  }
  return error instanceof CliError ? error.exitCode : 1;
}

function errorPayload(error: unknown): Record<string, unknown> {
  if (error && typeof (error as { toJSON?: unknown }).toJSON === "function") {
    return (error as { toJSON(): Record<string, unknown> }).toJSON();
  }
  return {
    error: "DASKI_UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : String(error),
    remediation: "Re-run with --json for the full payload, and report this if it persists.",
  };
}

function renderHuman(value: Record<string, unknown>, indent = ""): string {
  const lines: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      lines.push(`${indent}${key}:`);
      lines.push(renderHuman(item as Record<string, unknown>, `${indent}  `));
      continue;
    }
    if (Array.isArray(item)) {
      if (item.length === 0) { lines.push(`${indent}${key}: (none)`); continue; }
      lines.push(`${indent}${key}:`);
      for (const entry of item) {
        if (entry && typeof entry === "object") {
          lines.push(renderHuman(entry as Record<string, unknown>, `${indent}  - `.slice(0, -2) + "  "));
          lines.push("");
        } else {
          lines.push(`${indent}  - ${String(entry)}`);
        }
      }
      continue;
    }
    lines.push(`${indent}${key}: ${String(item)}`);
  }
  return lines.filter((line, index, all) => line !== "" || all[index + 1] !== undefined).join("\n");
}
