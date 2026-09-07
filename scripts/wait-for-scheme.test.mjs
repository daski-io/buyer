import test from "node:test";
import assert from "node:assert/strict";
import { waitForScheme } from "./wait-for-scheme.mjs";
const sha = "a".repeat(40), version = "1.2.3";
const manifest = { name: "@daski/x402-scheme", version, gitHead: sha,
  repository: { url: "git+https://github.com/daski-io/buyer.git" }, dist: { integrity: "sha512-test", attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/test" } } };

test("publication barrier waits for registry propagation and an installable exact scheme", async () => {
  let clock = 0, reads = 0, installs = 0;
  await waitForScheme({ sha, version, now: () => clock, deadline: 20000, pause: async ms => { clock += ms; },
    request: async () => ++reads === 1 ? { status: 404 } : { status: 200, json: async () => manifest },
    install: async () => { if (++installs === 1) throw Object.assign(new Error("ETARGET"), { propagating: true }); },
  });
  assert.equal(reads, 3); assert.equal(installs, 2); assert.equal(clock, 10000);
});

test("wrong scheme commit and invalid signatures fail before CLI publication", async () => {
  let installs = 0;
  await assert.rejects(waitForScheme({ sha, version, request: async () => ({ status: 200, json: async () => ({ ...manifest, gitHead: "b".repeat(40) }) }),
    install: async () => { installs++; },
  }), /differs/);
  assert.equal(installs, 0);
  await assert.rejects(waitForScheme({ sha, version, request: async () => ({ status: 200, json: async () => manifest }),
    install: async () => { installs++; throw new Error("invalid signatures"); },
  }), /invalid signatures/);
  assert.equal(installs, 1);
});

test("unpublished scheme reaches its deadline without invoking publication", async () => {
  let clock = 0;
  await assert.rejects(waitForScheme({ sha, version, now: () => clock, deadline: 10000, pause: async ms => { clock += ms; },
    request: async () => ({ status: 404 }), install: async () => { throw new Error("unexpected install"); },
  }), /deadline/);
});
