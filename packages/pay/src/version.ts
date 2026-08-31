/** The published CLI version, read from the package manifest at build time. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(): string {
  // dist/version.js -> dist -> package root
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "..", "package.json"), join(here, "..", "..", "package.json")]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (parsed.name === "@daski/pay" && parsed.version) return parsed.version;
    } catch {
      // Try the next candidate.
    }
  }
  return "0.0.0-unknown";
}

export const CLI_VERSION = readVersion();
