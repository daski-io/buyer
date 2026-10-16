---
title: buyer agent instructions
status: canonical
authority: repository implementation and current release-engine decisions
owner: repository maintainers
effective-date: 2026-10-16
last-verified: 2026-10-16
supersedes: earlier local-path or split-coordinator guidance where inconsistent
superseded-by: none
sensitivity: public-safe
related-repositories: daski-io/buyer; see interface owners below
review-trigger: architecture, toolchain, interface or release-process change
---

# Buyer contributor guide

Owns `@daski/pay` and `@daski/x402-scheme`. Read `docs/release-readiness.md`,
`docs/conformance.md`, package READMEs and key-storage guidance for the affected code.
This repository owns the client, not gateway or provider behavior.

## Implementation and paired changes

- Preserve existing wallets, signer identities, budgets and pending payment intents.
  Reconcile signed or ambiguous payments before any retry. Never create/fund wallets
  or change budgets as an incidental setup/test step.
- Gateway wire fixtures under `test/fixtures/gateway-wire/` are exact copies from the
  gateway's indexed fixtures. A protocol change is paired with its owner and consumers.
- The two packages share a version and the CLI pins the exact scheme version. A change
  requiring publication also updates version/changelog and coordinates the gateway's
  exact CLI pin, website instructions and harness CLI lane.
- npm versions are immutable. Publication and `latest` promotion are engine operations
  through the trusted Release/Promote workflows, never a local `npm publish` shortcut.

## Local checks

Package engines allow Node >=20; CI proves Node 20/22/24 and publishing uses Node 24.
Use the current workflows and lockfile. `npm test` includes offline suites and package
proof; run `npm run typecheck`, the example typecheck and package-proof verification
as required by `docs/release-readiness.md`. Build/proof commands live in `package.json`.
Live conformance and acceptance can spend and are separate authorized operations;
ordinary development checks use isolated fixtures and no customer state.

## Shared work and release boundary

These instructions apply to every agent and contributor. `AGENTS.md` is canonical;
`CLAUDE.md` only imports it. Read this guide, README, relevant nested instructions,
Git status, package/toolchain files and CI before editing. If working from a shared
Daski workspace, explicitly read its root guide, repository map and development
workflow too; a standalone clone must remain usable without private workspace paths.

Use one task branch/worktree and one writer per checkout. Preserve other work.
Identify affected sibling repositories, interface consumers and tests before changing
a shared contract. Keep durable implementation knowledge in tracked docs and private
operational material in its owning private system, not in assistant memory.

Work targets `develop` or a reviewed branch into it. Integration is distinct from
release. The release engine in [daski-io/deploy-mainnet](https://github.com/daski-io/deploy-mainnet)
owns **both sandbox and production**. Read its current `AGENTS.md`,
`docs/release-map.md`, `docs/runbooks/release-engine.md` and handoff schema before an
operation. Never substitute a direct `main`/`sandbox` push or merge, Railway deploy,
package publication or contract broadcast for that process. Even engine `prep` can
sign a catalog epoch or propose a Safe batch; it is not an unsigned local check.
A build request does not authorize release, paid tests, signing or business actions.
Use existing owner authorization within its scope and honor the engine's actual stops.

Keep secrets, customer data, private audits and raw operational logs out of commits.
Never add AI attribution or co-author trailers to commits or pull requests.
