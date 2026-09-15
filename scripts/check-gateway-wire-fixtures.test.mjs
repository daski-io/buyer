import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONSUMER, GATEWAY_FIXTURES, VENDOR_DIR, compareGatewayWireFixtures } from "./check-gateway-wire-fixtures.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendored = readdirSync(join(root, VENDOR_DIR)).filter(name => name.endsWith(".json")).sort();
const bytes = Object.fromEntries(vendored.map(name => [name, readFileSync(join(root, VENDOR_DIR, name))]));

/** A gateway checkout holding `files`, whose index lists `listed` for the buyer and one fixture for another consumer. */
function gateway(directory, files, listed = Object.keys(files)) {
  const fixtures = join(directory, GATEWAY_FIXTURES); mkdirSync(fixtures, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(fixtures, name), content);
  writeFileSync(join(fixtures, "provider-only.json"), "{\"provider\":true}\n");
  writeFileSync(join(fixtures, "index.json"), JSON.stringify({ schemaVersion: 1, fixtures: {
    ...Object.fromEntries(listed.map(name => [name, { consumers: ["daski-test", CONSUMER] }])),
    "provider-only.json": { consumers: ["daski-provider"] },
  } }));
  return directory;
}
const failures = result => result.findings.filter(({ level }) => level === "FAIL").map(({ detail }) => detail);

test("the vendored gateway wire fixtures are exactly the files the gateway lists for the buyer", (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "buyer-gateway-wire-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  assert.ok(vendored.length > 0, "the buyer vendors gateway wire fixtures");
  const matching = compareGatewayWireFixtures(gateway(join(temporary, "matching"), bytes));
  assert.equal(matching.ok, true);
  assert.deepEqual(matching.findings.map(({ level }) => level), vendored.map(() => "ok"));

  const [first, ...rest] = vendored;
  const drifted = compareGatewayWireFixtures(gateway(join(temporary, "drifted"), { ...bytes, [first]: Buffer.concat([bytes[first], Buffer.from("\n")]) }));
  assert.equal(drifted.ok, false);
  assert.deepEqual(failures(drifted).map(detail => detail.split(" differs")[0]), [`${VENDOR_DIR}/${first}`]);

  const unvendored = compareGatewayWireFixtures(gateway(join(temporary, "unvendored"), { ...bytes, "new-shape.json": "{}\n" }));
  assert.ok(failures(unvendored).some(detail => detail.startsWith(`${VENDOR_DIR}/new-shape.json is not vendored`)));

  const stale = compareGatewayWireFixtures(gateway(join(temporary, "stale"), bytes, rest));
  assert.ok(failures(stale).some(detail => detail.startsWith(`${VENDOR_DIR}/${first} is not a fixture the gateway lists for ${CONSUMER}`)));

  const ghost = compareGatewayWireFixtures(gateway(join(temporary, "ghost"), bytes, [...vendored, "ghost.json"]));
  assert.ok(failures(ghost).some(detail => detail.startsWith(`ghost.json: listed for ${CONSUMER}`)));

  assert.equal(compareGatewayWireFixtures(join(temporary, "absent")).ok, false);
});
