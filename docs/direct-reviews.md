# Direct Circle delivery reviews

A Circle agent wallet is a contract account, so its delivery review is a
direct EAS `attest` or `revoke` that the wallet sends itself; Daski sponsors
reviews for plain wallets only. A direct review is prepare-only by default.
Choose the review, inspect its validated call and callHash, then use:

~~~bash
daski order confirm <handle> --estimate --json
daski order confirm <handle> --submit --approve-call <callHash> --json
daski order confirm <handle> --resume --json
~~~

The same actions apply to a prepared revocation. Estimation sends no
transaction. Submission requires the exact saved callHash, a deployed Circle
agent wallet matching the payer, fresh chain validation, and the gateway's
separate execution capability, `confirmation.directReview.circleExecute: true`
in `/.well-known/mcp.json` (`daski doctor --json` shows it). Without it,
`--submit` refuses with `DASKI_CIRCLE_EXECUTION_NOT_QUALIFIED`, sends nothing
and keeps the prepared review. Do not send the call with
`circle wallet execute` instead: only the buyer CLI journals the submission,
so it can be resumed and verified. An explicitly authorized Base
Sepolia conformance run can use `--qualify-circle-execution` with
`DASKI_CONFORMANCE_SPEND_OK=1` to generate the initial evidence; this
candidate lane never bypasses mainnet qualification. A signing or estimation
conformance result does not enable execution.

The buyer trusts the installed Circle CLI, as signing does. It runs any
@circle-fin/cli release from 1.2.0 on, so a new Circle release needs no new
buyer. The `circle` found on PATH must be the entry point that its own
package.json, in the package named @circle-fin/cli, declares as its `circle`
binary, at a release (not a prerelease) of 1.2.0 or later; the child checks it
again before it loads anything. That is a sanity check against the wrong
install, not proof of what the package is: anything that can write beside the
CLI can write that package.json too. Anything else, 1.1.4 included, is refused
with `DASKI_CIRCLE_REVIEW_PACKAGE_UNSUPPORTED` before anything is sent.
Circle's own version policy refuses every command below 1.1.4. The adapter
starts a dedicated Node child without a shell, preload hooks, proxy overrides
or Daski environment secrets. It never edits the installed CLI.

The child's request policy permits, at the official Circle agent endpoint of
the profile's environment, only the requests a `wallet execute` sends: the
wallet listing, the contract execution request, Circle's configuration and the
bound challenge, that challenge's approval, and reads of the one transaction
the completed challenge names. Both the estimate and the execution carry the
approved EAS attest/revoke call's exact calldata in place of the signature and
parameters the CLI builds: Circle cannot execute the review's tuple argument
from parameters (observed live on Base Sepolia). All destination, wallet,
chain, ABI parameters, zero value and idempotency fields must match; the
re-encoded calldata must be exact. Transfer, deploy, cancel, accelerate,
arbitrary requests and cross-environment requests fail. These are correctness
guards: they keep a CLI that builds another request from sending it.

Before the CLI loads, the child also confines its network: Node's HTTP, HTTPS,
HTTP/2, TLS and socket clients, the dispatcher undici clients share and
WebSocket refuse every use but the policy's fetch to Circle's endpoint, so a
release that moved its requests to one of them fails at that request. The
confinement is a correctness aid, not a credential boundary: worker threads,
child processes, DNS, UDP, native addons, `process.binding` and the inspector
are not confined, and code that rewrites the call stack passes its TLS check.

## Qualified builds

The buyer cannot know what an unreviewed build sends outside the policy, so it
believes that a run sent nothing only of a qualified build: one whose review
requests were reviewed request by request. `CIRCLE_REVIEW_QUALIFIED_BUILDS`
lists each by the exact SHA-256 of its `dist/index.js`. Today that is 1.2.0
alone (`feb24e3d404b41bfda54ff69b397c892a3c007487f7831904c2617d036afd9b9`). A
build is added only by a reviewed buyer release. The child records the SHA-256
of the build it loads before any of its code runs, and the journal keeps it.

That changes one thing, the "nothing was sent" fast path. A run on a qualified
build that recorded no approval answers `DASKI_CIRCLE_REVIEW_NOT_STARTED` and
restores the prepared review for another submit. On any other build such a run
answers `DASKI_CIRCLE_REVIEW_UNKNOWN`: it may have sent its approval another
way, so its journal is kept, `--resume` reconciles it through Circle's history
and the chain, and the call is not submitted again while the record is open.
A run whose CLI never loaded, such as one that could not create its progress
file, sent nothing on any build. Everything else works the same on every build.

Every week, and on demand for any version, CI installs 1.2.0 and Circle's
latest release and runs a whole review through each against a fake of
Circle's API. That is an early warning only: Circle's setup installs its latest
release at once, so agents may run a build before CI has seen it.

This child runs within Circle's credential boundary: the CLI can read its
existing userToken, encryptionKey, encryptedUserSecret and storageKey, as it
does when signing. Daski creates no additional credential store and never logs
vendor output or errors.

## What is recorded

Before the first execution call, Daski atomically records a stable
idempotency key, package version, exact call binding, the profile chain's
final height and submissionStarted. While the vendor runs, the child appends
to a private progress file the build it loads and, before forwarding it, each
step that decides what Circle can do: the execution request, the challenge
Circle issued, that challenge's approval, and the transaction and state the
challenge names. A step that cannot be recorded is not forwarded. Circle
executes only an approved challenge, so on a qualified build a run that
recorded no approval (an expired session or a refused request) restores the
prepared review and answers `DASKI_CIRCLE_REVIEW_NOT_STARTED`: nothing was
sent, and the same approved call can be submitted again. So does a run that
could not create its progress file and so never started, on any build. Any
other failure, a timeout, an unreadable result, or a run without a recorded
approval on a build that is not qualified, keeps the record with every
identity Circle gave and answers `DASKI_CIRCLE_REVIEW_UNKNOWN`. A started
vendor operation is never executed again: `--submit` is refused while its
record is open.

## Recovery

Resume performs only vendor reads and chain checks; it never calls wallet
execute, cancel or accelerate. It asks Circle's history for the transaction by
the challenge's transaction ID, otherwise by the exact call created after the
submission started: Circle CLI 1.2 prints neither the idempotency key nor the
calldata, so the call is re-encoded from the echoed signature and parameters.
A nearby transaction is never enough, and more than one candidate is never
proof that nothing happened. When Circle's history does not close the record,
or cannot be read, resume searches the chain from the recorded final height
for the pinned EAS's Attested (or Revoked) event with the payer as attester and
the prepared recipient and schema, whose attestation binds to the prepared
call. A hash found anywhere else can be added with `--tx <hash>`.

Transaction IDs can retain multiple replacement hashes. Every candidate is
verified as `--check` verifies one: a final EAS event and attestation binding
are necessary to close the journal; an ERC-4337 outer success or vendor
COMPLETE status alone is insufficient. A started vendor operation cannot be
abandoned locally until Circle reports its transaction FAILED, DENIED or
CANCELLED and no recorded hash executed the call; until then, retain it and
reconcile rather than creating a second execution. A record kept only because
its build is not qualified closes the same way. If that run in fact sent
nothing, neither ever happens: the record stays open, and this journal does
not submit that order's review again.

## Reviews prepared before 0.5.0

Earlier buyers saved a prepared direct review's hash and binding but not the
call, so `--estimate` and `--submit` refuse it with
`DASKI_CONFIRMATION_NOT_PREPARED`. Prepare the same choice again: when the new
call has the saved callHash, the record is restored with its call
(`restored: true`) and keeps its original preparation time. A different choice
is refused; if the earlier call was never sent, `--abandon` clears it first.

Offline tests cover transport scope, network confinement and what passes it
(Node's real fetch to Circle's host), the package identity and version floor,
qualified builds, the Circle CLI's request sequence and printed history, tuple
shape, preserved auth headers, journal crash windows, progress recording, hash
lineage, chain discovery and read-only resume. Fake CLIs that are not qualified
send their approval through a worker thread, a child process, a DNS query, or
a TLS connection after forging the call stack, and each run ends
`DASKI_CIRCLE_REVIEW_UNKNOWN` with its journal kept. With
`DASKI_TEST_CIRCLE_CLI` naming the directory of an installed `circle`, they
also run an estimate, a submission and a history lookup through that real CLI
against a fake of Circle's API, and a run Circle refuses before any approval,
which sent nothing only on a qualified build (`npm run test:circle --workspace
@daski/pay`). Live execution and finality remain separately qualified as
described in [conformance](conformance.md).
