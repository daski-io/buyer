/**
 * A small, explicit argument parser.
 *
 * Explicit because the flag surface is a security boundary: an unknown flag is
 * an error rather than something silently ignored, so a typo in
 * `--max-per-order` can never be mistaken for a cap that was applied.
 */
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
