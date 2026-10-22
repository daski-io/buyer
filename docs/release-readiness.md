---
title: Release readiness
status: canonical
authority: current release-engine implementation and approved owner decisions
owner: repository maintainers
effective-date: 2026-10-16
last-verified: 2026-10-16
supersedes: split-coordinator and pre-handover descriptions where inconsistent
superseded-by: none
sensitivity: public-safe
related-repositories: daski-io/buyer; daski-io/deploy-mainnet
review-trigger: release process, interface or CI change
---

# Release readiness

Releases of `@daski/pay` and `@daski/x402-scheme` are driven by the engine in
[daski-io/deploy-mainnet](https://github.com/daski-io/deploy-mainnet), for both
sandbox and production. Read its current instructions for owner authorization,
release selection and additional stops. The gateway pins the exact CLI version;
a testnet `release` can publish a missing candidate through this repository's
trusted Release workflow under `next`. Plain `prep` never publishes. A verified
mainnet release advances `latest` through the Promote workflow. Local builds,
manual `npm publish`, hand-made tags or release-branch merges are not substitutes.
Everything needed by a release must be proved on the exact owning commit; fix
blockers here and in paired consumers before releasing.

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
- Nothing was merged to `sandbox` or `main`, tagged or published by hand.
  For a missing gateway-pinned version, the engine tags the CI-proved buyer
  develop head at that version and invokes the trusted Release workflow.
  Repository branch history and npm dist-tags are managed by the engine's
  current package flow, not by a contributor's local release script.

## What CI proves

| Job | Guarantee |
|---|---|
| `build` (Node 20, 22, 24): `npm test` | A clean TypeScript build with no stale output; both workspaces packed without lifecycle scripts or registry access; tarball contents limited to `dist`, `package.json`, `README.md` and `LICENSE`; `@daski/pay` pins the exact candidate scheme version; the packed CLI, run in isolation from the checkout, reports the candidate version, produces a `doctor --json` report offline from an empty `DASKI_HOME`, refuses an unrecognised challenge before any signer is set up, and fails the check when its entrypoint is withheld; then both packages' offline test suites pass. |
| `build` (Node 20, 22, 24): after the tests | The examples typecheck against the built packages, and `.scratch/package-proof/proof.json` still binds every tracked source file, the toolchain, every compiled file and both tarballs after all checks; the proof is uploaded per Node version. |
| `gateway-contract` | Every wire fixture the gateway's `test/wire-fixtures/index.json` lists for `daski-buyer` is vendored under `test/fixtures/gateway-wire/` byte for byte against the gateway's develop branch, and no copy the gateway no longer lists remains. |

CI also runs on pushes to the configured history branches. The engine proves
the exact source/package commit it selects; do not manufacture a sandbox merge
as a prerequisite for package publication.

The separate Circle CLI workflow (`circle-cli.yml`) watches the vendor rather
than this repository's commits. Every week, and on demand for any version, it
installs `@circle-fin/cli` 1.2.0 and Circle's latest release and runs the
offline adapter tests against each, the real CLI running a whole review against
a fake of Circle's API. It is an early warning only: Circle's setup installs
its latest release at once, so agents may run a build before the workflow has
seen it. A failure means that release breaks reviews; fix the adapter here and
release it. Because it runs vendor code nobody here reviewed, it has a
read-only token, no secrets, no persisted checkout credentials, actions pinned
by commit and no npm cache. It is not part of the package proof or the
engine's release evidence.

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

Publication goes through `.github/workflows/release.yml` only. When a candidate
gateway pins a version missing from npm, the owner's testnet `release` can tag
the green buyer develop head and publish both packages under `next` before its
prep finishes. Plain `prep` reports a missing version and never publishes it.
After verified mainnet serving, the engine uses `.github/workflows/promote.yml`
to move `latest` forward to the version the production gateway pins. Promote
moves dist-tags; it does not publish new package bytes. Failed post-release
promotion is retried through the engine's bookkeeping operation.

A version is immutable once published under any tag. Fix a candidate defect on
develop with a new version; never republish the same one. Read the engine's
current instructions before any tag, publish or promotion operation.
