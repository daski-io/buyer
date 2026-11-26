/**
 * A small, explicit argument parser.
 *
 * Explicit because the flag surface is a security boundary: an unknown flag is
 * an error rather than something silently ignored, so a typo in
 * `--max-per-order` can never be mistaken for a cap that was applied.
 */
import { readFileSync } from "node:fs";
import { CliError } from "./errors.js";

export interface ParsedArgs {
  command: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let index = 0;
  for (; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") { index += 1; break; }
    if (!token.startsWith("-")) { command.push(token); continue; }
    const name = token.replace(/^--?/, "");
    const [key, inlineValue] = name.includes("=")
      ? [name.slice(0, name.indexOf("=")), name.slice(name.indexOf("=") + 1)]
      : [name, undefined];
    if (inlineValue !== undefined) { flags[key] = inlineValue; continue; }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("-")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  command.push(...argv.slice(index));
  return { command, flags };
}

export function stringFlag(
  flags: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new CliError({
      code: "DASKI_FLAG_NEEDS_VALUE",
      message: `--${name} needs a value.`,
      remediation: `Pass a value, e.g. --${name} <value>`,
    });
  }
  return value;
}

export function boolFlag(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}

export function requireFlag(
  flags: Record<string, string | boolean>,
  name: string,
): string {
  const value = stringFlag(flags, name);
  if (value === undefined) {
    throw new CliError({
      code: "DASKI_FLAG_REQUIRED",
      message: `--${name} is required.`,
      remediation: `Re-run with --${name} <value>. See \`daski help\`.`,
    });
  }
  return value;
}

/** Rejects flags the command does not understand, rather than ignoring them. */
export function assertKnownFlags(
  flags: Record<string, string | boolean>,
  known: readonly string[],
): void {
  const unknown = Object.keys(flags).filter((flag) => !known.includes(flag));
  if (unknown.length > 0) {
    throw new CliError({
      code: "DASKI_UNKNOWN_FLAG",
      message: `Unknown flag${unknown.length > 1 ? "s" : ""}: ${unknown.map((f) => `--${f}`).join(", ")}`,
      remediation:
        `This command accepts: ${known.map((f) => `--${f}`).join(", ")}. ` +
        "An ignored flag could look like an applied spend cap, so unknown flags are refused.",
    });
  }
}

/**
 * `--input '<json>'` or `--input-file <file.json>`: one JSON object, or
 * undefined when neither is given.
 */
export function inputFlag(flags: Record<string, string | boolean>): Record<string, unknown> | undefined {
  const inline = stringFlag(flags, "input");
  const file = stringFlag(flags, "input-file");
  if (inline !== undefined && file !== undefined) {
    throw new CliError({ code: "DASKI_INPUT_INVALID", message: "Pass --input or --input-file, not both.",
      remediation: "Keep one of them." });
  }
  if (inline === undefined && file === undefined) return undefined;
  let text = inline;
  if (file !== undefined) {
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      throw new CliError({ code: "DASKI_INPUT_INVALID", message: `Could not read ${file}: ${(error as Error).message}`,
        remediation: "Pass --input-file with a path to a JSON object." });
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text!);
  } catch (error) {
    throw new CliError({ code: "DASKI_INPUT_INVALID", message: `The input is not JSON: ${(error as Error).message}`,
      remediation: `Pass one JSON object, quoted for the shell, e.g. --input '{"keyId":"inf_..."}'.` });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError({ code: "DASKI_INPUT_INVALID", message: "The input must be a JSON object.",
      remediation: `Pass one JSON object, e.g. --input '{"keyId":"inf_..."}'.` });
  }
  return parsed as Record<string, unknown>;
}
