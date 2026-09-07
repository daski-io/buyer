// Publication barrier for the CLI's exact dependency. Builds can overlap,
// but publishing the CLI requires an installable, provenance-verified scheme
// from this same release commit. No registry token is used.
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

export async function waitForScheme({ sha, version, request = fetch,
  deadline = Date.now() + 600_000, now = Date.now,
  pause = ms => new Promise(r => setTimeout(r, ms)), install = installAndVerify } = {}) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? "") || !/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("An exact release SHA and version are required");
  while (now() < deadline) {
    let response;
    try { response = await request("https://registry.npmjs.org/@daski%2fx402-scheme/" + version, { signal: AbortSignal.timeout(Math.min(30_000, deadline - now())) }); }
    catch { response = { status: 503 }; }
    if (response.status === 200) {
      const value = await response.json();
      if (value.gitHead !== sha || value.name !== "@daski/x402-scheme" || value.version !== version ||
          value.repository?.url !== "git+https://github.com/daski-io/buyer.git" || !value.dist?.integrity ||
          !value.dist?.attestations?.url?.startsWith("https://registry.npmjs.org/-/npm/v1/attestations/")) throw new Error("Scheme identity/provenance differs from this release");
      try { await install(version, Math.max(1, deadline - now())); return; }
      catch (error) { if (!error.propagating) throw error; }
    } else if (![404, 429, 500, 502, 503, 504].includes(response.status)) throw new Error("Scheme registry access refused");
    if (now() + 5000 >= deadline) break;
    await pause(5000);
  }
  throw new Error("Scheme installability deadline reached; CLI publication refused");
}

async function installAndVerify(version, remaining) {
  const directory = mkdtempSync(join(tmpdir(), "daski-scheme-barrier-"));
  const deadline = Date.now() + remaining;
  try {
    writeFileSync(join(directory, "package.json"), '{"private":true,"name":"scheme-proof","version":"1.0.0"}');
    for (const args of [["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "@daski/x402-scheme@" + version], ["audit", "signatures", "--json"]]) {
      if (Date.now() >= deadline) throw new Error("Scheme verification deadline reached");
      await new Promise((resolve, reject) => {
        const child = spawn("npm", args, { cwd: directory, stdio: ["ignore", "pipe", "pipe"], timeout: Math.min(180_000, deadline - Date.now()), killSignal: "SIGKILL" });
        let output = "";
        child.stdout.on("data", d => { output = (output + d).slice(-65536); }); child.stderr.on("data", d => { output = (output + d).slice(-65536); });
        child.on("error", () => reject(new Error("Scheme verifier could not start")));
        child.on("close", code => code === 0 ? resolve() : reject(Object.assign(new Error("Scheme installation/signature verification failed"), {
          propagating: !/EINTEGRITY|SIGNATURE|E401|E403|ENEEDAUTH/i.test(output) && /ETARGET|E404|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(output),
        })));
      });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] === import.meta.filename) {
  const manifest = JSON.parse(readFileSync(new URL("../packages/pay/package.json", import.meta.url), "utf8"));
  await waitForScheme({ sha: process.env.GITHUB_SHA, version: manifest.dependencies["@daski/x402-scheme"] });
  process.stdout.write("Exact scheme dependency is installable and verified\n");
}
