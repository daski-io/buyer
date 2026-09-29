/** Direct reviews are the only transaction-capable vendor integration. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { CliError } from "../cli/errors.js";
import { resolveCircleCommand, vendorEnvironment } from "./circleAgent.js";
import { CIRCLE_REVIEW_ENTRY_HASHES, assertCircleReviewRequest, type CircleReviewRequest } from "./circleReviewTransport.js";

export interface DirectReviewSubmissionAdapter {
  readonly packageVersion: string;
  estimate(request: CircleReviewRequest): Promise<Record<string, string>>;
  submit(request: CircleReviewRequest): Promise<{ transactionId?: string; txHash?: Hex }>;
  lookup(request: CircleReviewRequest, transactionId?: string): Promise<{ transactionId?: string; hashes: Hex[] }>;
}
export type CircleReviewRunner = (entry: string, request: CircleReviewRequest) => Promise<unknown>;

function failure(code: string, message: string): CliError {
  return new CliError({ code, message,
    remediation: "Keep the saved review journal. Use --resume for read-only reconciliation; do not execute the call again after an uncertain response." });
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
  throw failure("DASKI_CIRCLE_REVIEW_PACKAGE_UNSUPPORTED", "The installed Circle entrypoint differs from the qualified 1.0.0/1.1.4 artifacts.");
}
export const spawnCircleReview: CircleReviewRunner = (entry, request) => {
  assertCircleReviewRequest(request);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./circleReviewChild.js", import.meta.url)), entry], {
      stdio: ["pipe", "pipe", "ignore"], env: circleReviewEnvironment(),
      timeout: 90_000, killSignal: "SIGKILL", windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 256 * 1024) child.kill("SIGKILL"); else chunks.push(chunk);
    });
    child.once("error", () => reject(failure("DASKI_CIRCLE_REVIEW_UNKNOWN", "The Circle review process could not complete.")));
    child.once("close", (status) => {
      if (status !== 0 || size > 256 * 1024) { reject(failure("DASKI_CIRCLE_REVIEW_UNKNOWN", "Circle did not return a definitive review result.")); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(failure("DASKI_CIRCLE_REVIEW_UNKNOWN", "Circle returned an unreadable review result.")); }
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
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? value as Hex : undefined;
}
/** Matching needs vendor identity/key AND exact payload. A nearby transaction is never enough. */
export function matchedCircleTransactions(value: unknown, request: CircleReviewRequest, transactionId?: string): { transactionId?: string; hashes: Hex[] } {
  const unwrapped = unwrap(value);
  const rows: unknown[] = Array.isArray(value) ? value : Array.isArray(unwrapped.transactions) ? unwrapped.transactions
    : Array.isArray(value && isRecord(value) ? value.data : null) ? (value as { data: unknown[] }).data : [];
  const matched = rows.filter(isRecord).filter(row => {
    const identity = transactionId ? row.id === transactionId : row.idempotencyKey === request.idempotencyKey;
    const calldata = row.callData ?? row.calldata;
    return identity && row.operation === "CONTRACT_EXECUTION" &&
      String(row.sourceAddress ?? "").toLowerCase() === request.wallet.toLowerCase() &&
      row.blockchain === (request.call.chainId === 8453 ? "BASE" : "BASE-SEPOLIA") &&
      String(row.contractAddress ?? row.destinationAddress ?? "").toLowerCase() === request.call.to.toLowerCase() &&
      typeof calldata === "string" && calldata.toLowerCase() === request.call.calldata.toLowerCase();
  });
  const ids = [...new Set(matched.map(row => identifier(row.id)).filter((id): id is string => !!id))];
  if (ids.length !== 1) return { hashes: [] };
  return { transactionId: ids[0]!, hashes: [...new Set(matched.map(row => hash(row.txHash)).filter((h): h is Hex => !!h))] };
}
export function createCircleReviewAdapter(options: { entry?: string; run?: CircleReviewRunner } = {}): DirectReviewSubmissionAdapter {
  const entry = options.entry ?? resolveCircleReviewEntry();
  const packageVersion = verifyCircleReviewEntry(entry);
  const run = options.run ?? spawnCircleReview;
  return {
    packageVersion,
    async estimate(request) {
      const data = unwrap(await run(entry, { ...request, mode: "estimate" }));
      const medium = unwrap(data.medium ?? data);
      // Only known scalar fee facts leave the child; no raw vendor response is logged.
      return Object.fromEntries(["gasLimit", "networkFee", "gasPrice", "maxFee"].flatMap(key =>
        typeof medium[key] === "string" && /^[0-9.]+$/.test(medium[key] as string) ? [[key, medium[key] as string]] : []));
    },
    async submit(request) {
      const data = unwrap(await run(entry, { ...request, mode: "execute" }));
      return { ...(identifier(data.id) ? { transactionId: identifier(data.id)! } : {}), ...(hash(data.txHash) ? { txHash: hash(data.txHash)! } : {}) };
    },
    async lookup(request, transactionId) {
      return matchedCircleTransactions(await run(entry, { ...request, mode: "lookup" }), request, transactionId);
    },
  };
}
