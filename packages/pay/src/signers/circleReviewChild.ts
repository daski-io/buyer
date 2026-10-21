/**
 * Dedicated child entry point. Never preload into the buyer or alter the
 * installed vendor. The vendor retains its existing credential store.
 * Each step that decides what Circle can execute is appended to the parent's
 * progress file before it is forwarded; a step that cannot be recorded is not
 * forwarded. Before the vendor loads, the review policy's fetch becomes the
 * child's only way to the network.
 */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  circleReviewArguments, circleReviewFetchPolicy, circleReviewPackageVersion, confineCircleReviewNetwork, type CircleReviewRequest,
} from "./circleReviewTransport.js";

async function main(): Promise<void> {
  const entry = process.argv[2];
  const progress = process.argv[3];
  if (!entry || !progress) throw new Error("Missing vendor entry or progress file");
  if (circleReviewPackageVersion(entry) === undefined) throw new Error("Vendor identity mismatch");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk as Buffer);
    if (size > 64 * 1024) throw new Error("Oversized review request");
    chunks.push(Buffer.from(chunk as Buffer));
  }
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CircleReviewRequest;
  const args = circleReviewArguments(request);
  globalThis.fetch = circleReviewFetchPolicy(request, await confineCircleReviewNetwork(),
    (event) => appendFileSync(progress, JSON.stringify(event) + "\n"));
  process.argv = [process.execPath, entry, ...args];
  await import(pathToFileURL(entry).href);
}
main().catch(() => { process.stderr.write("Circle review transport refused or could not complete the request.\n"); process.exitCode = 1; });
