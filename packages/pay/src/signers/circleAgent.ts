/**
 * The Circle agent wallet — a deployed contract account operated through the
 * pinned `@circle-fin/cli`, and the default signer for agent-hosted runtimes.
 * Candidate pending conformance.
 *
 * The adapter shells out to the `circle` command with an argument array,
 * never a shell string: the wallet address comes from `circle wallet list`,
 * and a signature from `circle wallet sign typed-data`, which receives exactly
 * the typed data the policy validator produced and nothing else. Each command
 * has a 30-second deadline. Only the signature is retained; command output is
 * never logged or included in an error.
 *
 * Login, terms, wallet creation, deployment, funding, and spending limits are
 * the user's steps with the vendor CLI, described by the gateway's setup
 * skill. This adapter never performs them and never sends a transaction.
 */
import { spawn } from "node:child_process";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import type { SignerAdapter, TypedDataRequest } from "@daski/x402-scheme";
import { CliError } from "../cli/errors.js";
import { serializeTypedData } from "./circle.js";
import { NOT_DEPLOYED_REMEDIATION } from "./contract.js";
import { hasErc6492Suffix, isBoundedSignature } from "./signature.js";

const DOC = "https://github.com/daski-io/buyer/blob/main/docs/signers.md#circle-agent";
export const CIRCLE_CLI_PACKAGE = "@circle-fin/cli";
export const CIRCLE_COMMAND_TIMEOUT_MS = 30_000;
/** More output than this is not a wallet listing or a signature. */
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface CommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
}

/** Runs `circle <args>`; injectable so tests supply a scripted vendor CLI. */
export type CommandRunner = (args: readonly string[], options: { timeoutMs: number }) => Promise<CommandResult>;

export interface CircleAgentSignerOptions {
  /** The profile's chain id; only Base and Base Sepolia map to Circle chain names. */
  chainId: number;
  /** Selects one wallet when the CLI lists several. */
  address?: string | undefined;
  run?: CommandRunner | undefined;
}

/** Circle's chain name for a profile chain id. */
export function circleChainName(chainId: number): "BASE" | "BASE-SEPOLIA" {
  if (chainId === 8453) return "BASE";
  if (chainId === 84532) return "BASE-SEPOLIA";
  throw new CliError({
    code: "DASKI_CIRCLE_AGENT_CHAIN_UNSUPPORTED",
    message: `The Circle agent wallet signer supports Base (8453) and Base Sepolia (84532), not chain ${chainId}.`,
    remediation: `Select a profile on Base or Base Sepolia. See ${DOC}`,
  });
}

/**
 * The environment the vendor CLI runs with: this process's, minus every
 * `DASKI_*` variable. The vendor never needs them, and two of them can carry
 * key material (`DASKI_PAYER_PRIVATE_KEY`, `DASKI_KEYSTORE_PASSPHRASE_FILE`).
 */
export function vendorEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("DASKI_")));
}

/** Spawns the vendor CLI directly from PATH with an argument array. */
export const spawnCircle: CommandRunner = (args, options) => new Promise((resolve, reject) => {
  const child = spawn("circle", args, {
    stdio: ["ignore", "pipe", "ignore"],
    env: vendorEnvironment(),
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  const chunks: Buffer[] = [];
  let collected = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    if (collected >= MAX_OUTPUT_BYTES) return;
    collected += chunk.length;
    chunks.push(chunk.subarray(0, Math.max(0, MAX_OUTPUT_BYTES - (collected - chunk.length))));
  });
  child.once("error", (error) => reject(error));
  child.once("close", (status, signal) => {
    resolve({
      status,
      signal,
      timedOut: signal === "SIGKILL" && status === null,
      stdout: Buffer.concat(chunks).toString("utf8"),
    });
  });
});

function cliMissing(): CliError {
  return new CliError({
    code: "DASKI_CIRCLE_CLI_MISSING",
    message: `The \`circle\` command is not on PATH; the Circle agent wallet signer needs ${CIRCLE_CLI_PACKAGE}.`,
    remediation:
      "Verify provenance, then install the version the gateway pins under signerClis.circle-agent in " +
      `/.well-known/mcp.json: npm view ${CIRCLE_CLI_PACKAGE} repository.url && npm install -g ` +
      `${CIRCLE_CLI_PACKAGE}@<pinned>. See ${DOC}`,
  });
}

async function runCircle(run: CommandRunner, args: readonly string[], what: string): Promise<string> {
  let result: CommandResult;
  try {
    result = await run(args, { timeoutMs: CIRCLE_COMMAND_TIMEOUT_MS });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw cliMissing();
    throw new CliError({
      code: "DASKI_CIRCLE_CLI_FAILED",
      message: `The circle CLI could not be started to ${what}.`,
      remediation: `Run \`circle --version\` in this environment to check the installation. See ${DOC}`,
    });
  }
  if (result.timedOut) {
    throw new CliError({
      code: "DASKI_CIRCLE_CLI_TIMEOUT",
      message: `The circle CLI did not ${what} within ${CIRCLE_COMMAND_TIMEOUT_MS / 1000} seconds.`,
      remediation: "Check the wallet login (circle wallet login) and connectivity, then re-run.",
    });
  }
  if (result.status !== 0) {
    // The vendor's output is never repeated here: it is not this CLI's to print.
    throw new CliError({
      code: "DASKI_CIRCLE_CLI_FAILED",
      message: `The circle CLI exited with status ${result.status ?? "unknown"} when asked to ${what}.`,
      remediation:
        "Run the same circle command in the user's terminal to see the vendor's message; a " +
        `logged-out session (circle wallet login) is the usual cause. See ${DOC}`,
    });
  }
  return result.stdout;
}

function outputInvalid(what: string): CliError {
  return new CliError({
    code: "DASKI_CIRCLE_CLI_OUTPUT_INVALID",
    message: `The circle CLI answered the ${what} request with output this CLI cannot read.`,
    remediation: `Check that the installed ${CIRCLE_CLI_PACKAGE} matches the gateway's pin. See ${DOC}`,
  });
}

/** Wallet addresses in a `circle wallet list --output json` document, whatever its envelope. */
export function walletAddressesFromListing(document: unknown): Address[] {
  const candidates: unknown[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.address === "string") candidates.push(record.address);
    for (const key of ["wallets", "data", "items", "result"]) {
      if (key in record) visit(record[key], depth + 1);
    }
  };
  visit(document, 0);
  const addresses = new Set<Address>();
  for (const candidate of candidates) {
    if (typeof candidate === "string" && isAddress(candidate, { strict: false })) addresses.add(getAddress(candidate));
  }
  return [...addresses];
}

export async function createCircleAgentSigner(options: CircleAgentSignerOptions): Promise<SignerAdapter> {
  const chain = circleChainName(options.chainId);
  const run = options.run ?? spawnCircle;

  const listing = await runCircle(run,
    ["wallet", "list", "--chain", chain, "--type", "agent", "--output", "json"], "list wallets");
  let document: unknown;
  try {
    document = JSON.parse(listing);
  } catch {
    throw outputInvalid("wallet list");
  }
  const addresses = walletAddressesFromListing(document);
  let address: Address;
  if (options.address !== undefined) {
    if (!isAddress(options.address, { strict: false })) {
      throw new CliError({
        code: "DASKI_CIRCLE_AGENT_WALLET_NOT_FOUND",
        message: `"${options.address}" is not an EVM address.`,
        remediation: `Pass --circle-wallet <address> with one of the agent wallets on ${chain}. See ${DOC}`,
      });
    }
    address = getAddress(options.address);
    if (!addresses.includes(address)) {
      throw new CliError({
        code: "DASKI_CIRCLE_AGENT_WALLET_NOT_FOUND",
        message: `The circle CLI lists no agent wallet ${address} on ${chain}.`,
        remediation: `Run: circle wallet list --chain ${chain} --type agent --output json. See ${DOC}`,
      });
    }
  } else if (addresses.length === 1) {
    address = addresses[0]!;
  } else if (addresses.length === 0) {
    throw new CliError({
      code: "DASKI_CIRCLE_AGENT_WALLET_MISSING",
      message: `The circle CLI lists no agent wallet on ${chain}.`,
      remediation:
        "Log in with the user's email (circle wallet login <email> --type agent --init), then " +
        `create one: circle wallet create --output json. See ${DOC}`,
    });
  } else {
    throw new CliError({
      code: "DASKI_CIRCLE_AGENT_WALLET_AMBIGUOUS",
      message: `The circle CLI lists ${addresses.length} agent wallets on ${chain}.`,
      remediation: `Select one with --circle-wallet <address>. See ${DOC}`,
    });
  }

  return {
    getAddress: async (): Promise<Address> => address,
    signTypedData: async (payload: TypedDataRequest): Promise<Hex> => {
      const output = await runCircle(run, [
        "wallet", "sign", "typed-data", serializeTypedData(payload),
        "--address", address, "--chain", chain, "--quiet",
      ], "sign typed data");
      const signature = signatureFromOutput(output);
      if (!signature) throw outputInvalid("signing");
      // An ERC-6492 wrapper means the wallet signed counterfactually; the
      // gateway and the facilitator refuse it, so it is refused here first.
      if (hasErc6492Suffix(signature)) throw counterfactualSignature(address);
      return signature;
    },
    describe: () => ({
      provider: "circle-agent",
      accountType: "contract",
      conformance: "candidate-pending-conformance",
    }),
  };
}

function counterfactualSignature(address: Address): CliError {
  return new CliError({
    code: "DASKI_SIGNER_NOT_DEPLOYED",
    message:
      `The circle CLI returned an ERC-6492 (counterfactual) signature for ${address}: the wallet ` +
      "signed as an undeployed account, and Daski refuses ERC-6492 wrappers.",
    remediation: NOT_DEPLOYED_REMEDIATION,
  });
}

/** The signature in `--quiet` output: bare hex, or a JSON object carrying `signature`. */
export function signatureFromOutput(output: string): Hex | undefined {
  const trimmed = output.trim();
  if (isBoundedSignature(trimmed)) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as { signature?: unknown };
    if (parsed && typeof parsed === "object" && isBoundedSignature(parsed.signature)) return parsed.signature;
  } catch {
    // Not JSON either.
  }
  return undefined;
}
