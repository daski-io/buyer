/**
 * Interactive prompts.
 *
 * Two rules the CLI never bends: a non-TTY session cannot answer a human
 * question, and refusing is always the safe default. Every prompt here fails
 * closed.
 */
import { createInterface } from "node:readline/promises";
import { CliError } from "./errors.js";

const ETX = String.fromCharCode(3);        // Ctrl-C
const BACKSPACE = String.fromCharCode(127);
const BS = String.fromCharCode(8);

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Asks a yes/no question. Anything but an explicit yes is a no. */
export async function confirm(question: string): Promise<boolean> {
  if (!isInteractive()) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Requires the operator to retype an exact phrase. Used for key creation. */
export async function confirmPhrase(question: string, phrase: string): Promise<boolean> {
  if (!isInteractive()) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question}\nType "${phrase}" to continue: `);
    return answer.trim() === phrase;
  } finally {
    rl.close();
  }
}

/**
 * Reads a passphrase without echoing it. The typed characters are never
 * written back to the terminal and never leave this function except as the
 * return value.
 */
export async function readPassphrase(prompt: string): Promise<string> {
  if (!isInteractive()) {
    throw new CliError({
      code: "DASKI_PASSPHRASE_REQUIRES_TTY",
      message: "A passphrase is required, but this session has no terminal.",
      remediation:
        "Run the command from an interactive terminal, or configure an OS " +
        "keychain so no passphrase is needed.",
    });
  }
  process.stderr.write(prompt);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      const cleanup = (): void => {
        stdin.removeListener("data", onData);
        stdin.setRawMode(wasRaw);
        stdin.pause();
      };
      const onData = (chunk: Buffer): void => {
        for (const char of chunk.toString("utf8")) {
          if (char === "\r" || char === "\n") {
            cleanup();
            process.stderr.write("\n");
            resolve(value);
            return;
          }
          if (char === ETX) {
            cleanup();
            process.stderr.write("\n");
            reject(new CliError({
              code: "DASKI_PASSPHRASE_CANCELLED",
              message: "Passphrase entry cancelled.",
              remediation: "Re-run the command when ready.",
            }));
            return;
          }
          if (char === BACKSPACE || char === BS) {
            value = value.slice(0, -1);
            continue;
          }
          value += char;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(wasRaw);
  }
}
