// npm's `latest` follows the buyer the production gateway pins. The release
// engine dispatches the Promote workflow after a verified mainnet release
// (deploy-mainnet scripts/engine/buyer-latest.mjs); a testnet release publishes
// under `next`. Each package's trusted publisher for promote.yml may manage
// dist-tags and may not publish, so no registry token is used. `latest` moves
// only forward, and only to the provenance-attested build of tag v<version>.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const PACKAGES = ["@daski/x402-scheme", "@daski/pay"], REGISTRY = "https://registry.npmjs.org/";
const EXACT = /^\d+\.\d+\.\d+$/;
export const newer = (a, b) => {
  if (!EXACT.test(a ?? "")) return false;
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

export async function promoteLatest({ version, tagCommit, request = fetch, addTag = npmDistTag,
  pause = ms => new Promise(r => setTimeout(r, ms)), log = console.log } = {}) {
  if (!EXACT.test(version ?? "")) throw new Error("An exact version is required, such as 0.5.6");
  if (!/^[a-f0-9]{40}$/.test(tagCommit ?? "")) throw new Error("Tag v" + version + " is missing");
  const read = async path => {
    const response = await request(REGISTRY + path, { signal: AbortSignal.timeout(30_000), headers: { "cache-control": "no-cache" } });
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error("The registry is unavailable for " + path);
    return response.json();
  };
  const tags = async name => (await read("-/package/" + encodeURIComponent(name) + "/dist-tags")) ?? {};
  // Every package is verified before any tag moves.
  const moves = [];
  for (const name of PACKAGES) {
    const manifest = await read(encodeURIComponent(name) + "/" + version);
    if (!manifest) throw new Error(name + "@" + version + " is not on npm");
    if (manifest.name !== name || manifest.version !== version || manifest.gitHead !== tagCommit)
      throw new Error(name + "@" + version + " was not built from tag v" + version + " (" + tagCommit.slice(0, 7) + ")");
    if (!manifest.dist?.attestations?.url?.startsWith("https://registry.npmjs.org/-/npm/v1/attestations/"))
      throw new Error(name + "@" + version + " carries no provenance attestation");
    if (name === "@daski/pay" && manifest.dependencies?.["@daski/x402-scheme"] !== version)
      throw new Error("@daski/pay@" + version + " does not depend on @daski/x402-scheme@" + version + " exactly");
    const latest = (await tags(name)).latest;
    if (latest === version) log(name + ": latest is already " + version);
    else if (newer(latest, version)) log(name + ": latest " + latest + " is newer than " + version + "; left alone");
    else moves.push(name);
  }
  for (const name of moves) {
    await addTag(name, version);
    for (let attempt = 0; ; attempt++) {
      if ((await tags(name)).latest === version) { log(name + ": latest is now " + version); break; }
      if (attempt === 11) throw new Error(name + ": the registry does not show latest at " + version);
      await pause(5000);
    }
  }
  return moves;
}

function npmDistTag(name, version) {
  execFileSync("npm", ["dist-tag", "add", name + "@" + version, "latest"], { stdio: "inherit", timeout: 120_000 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.env.VERSION;
  if (!EXACT.test(version ?? "")) throw new Error("VERSION must be an exact version, such as 0.5.6");
  const tagCommit = execFileSync("git", ["rev-parse", "--verify", "refs/tags/v" + version + "^{commit}"], { encoding: "utf8" }).trim();
  await promoteLatest({ version, tagCommit });
}
