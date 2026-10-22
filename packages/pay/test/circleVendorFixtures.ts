/** Synthetic @circle-fin/cli installs, and the loopback sinks a vendor's escaped requests reach. */
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

/** An npm install of a synthetic @circle-fin/cli: its package.json, the entry point, and a PATH directory with `circle`. */
export function vendorPackage(t: TestContext, pkg: Record<string, unknown>, entry = "export {};\n") {
  const prefix = mkdtempSync(join(tmpdir(), "daski-circle-vendor-"));
  t.after(() => rmSync(prefix, { recursive: true, force: true }));
  const root = join(prefix, "node_modules", "@circle-fin", "cli");
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@circle-fin/cli", type: "module", bin: { circle: "dist/index.js" }, ...pkg }));
  writeFileSync(join(root, "dist", "index.js"), entry);
  mkdirSync(join(prefix, "bin"));
  symlinkSync(join(root, "dist", "index.js"), join(prefix, "bin", "circle"));
  return { prefix, root, entry: realpathSync(join(root, "dist", "index.js")), bin: join(prefix, "bin") };
}

/** The build a review child records for an entry point: the SHA-256 of its bytes. */
export const buildOf = (entry: string): string => createHash("sha256").update(readFileSync(entry)).digest("hex");

/** A loopback port nothing listens on: a connection attempt to it is refused by the system, not by the buyer. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Where a vendor's escaped request lands: an HTTP server and a UDP socket on
 * loopback that record what reaches them. Nothing leaves the machine.
 */
export async function escapeSink(t: TestContext): Promise<{ received: string[]; http: string; dns: string }> {
  const received: string[] = [];
  const http = createHttpServer((request, response) => { received.push("http " + request.url); response.end("ok"); });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const udp = createSocket("udp4");
  udp.on("message", () => received.push("dns"));
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
  t.after(() => { http.closeAllConnections(); http.close(); udp.close(); });
  return { received, http: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, dns: `127.0.0.1:${udp.address().port}` };
}
