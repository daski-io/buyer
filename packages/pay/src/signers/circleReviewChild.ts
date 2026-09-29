/**
 * Dedicated child entry point. Never preload into the buyer or alter the
 * installed vendor. The pinned vendor retains its existing credential store.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CIRCLE_REVIEW_ENTRY_HASHES, circleReviewArguments, circleReviewFetchPolicy, type CircleReviewRequest } from "./circleReviewTransport.js";

async function main(): Promise<void> {
  const entry = process.argv[2];
  if (!entry) throw new Error("Missing vendor entry");
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
  globalThis.fetch = circleReviewFetchPolicy(request, globalThis.fetch);
  process.argv = [process.execPath, entry, ...args];
  await import(pathToFileURL(entry).href);
}
main().catch(() => { process.stderr.write("Circle review transport refused or could not complete the request.\n"); process.exitCode = 1; });
