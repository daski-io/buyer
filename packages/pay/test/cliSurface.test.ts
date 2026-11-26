/**
 * The command surface an agent reads: `daski help` says the package is a
 * command-line tool with no library API and lists the asset and free-skill
 * commands; `--input` takes one JSON object, inline or from a file.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inputFlag } from "../src/cli/args.js";
import { CliError } from "../src/cli/errors.js";
import { gatewayRefusalRemediation, stillBeingDelivered } from "../src/gateway/client.js";
import { purchaseFailure } from "../src/gateway/purchase.js";

const code = (wanted: string) => (error: unknown): boolean => error instanceof CliError && error.code === wanted;
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "bin", "daski.js");

function daski(args: string[]): { stdout: string; status: number } {
  const home = mkdtempSync(join(tmpdir(), "daski-cli-surface-"));
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: "utf8", env: { ...process.env, DASKI_HOME: home }, stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; status?: number };
    return { stdout: failed.stdout ?? "", status: failed.status ?? 1 };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("help says it is a command-line tool, not a library, and lists the result and free-skill commands", () => {
  const { stdout, status } = daski(["help"]);
  assert.equal(status, 0);
  assert.match(stdout, /@daski\/pay is a command-line tool, not a library/);
  assert.match(stdout, /It has no API to import from a script\./);
  assert.match(stdout, /asset action --order <handle> --action <actionId>/);
  assert.match(stdout, /asset action --provider <id> --asset <providerAssetId\|identifier> --action <actionId>/);
  assert.match(stdout, /asset list \[--provider <id>\]/);
  assert.match(stdout, /free-skill --provider <id> --skill <skillId>/);
});

test("the new commands refuse unknown flags and missing values before doing anything", () => {
  const missing = daski(["free-skill", "--skill", "get-pricing", "--json"]);
  assert.notEqual(missing.status, 0);
  assert.equal(JSON.parse(missing.stdout).error, "DASKI_FLAG_REQUIRED");
  const unknown = daski(["asset", "action", "--action", "get-server", "--asset-id", "x", "--json"]);
  assert.equal(JSON.parse(unknown.stdout).error, "DASKI_UNKNOWN_FLAG");
  const subcommand = daski(["asset", "use", "--json"]);
  assert.equal(JSON.parse(subcommand.stdout).error, "DASKI_UNKNOWN_SUBCOMMAND");
  const wait = daski(["free-skill", "--provider", "8327", "--skill", "get-pricing", "--wait", "soon", "--json"]);
  assert.equal(JSON.parse(wait.stdout).error, "DASKI_FLAG_INVALID");
});

test("--input is one JSON object, inline or from --input-file, never both", () => {
  assert.equal(inputFlag({}), undefined);
  assert.deepEqual(inputFlag({ input: '{"keyId":"inf_1"}' }), { keyId: "inf_1" });
  const dir = mkdtempSync(join(tmpdir(), "daski-input-"));
  try {
    const file = join(dir, "input.json");
    writeFileSync(file, '{"vcpu": 2}\n');
    assert.deepEqual(inputFlag({ "input-file": file }), { vcpu: 2 });
    assert.throws(() => inputFlag({ input: "{}", "input-file": file }), code("DASKI_INPUT_INVALID"));
    assert.throws(() => inputFlag({ "input-file": join(dir, "missing.json") }), code("DASKI_INPUT_INVALID"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => inputFlag({ input: "keyId=inf_1" }), code("DASKI_INPUT_INVALID"));
  assert.throws(() => inputFlag({ input: "[1]" }), code("DASKI_INPUT_INVALID"));
  assert.throws(() => inputFlag({ input: true }), code("DASKI_FLAG_NEEDS_VALUE"));
});

test("next-step commands name the real order or intent when the CLI knows it", () => {
  const refusal = { content: [], isError: true, structuredContent: { code: "SETTLEMENT_TIMEOUT", message: "unknown outcome" } };
  assert.ok(purchaseFailure(refusal, { afterSubmit: true, intentId: "int_abc" }).remediation.includes("daski order reconcile int_abc"));
  assert.ok(gatewayRefusalRemediation("ORDER_ACTION_UNSUPPORTED", undefined, "ord_9")!.includes("daski order status ord_9"));
  assert.ok(gatewayRefusalRemediation("ARTIFACT_NOT_AVAILABLE", undefined, "ord_9")!.includes("daski order status ord_9 --json"));
  assert.ok(gatewayRefusalRemediation("ARTIFACT_NOT_AVAILABLE", { message: "The order is paid and still being delivered; it has no artifact yet" },
    "ord_9")!.includes("nothing failed"));
  assert.ok(gatewayRefusalRemediation("PROVIDER_LIFECYCLE_UNAVAILABLE", undefined)!.includes("daski order status <handle>"),
    "without a known order the placeholder stays");
  assert.ok(stillBeingDelivered("ARTIFACT_NOT_AVAILABLE", { message: "The order is paid and still being delivered; it has no artifact yet" }));
  assert.equal(stillBeingDelivered("ARTIFACT_NOT_AVAILABLE", { message: "The order has no artifact: it is neither completed nor recovered" }),
    false, "an order that ended without a result is not 'still being delivered'");
  // A gateway that states deliveryState is read by it, not by its wording.
  assert.ok(stillBeingDelivered("ARTIFACT_NOT_AVAILABLE", { message: "No artifact yet", deliveryState: "delivering" }));
  assert.equal(stillBeingDelivered("ARTIFACT_NOT_AVAILABLE",
    { message: "The order is paid and still being delivered; it has no artifact yet", deliveryState: "not_delivering" }), false);
});
