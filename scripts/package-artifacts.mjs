// Build and prove the exact publishable package bytes, without registry access,
// wallets, RPC calls or paid conformance. Paths in proof are repository relative.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = value => "sha256:" + createHash("sha256").update(value).digest("hex");
const fingerprint = value => hash(JSON.stringify(value));
const run = (cmd, argv, cwd = ROOT, env) => execFileSync(cmd, argv, { cwd, ...(env ? { env } : {}), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(directory, entry.name)) : [join(directory, entry.name)]).sort();
}
function inputs(root) {
  const tracked = run("git", ["ls-files", "-z"], root).split("\0").filter(Boolean).sort();
  return Object.fromEntries(tracked.map(path => [path, hash(readFileSync(join(root, path)))]));
}
function compiled(root) {
  return Object.fromEntries(["x402-scheme", "pay"].flatMap(name => files(join(root, "packages", name, "dist")))
    .map(path => [relative(root, path), hash(readFileSync(path))]));
}
export function verifyPackageProof(proof, root = ROOT) {
  if (proof.schemaVersion !== 1 || proof.status !== "PASS" ||
      proof.sourceHash !== fingerprint(proof.source) || proof.compiledHash !== fingerprint(proof.compiled) ||
      proof.sourceHash !== fingerprint(inputs(root)) || proof.compiledHash !== fingerprint(compiled(root))) throw new Error("Package proof source or compiled output changed");
  if (proof.toolchain.node !== process.version || proof.toolchain.npm !== run("npm", ["--version"], root).trim() ||
      proof.toolchain.typescript !== JSON.parse(readFileSync(join(root, "node_modules/typescript/package.json"))).version) throw new Error("Package proof toolchain changed");
  const checks = { packedCliVersion: "PASS", packedDoctor: "PASS", packedChallengeRefusal: "PASS", missingPackedEntrypoint: "REJECTED", externalNetwork: "NOT_USED" };
  if (Object.entries(checks).some(([key, value]) => proof.executions?.[key] !== value)) throw new Error("Required packed execution proof is missing");
  if (!Array.isArray(proof.packages) || proof.packages.length !== 2) throw new Error("Both exact candidate package proofs are required");
  for (const name of ["x402-scheme", "pay"]) {
    const manifest = JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8"));
    const matches = proof.packages.filter(p => p.name === manifest.name && p.version === manifest.version);
    if (matches.length !== 1) throw new Error("Candidate package identity is missing or duplicated");
    const artifact = matches[0];
    if (typeof artifact.path !== "string" || resolve(root, artifact.path) !== join(root, artifact.path) ||
        artifact.path.startsWith("../") || artifact.path.startsWith("/") || artifact.path.includes("/../")) throw new Error("Packed artifact path must stay in the repository");
    const bytes = readFileSync(join(root, artifact.path));
    if (artifact.sha256 !== hash(bytes) || artifact.integrity !== "sha512-" + createHash("sha512").update(bytes).digest("base64")) throw new Error("Packed package bytes changed");
  }
  return true;
}

export function provePackageBuild(output = join(ROOT, ".scratch/package-proof/proof.json"), root = ROOT) {
  if (!resolve(output).startsWith(resolve(root) + "/")) throw new Error("Package proof output must stay in the repository");
  const source = inputs(root), toolchain = { node: process.version, npm: run("npm", ["--version"], root).trim(),
    typescript: JSON.parse(readFileSync(join(root, "node_modules/typescript/package.json"))).version };
  // Removed source files must not survive as stale distributable JavaScript.
  for (const name of ["x402-scheme", "pay"]) {
    const target = resolve(root, "packages", name, "dist");
    if (!target.startsWith(resolve(root) + "/packages/")) throw new Error("Build output escaped repository");
    rmSync(target, { recursive: true, force: true });
  }
  run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--build", "--force"], root);
  if (fingerprint(source) !== fingerprint(inputs(root))) throw new Error("Source changed during package build");
  const build = compiled(root);
  const destination = join(dirname(resolve(output)), "tarballs"); mkdirSync(destination, { recursive: true });
  const temporary = mkdtempSync(join(tmpdir(), "buyer-packed-proof-"));
  const packages = [];
  try {
    const dependencies = join(temporary, "node_modules"); mkdirSync(join(dependencies, "@daski"), { recursive: true });
    // Only external dependency packages come from the lockfile's installed
    // tree. Both @daski packages below are extracted from actual tarballs.
    for (const entry of readdirSync(join(root, "node_modules"))) {
      if (entry === "@daski" || entry === ".bin") continue;
      symlinkSync(join(root, "node_modules", entry), join(dependencies, entry));
    }
    for (const name of ["x402-scheme", "pay"]) {
      const manifest = JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8"));
      const [packed] = JSON.parse(run("npm", ["pack", "--workspace", manifest.name, "--ignore-scripts", "--offline", "--json", "--pack-destination", destination], root));
      for (const file of packed.files) {
        if ((!file.path.startsWith("dist/") && !["package.json", "README.md", "LICENSE"].includes(file.path)) ||
            /(^|\/)(?:\.env[^/]*|node_modules|test|conformance|\.claude)(?:\/|$)/.test(file.path) || file.path.includes("..")) throw new Error("Package contains an unexpected file");
      }
      const tarball = join(destination, packed.filename), installed = join(dependencies, "@daski", name);
      mkdirSync(installed, { recursive: true });
      run("tar", ["-xzf", tarball, "-C", installed, "--strip-components=1"], root);
      const actual = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
      if (actual.name !== manifest.name || actual.version !== manifest.version) throw new Error("Packed manifest differs from candidate");
      for (const file of packed.files.filter(file => file.path.startsWith("dist/"))) {
        if (hash(readFileSync(join(installed, file.path))) !== build[`packages/${name}/${file.path}`]) throw new Error("Packed JavaScript differs from verified build");
      }
      packages.push({ name: manifest.name, version: manifest.version, path: relative(root, tarball), sha256: hash(readFileSync(tarball)), integrity: packed.integrity, files: packed.files.map(file => file.path) });
    }
    const pay = JSON.parse(readFileSync(join(dependencies, "@daski/pay/package.json"))), scheme = packages[0];
    if (pay.dependencies["@daski/x402-scheme"] !== scheme.version) throw new Error("CLI must pin the exact candidate scheme");
    const cli = join(dependencies, "@daski/pay", pay.bin.daski), env = {
      PATH: process.env.PATH, DASKI_HOME: join(temporary, "empty-home"), DASKI_KEY_BACKEND: "file",
    };
    const version = JSON.parse(run(process.execPath, [cli, "version", "--json"], temporary, env));
    if (version.version !== pay.version) throw new Error("Packed CLI reported the wrong version");
    const bad = join(temporary, "unsupported-challenge.json"); writeFileSync(bad, "{}");
    const refusal = spawnSync(process.execPath, [cli, "sign-payment", "--challenge", bad, "--json"], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
    if (refusal.status === 0 || JSON.parse(refusal.stdout).error !== "DASKI_CHALLENGE_UNRECOGNIZED") throw new Error("Packed CLI failed its actual challenge refusal boundary");
    // The packed doctor must report offline: the CLI writes its own default
    // config into an empty home, the profile is pointed at closed loopback
    // ports, and the report must still carry this version, the probed URL and
    // the unreachable-gateway issue rather than a crash, a prompt or a live probe.
    const doctorHome = join(temporary, "doctor-home"), doctorEnv = { ...env, DASKI_HOME: doctorHome };
    run(process.execPath, [cli, "budget", "--json"], temporary, doctorEnv);
    const config = JSON.parse(readFileSync(join(doctorHome, "config.json"), "utf8")), profile = config.profiles[config.defaultProfile];
    profile.gatewayUrl = "https://127.0.0.1:1"; profile.rpcUrl = "http://127.0.0.1:1";
    writeFileSync(join(doctorHome, "config.json"), JSON.stringify(config, null, 2) + "\n");
    const doctor = spawnSync(process.execPath, [cli, "doctor", "--json"], { cwd: temporary, env: doctorEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
    let report; try { report = JSON.parse(doctor.stdout); } catch { throw new Error("Packed CLI doctor did not emit a JSON report"); }
    if (doctor.status === 0 || report.cliVersion !== pay.version || report.ok !== false || report.gateway?.url !== profile.gatewayUrl ||
        report.gateway.reachable !== false || !report.issues?.some(issue => issue.code === "DASKI_GATEWAY_UNREACHABLE")) throw new Error("Packed CLI doctor did not report offline against the empty home");
    // Prove the smoke check cannot accidentally use the checkout's bin.
    renameSync(cli, cli + ".withheld");
    const broken = spawnSync(process.execPath, [cli, "version", "--json"], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
    renameSync(cli + ".withheld", cli);
    if (broken.status === 0) throw new Error("Broken packed CLI was not rejected");
    if (fingerprint(source) !== fingerprint(inputs(root)) || fingerprint(build) !== fingerprint(compiled(root))) throw new Error("Candidate changed during package qualification");
    const proof = { schemaVersion: 1, status: "PASS", source, sourceHash: fingerprint(source),
      compiled: build, compiledHash: fingerprint(build), toolchain, packages,
      executions: { packedCliVersion: "PASS", packedDoctor: "PASS", packedChallengeRefusal: "PASS", missingPackedEntrypoint: "REJECTED", externalNetwork: "NOT_USED" } };
    mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(resolve(output), JSON.stringify(proof, null, 2) + "\n");
    verifyPackageProof(proof, root);
    return proof;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { output: { type: "string" }, verify: { type: "string" } }, strict: true });
  if (values.verify) {
    verifyPackageProof(JSON.parse(readFileSync(resolve(values.verify), "utf8")));
    process.stdout.write("Package proof still matches source, build, toolchain and packed bytes.\n");
  } else {
    const proof = provePackageBuild(values.output);
    process.stdout.write(`Verified ${proof.packages.length} exact packed packages and offline CLI boundaries.\n`);
  }
}
