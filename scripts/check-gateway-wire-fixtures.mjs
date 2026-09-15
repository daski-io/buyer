#!/usr/bin/env node
// check-gateway-wire-fixtures.mjs — the buyer's half of the gateway wire contract.
//
// The gateway generates its wire shapes (MCP results, the prepared payment
// challenge, the payment-identifier and order-binding extensions, wallet and
// order-action challenge envelopes, the standard error envelope, the
// confirmation request shapes and direct call) from its real builders into
// test/wire-fixtures/ and lists in index.json which consumer vendors each
// file. This repository vendors its files byte for byte under
// test/fixtures/gateway-wire/ and parses them in its offline wire tests, so a
// shape change is met here rather than inside a paid acceptance run.
//
// This script proves the vendored copies ARE the gateway's current shapes for
// the daski-buyer consumer: every file the gateway lists for daski-buyer must
// be vendored and byte-identical, and no unlisted copy may remain (a stale
// fixture is a test that proves yesterday's shape). CI runs it against a
// shallow clone of the gateway's develop branch in the gateway-contract job.
//
// Usage: node scripts/check-gateway-wire-fixtures.mjs --gateway <gateway checkout>
// Exit 0 when the contract holds, 1 otherwise, naming each drifted file.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const CONSUMER = "daski-buyer";
export const GATEWAY_FIXTURES = "test/wire-fixtures";
export const VENDOR_DIR = "test/fixtures/gateway-wire";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function compareGatewayWireFixtures(gateway, root = ROOT, consumer = CONSUMER) {
  const indexPath = join(gateway, GATEWAY_FIXTURES, "index.json");
  if (!existsSync(indexPath)) {
    return { ok: false, findings: [{ level: "FAIL", detail: `gateway wire fixtures missing: ${indexPath}` }] };
  }
  let index;
  try {
    index = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch (error) {
    return { ok: false, findings: [{ level: "FAIL", detail: `${indexPath} is not valid JSON: ${error.message}` }] };
  }
  const findings = [];
  const listed = [];
  for (const [file, meta] of Object.entries(index.fixtures ?? {})) {
    const consumers = Array.isArray(meta?.consumers) ? meta.consumers : [];
    if (!consumers.includes(consumer)) continue;
    listed.push(file);
    const source = join(gateway, GATEWAY_FIXTURES, file);
    const vendored = join(root, VENDOR_DIR, file);
    if (!existsSync(source)) {
      findings.push({ level: "FAIL", detail: `${file}: listed for ${consumer} in index.json but missing from the gateway` });
    } else if (!existsSync(vendored)) {
      findings.push({
        level: "FAIL",
        detail: `${VENDOR_DIR}/${file} is not vendored — copy it from the gateway's ${GATEWAY_FIXTURES}/ and cover it in the wire tests`,
      });
    } else if (readFileSync(source).equals(readFileSync(vendored))) {
      findings.push({ level: "ok", detail: `${file} matches the gateway` });
    } else {
      findings.push({
        level: "FAIL",
        detail: `${VENDOR_DIR}/${file} differs from the gateway's ${GATEWAY_FIXTURES}/${file} — re-vendor it byte for byte and rerun the wire tests`,
      });
    }
  }
  if (listed.length === 0) findings.push({ level: "FAIL", detail: `index.json lists no fixture for ${consumer}` });
  const vendorDir = join(root, VENDOR_DIR);
  for (const name of existsSync(vendorDir) ? readdirSync(vendorDir).sort() : []) {
    if (name.endsWith(".json") && !listed.includes(name)) {
      findings.push({ level: "FAIL", detail: `${VENDOR_DIR}/${name} is not a fixture the gateway lists for ${consumer} — remove it` });
    }
  }
  return { ok: findings.every(({ level }) => level === "ok"), findings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { gateway: { type: "string" } }, strict: true });
  if (!values.gateway) {
    process.stderr.write("usage: node scripts/check-gateway-wire-fixtures.mjs --gateway <gateway checkout>\n");
    process.exit(2);
  }
  const result = compareGatewayWireFixtures(resolve(values.gateway));
  for (const { level, detail } of result.findings) process.stdout.write(`  ${level.padEnd(4)} ${detail}\n`);
  process.stdout.write(`gateway wire fixtures for ${CONSUMER}: ${result.ok ? "PASS" : "FAIL"}\n`);
  if (!result.ok) process.exitCode = 1;
}
