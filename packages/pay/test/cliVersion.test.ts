/**
 * `doctor` compares the installed release with the one the gateway pins. On
 * 2026-09-04 a 0.1.0 install ran against a 0.1.2 pin that lived only in the
 * setup guide's prose, and every purchase it made was refused.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { compareReleaseVersions, pinnedBuyerCli } from "../src/gateway/client.js";

test("release versions compare numerically; anything but a plain release is not compared", () => {
  assert.ok(compareReleaseVersions("0.1.0", "0.1.2")! < 0);
  assert.ok(compareReleaseVersions("0.1.10", "0.1.2")! > 0);
  assert.equal(compareReleaseVersions("0.1.2", "0.1.2"), 0);
  assert.ok(compareReleaseVersions("1.0.0", "0.9.9")! > 0);
  assert.equal(compareReleaseVersions("0.0.0-unknown", "0.1.2"), null);
  assert.equal(compareReleaseVersions("0.1.3-rc.1", "0.1.2"), null);
  assert.equal(compareReleaseVersions("0.1.2", ""), null);
});

async function serve(body: unknown, status = 200): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url === "/.well-known/mcp.json") {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("the pinned release is read from the gateway's well-known document", async () => {
  const gateway = await serve({
    name: "daski-gateway",
    buyerCli: {
      package: "@daski/pay",
      version: "0.1.2",
      repository: "git+https://github.com/daski-io/buyer.git",
      install: "npm install -g @daski/pay@0.1.2",
    },
  });
  try {
    assert.deepEqual(await pinnedBuyerCli(gateway.url), {
      package: "@daski/pay",
      version: "0.1.2",
      install: "npm install -g @daski/pay@0.1.2",
    });
  } finally {
    await gateway.close();
  }
});

test("a gateway without a pin, or without the document, reads as no pin rather than an error", async () => {
  const bare = await serve({ name: "daski-gateway", tools: [] });
  try {
    assert.equal(await pinnedBuyerCli(bare.url), null);
  } finally {
    await bare.close();
  }
  const missing = await serve({}, 404);
  try {
    assert.equal(await pinnedBuyerCli(missing.url), null);
  } finally {
    await missing.close();
  }
  assert.equal(await pinnedBuyerCli("http://127.0.0.1:1", 500), null);
});
