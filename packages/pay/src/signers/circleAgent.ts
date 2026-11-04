/**
 * The Circle agent wallet — a deployed contract account operated through
 * `@circle-fin/cli`, and the default signer on every host.
 * Verified by the conformance suite. Signing checks no vendor version: the
 * gateway publishes the one this adapter was tested with, and the separate
 * direct-review adapter, which can execute, admits only its floor and later.
 *
 * The adapter shells out to the `circle` command with an argument array,
 * never a shell string: the wallet address comes from `circle wallet list`,
 * and a signature from `circle wallet sign typed-data`, which receives exactly
 * the typed data the policy validator produced and nothing else. On Windows,
 * where npm installs a `.cmd` shim and no executable, the adapter runs the
 * package's entry file with Node itself, as the shim would, still without a
 * shell (`resolveCircleCommand`). Each command has a 30-second deadline. Only
 * the signature is retained; command output is never logged or included in
 * an error.
 *
 * Login, terms, wallet creation, deployment, funding, and spending limits are
 * the user's steps with the vendor CLI, described by the gateway's setup
 * skill. This adapter never performs them and never sends a transaction.
 */
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import type { SignerAdapter, TypedDataRequest } from "@daski/x402-scheme";
import { CliError } from "../cli/errors.js";
import { serializeTypedData } from "./circle.js";
import { NOT_DEPLOYED_REMEDIATION } from "./contract.js";
import { hasErc6492Suffix, isBoundedSignature } from "./signature.js";

const DOC = "https://github.com/daski-io/buyer/blob/main/docs/signers.md#circle-agent";
const RECOVERY_DOC = "https://github.com/daski-io/buyer/blob/main/docs/signers.md#circle-initialization-recovery";
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

/** How the vendor CLI is started on this host. */
export interface CircleCommand {
  /** The program to spawn: `circle` for the OS to find on PATH, an executable, or Node. */
  command: string;
  /** Arguments placed before the vendor's own: the CLI's entry file when Node runs it. */
  leading: readonly string[];
  /** How the program was found. */
  via: "path" | "executable" | "npm-shim";
}

export interface ResolveCircleOptions {
  platform?: NodeJS.Platform | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Runs the entry file when no Node sits beside the shim; this process's Node by default. */
  execPath?: string | undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The entry file of the vendor package installed beside an npm shim: under
 * `node_modules` next to the shim for a global install, where the shim sits
 * in the prefix directory, or one level up for a project's `node_modules/.bin`.
 * Taken from the package's own `bin` field, never from the shim's text.
 */
function packageEntryBesideShim(shimDirectory: string): string | undefined {
  const [scope, name] = CIRCLE_CLI_PACKAGE.split("/") as [string, string];
  for (const packageDirectory of [join(shimDirectory, "node_modules", scope, name), join(shimDirectory, "..", scope, name)]) {
    let bin: unknown;
    try {
      bin = (JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as { bin?: unknown }).bin;
    } catch {
      continue;
    }
    const relative = typeof bin === "string" ? bin : (bin as Record<string, unknown> | null | undefined)?.circle;
    if (typeof relative !== "string") continue;
    const entry = join(packageDirectory, relative);
    if (isFile(entry)) return entry;
  }
  return undefined;
}

/**
 * Where the vendor CLI is on this host. On POSIX the OS resolves `circle`
 * from PATH when it is spawned. On Windows npm installs no executable, only
 * a `circle.cmd` shim, which cannot be started without a shell (Node refuses
 * it outright since 20.12.2), so the adapter does what the shim does: it runs
 * the package's entry file, found beside the shim, with Node, the argument
 * array intact and still no shell. A `circle.exe` on PATH, such as a version
 * manager's shim, is taken as it is. PATH order decides between directories.
 */
export function resolveCircleCommand(options: ResolveCircleOptions = {}): CircleCommand {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command: "circle", leading: [], via: "path" };
  const env = options.env ?? process.env;
  const directories = (env.PATH ?? env.Path ?? "").split(";")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry.length > 0);
  let shimWithoutPackage: string | undefined;
  for (const directory of directories) {
    const executable = join(directory, "circle.exe");
    if (isFile(executable)) return { command: executable, leading: [], via: "executable" };
    if (!isFile(join(directory, "circle.cmd"))) continue;
    const entry = packageEntryBesideShim(directory);
    if (entry === undefined) {
      shimWithoutPackage ??= directory;
      continue;
    }
    const node = join(directory, "node.exe");
    return { command: isFile(node) ? node : options.execPath ?? process.execPath, leading: [entry], via: "npm-shim" };
  }
  throw cliMissing(shimWithoutPackage);
}

/** A runner that spawns the vendor CLI as resolved for this host, with an argument array and no shell. */
export function circleRunner(resolveOptions: ResolveCircleOptions = {}): CommandRunner {
  return (args, options) => new Promise((resolve, reject) => {
    let program: CircleCommand;
    try {
      program = resolveCircleCommand(resolveOptions);
    } catch (error) {
      reject(error);
      return;
    }
    const child = spawn(program.command, [...program.leading, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      env: vendorEnvironment(resolveOptions.env),
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
}

/** Spawns the vendor CLI for this host with an argument array. */
export const spawnCircle: CommandRunner = circleRunner();

function cliMissing(shimWithoutPackage?: string): CliError {
  return new CliError({
    code: "DASKI_CIRCLE_CLI_MISSING",
    message: shimWithoutPackage === undefined
      ? `The \`circle\` command is not on PATH; the Circle agent wallet signer needs ${CIRCLE_CLI_PACKAGE}.`
      : `npm's circle.cmd shim in ${shimWithoutPackage} has no ${CIRCLE_CLI_PACKAGE} installed beside it; ` +
        "the Circle agent wallet signer needs that package.",
    remediation:
      "Install it with Circle's own skill (curl -sL https://agents.circle.com/skills/setup.md); Daski's " +
      "adapter is tested with the version the gateway publishes under signerClis.circle-agent in " +
      `/.well-known/mcp.json (npm install -g ${CIRCLE_CLI_PACKAGE}@<version>). See ${DOC}`,
  });
}

/**
 * Session selection is network-specific, but Circle's local agent profile
 * still requires the same email across its two environment slots.
 */
export function loginHint(chain: string | undefined): string {
  const skill = "Log in with Circle's login skill (curl -sL https://agents.circle.com/skills/wallet-login.md)";
  return `${skill}${chain === "BASE-SEPOLIA" ? ", adding --testnet to both login steps" : " for mainnet (omit --testnet)"}. ` +
    "Before requesting a code, compare the intended email with both sections of circle wallet status --output json; " +
    "the emails must match, and circle wallet logout clears both sessions";
}

/** Classify only known vendor failures; never include vendor output or account data. */
function vendorFailure(output: string, chain?: string): CliError | undefined {
  let error: { code?: unknown; message?: unknown } | undefined;
  try { error = (JSON.parse(output) as { error?: typeof error }).error; } catch { return undefined; }
  if (!error || typeof error.message !== "string") return undefined;
  if (error.code === "AUTH_REQUIRED" && error.message.startsWith("User not initialized.")) {
    return new CliError({
      code: "DASKI_CIRCLE_AGENT_INITIALIZATION_REQUIRED",
      message: "Circle authentication did not finish wallet initialization.",
      remediation: `Keep the same account and ${chain === "BASE-SEPOLIA" ? "testnet" : "mainnet"} network. ` +
        `Do not repeat normal login/create attempts; follow the bounded initialization recovery at ${RECOVERY_DOC}.`,
    });
  }
  if (error.code === "AUTH_REQUIRED" && /^Not logged in(?: with type| \(or session expired\)|\.)/.test(error.message)) {
    return loginRequired(chain);
  }
  if (error.code === "CONFLICT" && error.message.startsWith("This CLI session is logged in as ") &&
      error.message.includes("Log out or use the same email before logging in as ")) {
    return new CliError({
      code: "DASKI_CIRCLE_AGENT_ACCOUNT_CONFLICT",
      message: "Circle refused an email change because its other network still has a saved session.",
      remediation: "Read circle wallet status --output json and resolve the account choice before requesting another code. " +
        `Logout clears both sessions; changing CIRCLE_CLI_HOME alone does not isolate the OS keychain. See ${RECOVERY_DOC}.`,
    });
  }
  return undefined;
}

function loginRequired(chain?: string): CliError {
  return new CliError({
    code: "DASKI_CIRCLE_AGENT_LOGIN_REQUIRED",
    message: `Circle has no valid ${chain === "BASE-SEPOLIA" ? "testnet" : "mainnet"} login for this profile.`,
    remediation: `${loginHint(chain)}. See ${DOC}.`,
  });
}

async function runCircle(
  run: CommandRunner, args: readonly string[], what: string, chain?: string,
): Promise<string> {
  let result: CommandResult;
  try {
    result = await run(args, { timeoutMs: CIRCLE_COMMAND_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof CliError) throw error;
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
      remediation: `Check circle wallet status --output json and connectivity before retrying. A timeout alone does not call for login. See ${DOC}`,
    });
  }
  if (result.status !== 0) {
    const known = vendorFailure(result.stdout, chain);
    if (known) throw known;
    // Unknown vendor output is never repeated or assumed to be an auth failure.
    throw new CliError({
      code: "DASKI_CIRCLE_CLI_FAILED",
      message: `The circle CLI exited with status ${result.status ?? "unknown"} when asked to ${what}.`,
      remediation:
        "Inspect the same circle command's result in the current environment. Do not log out or " +
        `repeat login unless its error calls for authentication. See ${DOC}`,
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
    ["wallet", "list", "--chain", chain, "--type", "agent", "--output", "json"], "list wallets", chain);
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
    // list can succeed while logged out. Status is a read, and VALID only
    // describes token expiry; it is not proof of initialization or a wallet.
    const status = await runCircle(run, ["wallet", "status", "--type", "agent", "--output", "json"], "check session status", chain);
    let tokenStatus: unknown;
    try {
      const parsed = JSON.parse(status) as { data?: unknown };
      const data = (parsed.data ?? parsed) as Record<string, { tokenStatus?: unknown }>;
      tokenStatus = data[chain === "BASE-SEPOLIA" ? "testnet" : "mainnet"]?.tokenStatus;
    } catch { throw outputInvalid("wallet status"); }
    if (tokenStatus === "EXPIRED" || tokenStatus === "NOT_LOGGED_IN") throw loginRequired(chain);
    if (tokenStatus !== "VALID") throw outputInvalid("wallet status");
    throw new CliError({
      code: "DASKI_CIRCLE_AGENT_WALLET_MISSING",
      message: `Circle reports a valid ${chain === "BASE-SEPOLIA" ? "testnet" : "mainnet"} token but lists no agent wallet on ${chain}.`,
      remediation:
        "A valid token does not prove wallet initialization. Under the user's wallet-setup authorization, run " +
        `circle wallet create${chain === "BASE-SEPOLIA" ? " --testnet" : ""} --output json once. ` +
        `If it reports User not initialized, keep the same account and follow ${RECOVERY_DOC}; do not repeat normal login/create attempts.`,
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
      ], "sign typed data", chain);
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
      conformance: "verified",
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
