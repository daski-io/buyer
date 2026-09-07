import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { provePackageBuild, verifyPackageProof } from "./package-artifacts.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("publishable artifact proof rejects stale output and exercises the actual packed CLI", () => {
  const orphan = join(root, "packages/pay/dist/obsolete-test-fixture.js");
  mkdirSync(dirname(orphan), { recursive: true });
  writeFileSync(orphan, "export const stale = true;\n");
  const proof = provePackageBuild();
  assert.equal(existsSync(orphan), false, "deleted source cannot leave obsolete published JavaScript");
  assert.deepEqual(proof.executions, { packedCliVersion: "PASS", packedChallengeRefusal: "PASS", missingPackedEntrypoint: "REJECTED", externalNetwork: "NOT_USED" });
  assert.equal(proof.packages.length, 2);
  assert.equal(verifyPackageProof(proof), true);
  const omitted = structuredClone(proof); delete omitted.executions.packedChallengeRefusal;
  assert.throws(() => verifyPackageProof(omitted), /execution proof is missing/);
  assert.throws(() => verifyPackageProof({ ...proof, packages: [] }), /Both exact candidate package proofs/);
  const output = join(root, "packages/pay/dist/version.js"), original = readFileSync(output);
  try {
    writeFileSync(output, Buffer.concat([original, Buffer.from("\n// changed after qualification\n")]));
    assert.throws(() => verifyPackageProof(proof), /compiled output changed/);
  } finally { writeFileSync(output, original); }
  const tarball = join(root, proof.packages[1].path), originalTar = readFileSync(tarball);
  try {
    writeFileSync(tarball, Buffer.concat([originalTar, Buffer.from("changed")]));
    assert.throws(() => verifyPackageProof(proof), /Packed package bytes changed/);
  } finally { writeFileSync(tarball, originalTar); }
  assert.equal(verifyPackageProof(proof), true);
});
