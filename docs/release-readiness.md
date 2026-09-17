# Release readiness

Releases of `@daski/pay` and `@daski/x402-scheme` are driven by a two-command
coordinator in the private release repository. `prep` makes the next release
green: it takes this repository's develop branch as the candidate, runs the
release checks, and fixes whatever blocks the release in the repository that
owns the problem, so a drifted wire shape is repaired here and in the gateway
rather than worked around at release time. `go` ships it. The coordinator only
checks that CI passed on the exact develop commit it is about to release,
publishes the packages through this repository's `Release` workflow (npm
trusted publishing with provenance), and moves nothing by hand: no local
build, no manual `npm publish`, no hand-made tag or merge. Everything a release
depends on is therefore proved by this repository's own CI on develop, which
is why develop must always be releasable.

## Definition of done for develop

A change is done when all of the following hold for the commit on develop:

- CI is green on every Node version in the matrix (20, 22 and 24), including
  the `gateway-contract` job.
- The workspace versions in `packages/*/package.json` are bumped in the same
  change that needs a new release. Both packages share a version and
  `@daski/pay` pins the exact `@daski/x402-scheme` version. The coordinator
  refuses a version that npm already has, so a change that needs shipping
  without a bump is not releasable.
- A change to the gateway pin or to any wire shape is a paired change with the
  gateway: the gateway regenerates `test/wire-fixtures/`, this repository
  re-vendors its copies under `test/fixtures/gateway-wire/` byte for byte, and
  the `gateway-contract` job proves the two agree. The offline wire tests then
  parse those exact shapes.
- `CHANGELOG.md` describes the change under the version that will ship it.
- Nothing was merged to `sandbox` or `main`, tagged or published by hand. The
  coordinator merges the release pull request into `sandbox`, the testnet
  release branch, tags that merge and publishes through the `Release`
  workflow, and only for a commit CI proved. `main` is the production branch
  and moves only by fast-forward to a release commit of `sandbox`, performed
  by the production coordinator.

## What CI proves

| Job | Guarantee |
|---|---|
| `build` (Node 20, 22, 24): `npm test` | A clean TypeScript build with no stale output; both workspaces packed without lifecycle scripts or registry access; tarball contents limited to `dist`, `package.json`, `README.md` and `LICENSE`; `@daski/pay` pins the exact candidate scheme version; the packed CLI, run in isolation from the checkout, reports the candidate version, produces a `doctor --json` report offline from an empty `DASKI_HOME`, refuses an unrecognised challenge before any signer is set up, and fails the check when its entrypoint is withheld; then both packages' offline test suites pass. |
| `build` (Node 20, 22, 24): after the tests | The examples typecheck against the built packages, and `.scratch/package-proof/proof.json` still binds every tracked source file, the toolchain, every compiled file and both tarballs after all checks; the proof is uploaded per Node version. |
| `gateway-contract` | Every wire fixture the gateway's `test/wire-fixtures/index.json` lists for `daski-buyer` is vendored under `test/fixtures/gateway-wire/` byte for byte against the gateway's develop branch, and no copy the gateway no longer lists remains. |

CI runs the same jobs on a push to `sandbox`, so the release merge commit has
its own run: production promotion reads that run as the proof for the exact
commit `main` moves to.

The `Release` workflow repeats the package proof on Node 24 and, before
publishing `@daski/pay`, waits until the exact `@daski/x402-scheme` version it
pins is installable from the registry.

Not covered by CI, by design: the conformance suite spends sandbox USDC against
a live gateway and stays a deliberate, human-run action (see
[conformance](./conformance.md)); installability of the published version,
its provenance and the pinned-CLI acceptance lane belong to the coordinator's
release evidence.

## Hand-off to the release agent

The release agent reads nothing but your commits. If a change needs anything at deploy time beyond merging and publishing, put it in git trailers on the commit that needs it, one per line at the end of the commit message:

```
Release-Scenarios: daski-pay
Release-Owner-Task: Circle conformance with the owner's account, see docs/conformance.md
Release-Rollback: the previous package version stays on npm; the gateway pin can move back
```

- `Release-Variable`: a variable a service must receive, written as `Release-Variable: gateway NAME=value before-deploy` (service `gateway`, `provider` or `daski-website`; value literal or `staged`, meaning the owner sets the real value on Railway; timing `before-deploy` or `after-deploy`). Never put a secret in a commit. A key added to `.env.example` must appear in a `Release-Variable` trailer, or `Release-Variable: none NAME` when it needs no deployment change.
- `Release-Requires`: an environment operation the owner must authorize: `new-epoch`, `reregister:<service>` or `contract-upgrade`.
- `Release-Scenarios`: the acceptance scenarios the change touches, so the release runs them.
- `Release-Owner-Task`: work only the owner can do after the release. It is listed once in the release summary and never asked during the release.
- `Release-Rollback`: one line on how to undo the change if the release is rolled back.

Do not write runbooks or instructions for the release agent anywhere else. CI runs `scripts/check-release-trailers.mjs` over every pushed commit.

## Publishing

Publication goes through `.github/workflows/release.yml` only. The workflow
takes the package to publish and the npm dist-tag to publish it under. `prep`
may publish a candidate version under the `next` dist-tag, so the coordinator
can prove the exact published bytes before the release; `go` publishes or
promotes `latest`. A version is immutable once it is on npm under either tag:
a defect found in a candidate is fixed on develop with a new version, never by
republishing the same one, and `latest` only ever moves to a version that CI
proved on develop.
