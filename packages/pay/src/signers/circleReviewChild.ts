/**
 * Dedicated child entry point. Never preload into the buyer or alter the
 * installed vendor. The pinned vendor retains its existing credential store.
 * Each step that decides what Circle can execute is appended to the parent's
 * progress file before it is forwarded; a step that cannot be recorded is not
 * forwarded.
 */
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CIRCLE_REVIEW_ENTRY_HASHES, circleReviewArguments, circleReviewFetchPolicy, type CircleReviewRequest } from "./circleReviewTransport.js";

async function main(): Promise<void> {
  const entry = process.argv[2];
  const progress = process.argv[3];
  if (!entry || !progress) throw new Error("Missing vendor entry or progress file");
  const pkg = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")) as { name: string; version: string };
  if (pkg.name !== "@circle-fin/cli" || CIRCLE_REVIEW_ENTRY_HASHES[pkg.version] !== createHash("sha256").update(readFileSync(entry)).digest("hex")) throw new Error("Vendor integrity mismatch");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk as Buffer);
    if (size > 64 * 1024) throw new Error("Oversized review request");
    chunks.push(Buffer.from(chunk as Buffer));
  }
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CircleReviewRequest;
  const args = circleReviewArguments(request);
  globalThis.fetch = circleReviewFetchPolicy(request, globalThis.fetch,
    (event) => appendFileSync(progress, JSON.stringify(event) + "\n"));
  process.argv = [process.execPath, entry, ...args];
  await import(pathToFileURL(entry).href);
}
main().catch(() => { process.stderr.write("Circle review transport refused or could not complete the request.\n"); process.exitCode = 1; });
