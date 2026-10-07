/** Direct reviews are the only transaction-capable vendor integration. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { CliError } from "../cli/errors.js";
import { resolveCircleCommand, vendorEnvironment } from "./circleAgent.js";
import {
  CIRCLE_REVIEW_ENTRY_HASHES, assertCircleReviewRequest, circleReviewProgress, circleRowCarriesCall,
  type CircleReviewProgress, type CircleReviewRequest,
} from "./circleReviewTransport.js";

export interface CircleSubmission {
  transactionId?: string;
  txHash?: Hex;
  /** Circle's last reported state for the transaction. */
  state?: string;
  progress: CircleReviewProgress;
}
export interface CircleLookup {
  transactionId?: string;
  hashes: Hex[];
  /** Circle's state for the identified transaction, when exactly one is identified. */
  state?: string;
}
export interface CircleLookupOptions {
  /** The transaction the bound challenge named, when the submission recorded it. */
  transactionId?: string | undefined;
  /** When the submission started; a row created earlier is not this submission. */
  notBefore?: string | undefined;
}
export interface DirectReviewSubmissionAdapter {
  readonly packageVersion: string;
  estimate(request: CircleReviewRequest): Promise<Record<string, string>>;
  submit(request: CircleReviewRequest): Promise<CircleSubmission>;
  lookup(request: CircleReviewRequest, options?: CircleLookupOptions): Promise<CircleLookup>;
}
/** The vendor's parsed JSON output and what the child recorded of the run. */
export interface CircleReviewRun { output: unknown; progress: CircleReviewProgress }
export type CircleReviewRunner = (entry: string, request: CircleReviewRequest) => Promise<CircleReviewRun>;

/** The pinned CLIs poll a challenge for up to 60 s and its transaction for up to 120 s. */
export const CIRCLE_REVIEW_TIMEOUT_MS = 210_000;
const MAX_PROGRESS_BYTES = 64 * 1024;

function failure(code: string, message: string, progress?: CircleReviewProgress): CliError {
  return new CliError({ code, message,
    remediation: "Keep the saved review journal. Use --resume for read-only reconciliation; do not execute the call again after an uncertain response.",
    ...(progress ? { details: { circleProgress: progress } } : {}) });
}
/** The progress a failed vendor run recorded, when the failure came from the runner. */
export function circleProgressOf(error: unknown): CircleReviewProgress | undefined {
  if (!(error instanceof CliError)) return undefined;
  const progress = error.details.circleProgress as CircleReviewProgress | undefined;
  return progress && typeof progress.approvalSent === "boolean" && typeof progress.uncertain === "boolean" ? progress : undefined;
}
/** No shell, overrides, preload hooks, secret Daski environment or vendor output in errors. */
export function circleReviewEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = vendorEnvironment(env);
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "CIRCLE_PROXY_URL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete result[key];
  return result;
}
export function resolveCircleReviewEntry(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    const program = resolveCircleCommand({ env });
    if (program.via === "npm-shim" && program.leading.length === 1) return program.leading[0]!;
  } else {
    for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
      try {
        const entry = realpathSync(join(directory, "circle"));
        if (statSync(entry).isFile() && entry.endsWith("/dist/index.js")) return entry;
      } catch { /* Keep PATH order; never run a shell shim. */ }
    }
  }
  throw failure("DASKI_CIRCLE_REVIEW_PACKAGE_UNSUPPORTED", "The Circle npm entrypoint could not be verified.");
}
export function verifyCircleReviewEntry(entry: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")) as { name: string; version: string };
    const expected = CIRCLE_REVIEW_ENTRY_HASHES[pkg.version];
    if (pkg.name === "@circle-fin/cli" && expected && createHash("sha256").update(readFileSync(entry)).digest("hex") === expected) return pkg.version;
  } catch { /* Bounded error, no package content or vendor output. */ }
  throw new CliError({ code: "DASKI_CIRCLE_REVIEW_PACKAGE_UNSUPPORTED",
    message: `The installed Circle entrypoint differs from the qualified ${Object.keys(CIRCLE_REVIEW_ENTRY_HASHES).join("/")} artifacts.`,
    remediation: "Nothing was sent. Install a qualified version, such as the one the gateway publishes under signerClis.circle-agent " +
      "(npm install -g @circle-fin/cli@<version>), then repeat the same command. The saved review is kept." });
}
/** Reads at most the progress bound; a larger file is unreadable, so the run is uncertain. */
function readProgress(path: string): CircleReviewProgress {
  try {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(MAX_PROGRESS_BYTES + 1);
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      if (length > MAX_PROGRESS_BYTES) return { ...circleReviewProgress(""), uncertain: true };
      return circleReviewProgress(buffer.subarray(0, length).toString("utf8"));
    } finally {
      closeSync(fd);
    }
  } catch {
    return { ...circleReviewProgress(""), uncertain: true };
  }
}
export const spawnCircleReview: CircleReviewRunner = (entry, request) => {
  assertCircleReviewRequest(request);
  const directory = mkdtempSync(join(tmpdir(), "daski-circle-review-"));
  const progressFile = join(directory, "progress.jsonl");
  writeFileSync(progressFile, "", { mode: 0o600 });
  const settle = (): CircleReviewProgress => {
    const progress = readProgress(progressFile);
    rmSync(directory, { recursive: true, force: true });
    return progress;
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./circleReviewChild.js", import.meta.url)), entry, progressFile], {
      stdio: ["pipe", "pipe", "ignore"], env: circleReviewEnvironment(),
      timeout: CIRCLE_REVIEW_TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 256 * 1024) child.kill("SIGKILL"); else chunks.push(chunk);
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      reject(failure("DASKI_CIRCLE_REVIEW_UNKNOWN", "The Circle review process could not complete.", settle()));
    });
    child.once("close", (status) => {
      if (settled) return;
      settled = true;
      const progress = settle();
      if (status !== 0 || size > 256 * 1024) { reject(failure("DASKI_CIRCLE_REVIEW_UNKNOWN", "Circle did not return a definitive review result.", progress)); return; }
      try { resolve({ output: JSON.parse(Buffer.concat(chunks).toString("utf8")), progress }); }
      catch { reject(failure("DASKI_CIRCLE_REVIEW_UNKNOWN", "Circle returned an unreadable review result.", progress)); }
    });
    child.stdin.on("error", () => { /* Exit handler preserves ambiguity. */ });
    child.stdin.end(JSON.stringify(request));
  });
};
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function unwrap(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return isRecord(value.data) ? value.data : value;
}
function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(value) ? value : undefined;
}
function hash(value: unknown): Hex | undefined {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() as Hex : undefined;
}
function vendorState(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z_]{1,32}$/.test(value) ? value : undefined;
}
/** Rows are created by Circle's clock and started by ours; allow this much disagreement. */
const CLOCK_SKEW_MS = 5 * 60_000;
/**
 * Matching needs vendor identity and the exact call. Identity is the
 * transaction the bound challenge named, else the idempotency key, else a row
 * created after the submission started. The call is the echoed calldata or
 * the echoed signature and parameters re-encoded; a row that carries a
 * different call never matches, and a row that carries none matches only by
 * the recorded transaction ID. A nearby transaction is never enough, and every
 * hash found here is still bound on chain before the journal closes.
 */
export function matchedCircleTransactions(value: unknown, request: CircleReviewRequest, options: CircleLookupOptions = {}): CircleLookup {
  const unwrapped = unwrap(value);
  const rows: unknown[] = Array.isArray(value) ? value : Array.isArray(unwrapped.transactions) ? unwrapped.transactions
    : Array.isArray(value && isRecord(value) ? value.data : null) ? (value as { data: unknown[] }).data : [];
  const notBefore = options.notBefore === undefined ? undefined : Date.parse(options.notBefore) - CLOCK_SKEW_MS;
  const matched = rows.filter(isRecord).filter(row => {
    const carriesCall = row.callData !== undefined || row.calldata !== undefined || row.abiFunctionSignature !== undefined || row.abiParameters !== undefined;
    if (options.transactionId) return row.id === options.transactionId && (!carriesCall || circleRowCarriesCall(row, request));
    if (!carriesCall || !circleRowCarriesCall(row, request)) return false;
    if (row.idempotencyKey !== undefined) return row.idempotencyKey === request.idempotencyKey;
    return notBefore !== undefined && Number.isFinite(notBefore) && typeof row.createDate === "string" && Date.parse(row.createDate) >= notBefore;
  });
  const ids = [...new Set(matched.map(row => identifier(row.id)).filter((id): id is string => !!id))];
  const hashes = [...new Set(matched.map(row => hash(row.txHash)).filter((h): h is Hex => !!h))];
  if (ids.length !== 1) return { hashes };
  const state = vendorState(matched.find(row => row.id === ids[0])?.state);
  return { transactionId: ids[0]!, hashes, ...(state ? { state } : {}) };
}
export function createCircleReviewAdapter(options: { entry?: string; run?: CircleReviewRunner; packageVersion?: string } = {}): DirectReviewSubmissionAdapter {
  const entry = options.entry ?? resolveCircleReviewEntry();
  // A scripted runner (tests) names its version; the installed vendor entry is always verified.
  const packageVersion = options.run && options.packageVersion ? options.packageVersion : verifyCircleReviewEntry(entry);
  const run = options.run ?? spawnCircleReview;
  return {
    packageVersion,
    async estimate(request) {
      const data = unwrap((await run(entry, { ...request, mode: "estimate" })).output);
      const medium = unwrap(data.medium ?? data);
      // Only known scalar fee facts leave the child; no raw vendor response is logged.
      return Object.fromEntries(["gasLimit", "networkFee", "gasPrice", "maxFee"].flatMap(key =>
        typeof medium[key] === "string" && /^[0-9.]+$/.test(medium[key] as string) ? [[key, medium[key] as string]] : []));
    },
    async submit(request) {
      const { output, progress } = await run(entry, { ...request, mode: "execute" });
      const data = unwrap(output);
      const transactionId = identifier(data.id) ?? progress.transactionId;
      const txHash = hash(data.txHash) ?? progress.txHash;
      const state = vendorState(data.state) ?? progress.state;
      return { ...(transactionId ? { transactionId } : {}), ...(txHash ? { txHash } : {}), ...(state ? { state } : {}), progress };
    },
    async lookup(request, lookupOptions = {}) {
      return matchedCircleTransactions((await run(entry, { ...request, mode: "lookup" })).output, request, lookupOptions);
    },
  };
}
