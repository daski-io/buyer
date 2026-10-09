import test from "node:test";
import assert from "node:assert/strict";
import { newer, promoteLatest } from "./promote-latest.mjs";

const sha = "a".repeat(40), version = "0.5.6";
const manifest = name => ({ name, version, gitHead: sha, dist: { attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/" + name + "@" + version } },
  ...(name === "@daski/pay" ? { dependencies: { "@daski/x402-scheme": version } } : {}) });
// The registry as the workflow reads it: version manifests and dist-tags, which a moved tag updates.
function registry({ latest = "0.5.5", change = {}, lag = 0 } = {}) {
  const tags = { "@daski/x402-scheme": latest, "@daski/pay": latest }, moved = [];
  const request = async url => {
    const path = decodeURIComponent(url.replace("https://registry.npmjs.org/", ""));
    const tagged = path.match(/^-\/package\/(.+)\/dist-tags$/);
    if (tagged) return { status: 200, json: async () => ({ latest: moved.length && lag-- > 0 ? "0.5.5" : tags[tagged[1]], next: version }) };
    const [, name, v] = path.match(/^(@daski\/[a-z0-9-]+)\/(.+)$/);
    if (v !== version) return { status: 404 };
    return { status: 200, json: async () => ({ ...manifest(name), ...change[name] }) };
  };
  return { request, moved, addTag: async (name, v) => { moved.push(name + "@" + v); tags[name] = v; }, pause: async () => {}, log: () => {} };
}

test("latest moves to the provenance-attested build of the tag, scheme first", async () => {
  const r = registry();
  assert.deepEqual(await promoteLatest({ version, tagCommit: sha, ...r }), ["@daski/x402-scheme", "@daski/pay"]);
  assert.deepEqual(r.moved, ["@daski/x402-scheme@0.5.6", "@daski/pay@0.5.6"]);
  const lagging = registry({ lag: 3 });
  await promoteLatest({ version, tagCommit: sha, ...lagging });
  assert.equal(lagging.moved.length, 2, "a registry that serves the new tag late is waited for");
});

test("latest already there or newer is left alone", async () => {
  for (const latest of ["0.5.6", "0.5.7", "0.6.0"]) {
    const r = registry({ latest });
    assert.deepEqual(await promoteLatest({ version, tagCommit: sha, ...r }), []);
    assert.deepEqual(r.moved, []);
  }
  assert.equal(newer("0.5.10", "0.5.9"), true); assert.equal(newer("0.5.5", "0.5.6"), false); assert.equal(newer(undefined, "0.5.6"), false);
});

test("a build from another commit, without provenance, with another scheme or missing moves no tag", async () => {
  const refused = async (options, pattern) => {
    const r = registry(options);
    await assert.rejects(promoteLatest({ version, tagCommit: sha, ...r }), pattern);
    assert.deepEqual(r.moved, [], "every package is verified before any tag moves");
  };
  await refused({ change: { "@daski/pay": { gitHead: "b".repeat(40) } } }, /@daski\/pay@0\.5\.6 was not built from tag v0\.5\.6/);
  await refused({ change: { "@daski/pay": { dist: {} } } }, /carries no provenance attestation/);
  await refused({ change: { "@daski/pay": { dependencies: { "@daski/x402-scheme": "^0.5.6" } } } }, /does not depend on @daski\/x402-scheme@0\.5\.6 exactly/);
  const r = registry();
  await assert.rejects(promoteLatest({ version: "0.5.7", tagCommit: sha, ...r }), /@daski\/x402-scheme@0\.5\.7 is not on npm/);
  await assert.rejects(promoteLatest({ version: "latest", tagCommit: sha, ...r }), /exact version/);
  await assert.rejects(promoteLatest({ version, tagCommit: "", ...r }), /Tag v0\.5\.6 is missing/);
  assert.deepEqual(r.moved, []);
});

test("a tag the registry never shows fails the promotion", async () => {
  const r = registry({ lag: 100 });
  await assert.rejects(promoteLatest({ version, tagCommit: sha, ...r }), /does not show latest at 0\.5\.6/);
});
