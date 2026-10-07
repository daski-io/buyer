/**
 * Balance and catalog reads outside the chain reader: a refused RPC read is
 * named without the URL path an API key sits in, and a catalog refresh skips
 * the cache exactly once.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBalances } from "../src/gateway/balance.js";
import { Catalog } from "../src/gateway/catalog.js";
import type { GatewayClient } from "../src/gateway/client.js";
import { CliError } from "../src/cli/errors.js";

const KEY = "not-a-real-key";

async function withRefusingRpc(status: number, run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: status === 429 ? -32016 : -32603, message: status === 429 ? "over rate limit" : "internal error" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try { await run(`http://127.0.0.1:${port}/v3/${KEY}`); } finally { server.close(); }
}

test("a refused balance read is named for the RPC's answer and never prints the key in the URL", async () => {
  for (const [status, code] of [[429, "DASKI_RPC_RATE_LIMITED"], [500, "DASKI_RPC_UNAVAILABLE"]] as const) {
    await withRefusingRpc(status, async (rpcUrl) => {
      await assert.rejects(readBalances({ rpcUrl, address: "0x30C8384C2e5477283D6ae38F1A929b8075EB5863",
        usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }), (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, code);
        assert.doesNotMatch(JSON.stringify(error.toJSON()), new RegExp(KEY));
        assert.match(error.message, /127\.0\.0\.1:\d+\/…/);
        return true;
      });
    });
  }
});

test("a catalog refresh reads the gateway again; an ordinary read uses the fresh cache", async () => {
  const previous = process.env.DASKI_HOME;
  const home = mkdtempSync(join(tmpdir(), "daski-catalog-"));
  process.env.DASKI_HOME = home;
  let reads = 0;
  const client = { gatewayUrl: "https://gateway.example", callTool: async () => {
    reads += 1;
    return { content: [], structuredContent: { payTo: "0x2222222222222222222222222222222222222222", token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      pricingMode: "fixed", splitter: { splitterAddress: "0x2222222222222222222222222222222222222222" }, terms: { providerTermsUrl: `https://provider.example/${reads}` } } };
  } } as unknown as GatewayClient;
  try {
    const catalog = new Catalog(client);
    assert.equal((await catalog.getOutcome("1", "form")).terms?.providerTermsUrl, "https://provider.example/1");
    assert.equal((await catalog.getOutcome("1", "form")).terms?.providerTermsUrl, "https://provider.example/1");
    assert.equal(reads, 1);
    assert.equal((await catalog.getOutcome("1", "form", { refresh: true })).terms?.providerTermsUrl, "https://provider.example/2");
    assert.equal((await catalog.getOutcome("1", "form")).terms?.providerTermsUrl, "https://provider.example/2", "the refreshed copy is cached");
    assert.equal(reads, 2);
  } finally {
    if (previous === undefined) delete process.env.DASKI_HOME; else process.env.DASKI_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
