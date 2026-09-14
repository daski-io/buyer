/**
 * The gateway's well-known document is read once and each block validated on
 * its own; refusals whose next step is a flag of this CLI carry that flag in
 * their remediation; and no code path can send a transaction.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "../src/cli/errors.js";
import { gatewayRefusalRemediation, isRetryableGatewayCode } from "../src/gateway/client.js";
import { callAuthorizedLifecycleTool } from "../src/gateway/lifecycle.js";
import { parseGatewayMetadata, readGatewayMetadata } from "../src/gateway/metadata.js";
import { NOT_DEPLOYED_REMEDIATION } from "../src/signers/contract.js";

const DOCUMENT = {
  name: "daski-gateway",
  buyerCli: { package: "@daski/pay", version: "0.4.0", install: "npm install -g @daski/pay@0.4.0" },
  confirmationSigning: { chainId: 84532, eas: "0x4200000000000000000000000000000000000021", schemaUid: `0x${"ab".repeat(32)}`,
    reputationStorage: "0x3333333333333333333333333333333333333333" },
  payerAccounts: { types: ["eoa", "contract"], counterfactual: false },
  confirmation: { modes: ["sponsored", "direct"], sponsoredRequires: "eoa", attestationCap: 3, revocationAfterCap: true },
  signerClis: { "circle-agent": { package: "@circle-fin/cli", version: "1.2.3", repository: "git+https://github.com/circlefin/cli.git" } },
};

test("every block of the well-known document is parsed, and a malformed block reads as null", () => {
  const metadata = parseGatewayMetadata(DOCUMENT);
  assert.deepEqual(metadata.buyerCli, DOCUMENT.buyerCli);
  assert.deepEqual(metadata.confirmationSigning, { chainId: 84532, eas: "0x4200000000000000000000000000000000000021",
    schemaUid: `0x${"ab".repeat(32)}`, reputationStorage: "0x3333333333333333333333333333333333333333" });
  assert.deepEqual(metadata.payerAccounts, { types: ["eoa", "contract"], counterfactual: false });
  assert.deepEqual(metadata.confirmation, DOCUMENT.confirmation);
  assert.deepEqual(metadata.signerClis, DOCUMENT.signerClis);
  const sparse = parseGatewayMetadata({ ...DOCUMENT, confirmationSigning: { chainId: 84532, eas: "not-an-address" },
    payerAccounts: { types: "contract" }, signerClis: { "circle-agent": { version: "1" } } });
  assert.equal(sparse.confirmationSigning, null);
  assert.equal(sparse.payerAccounts, null);
  assert.deepEqual(sparse.signerClis, {});
  assert.equal(parseGatewayMetadata("nonsense").buyerCli, null);
});

test("the document is fetched from the gateway, and a failure is a retryable named error", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/.well-known/mcp.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(DOCUMENT));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  try {
    const metadata = await readGatewayMetadata(`http://127.0.0.1:${address.port}`);
    assert.deepEqual(metadata.payerAccounts?.types, ["eoa", "contract"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await assert.rejects(readGatewayMetadata("http://127.0.0.1:1", 500),
    (error: unknown) => error instanceof CliError && error.code === "DASKI_GATEWAY_METADATA_UNAVAILABLE" && error.details.retryable === true);
});

test("gateway refusals that this CLI can act on name the flag, and the retryable ones say so", async () => {
  assert.match(gatewayRefusalRemediation("CONFIRMATION_SPONSORED_REQUIRES_EOA", {}) ?? "", /--submission direct/);
  assert.match(gatewayRefusalRemediation("CONFIRMATION_SPONSORSHIP_LIMIT", { chainEligible: true }) ?? "", /--submission direct/);
  assert.doesNotMatch(gatewayRefusalRemediation("CONFIRMATION_SPONSORSHIP_LIMIT", { chainEligible: false }) ?? "", /--submission direct/);
  assert.equal(gatewayRefusalRemediation("SIGNATURE_COUNTERFACTUAL_REJECTED", {})?.includes(NOT_DEPLOYED_REMEDIATION), true);
  assert.match(gatewayRefusalRemediation("SIGNATURE_VERIFICATION_UNAVAILABLE", {}) ?? "", /retry/i);
  assert.equal(gatewayRefusalRemediation("SOMETHING_ELSE", {}), undefined);
  assert.equal(isRetryableGatewayCode("SIGNATURE_VERIFICATION_UNAVAILABLE"), true);
  assert.equal(isRetryableGatewayCode("CONFIRMATION_SUBMISSION_PENDING"), true);
  assert.equal(isRetryableGatewayCode("SIGNATURE_INVALID"), false);

  const client = { callTool: async () => ({ content: [], isError: true,
    structuredContent: { code: "SIGNATURE_VERIFICATION_UNAVAILABLE", message: "chain unreachable", next_action: "gateway text" } }) };
  await assert.rejects(callAuthorizedLifecycleTool({ client: client as never, signer: {} as never, toolName: "daski_confirm_delivery",
    action: "confirmation", orderHandle: "h", request: {}, chainId: 84532, gatewayUrl: "https://g.example" }),
    (error: unknown) => error instanceof CliError && error.code === "SIGNATURE_VERIFICATION_UNAVAILABLE" &&
      error.details.retryable === true && /retry/i.test(error.remediation));
});

test("no code path constructs a sending wallet client or a transaction", () => {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6 && !statSync(join(directory, "src"), { throwIfNoEntry: false })?.isDirectory(); depth += 1) {
    directory = dirname(directory);
  }
  const files: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder)) {
      const path = join(folder, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts")) files.push(path);
    }
  };
  walk(join(directory, "src"));
  assert.ok(files.length > 20, "the source tree was found");
  const forbidden = ["createWalletClient", "sendTransaction", "sendRawTransaction", "writeContract", "signTransaction", "walletActions", "prepareTransactionRequest"];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const token of forbidden) assert.ok(!source.includes(token), `${file} mentions ${token}`);
  }
});
