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

The adapter verifies the installed @circle-fin/cli package identity and exact
dist/index.js SHA-256 for version 1.1.4 or 1.2.0, whose review requests are
identical. Circle's own version policy refuses every command below 1.1.4, so
1.0.0 is not run. Unknown or changed entrypoints are refused before anything is
sent. It starts a dedicated Node child without a shell, preload hooks, proxy
overrides or Daski environment secrets. It never edits the installed CLI. The
child permits, at the official Circle agent endpoint of the profile's
environment, only the requests those CLIs send for one `wallet execute`: the
wallet listing, the contract execution request, Circle's configuration and the
bound challenge, that challenge's approval, and reads of the one transaction
the completed challenge names. Both the estimate and the execution carry the
approved EAS attest/revoke call's exact calldata in place of the signature and
parameters the CLI builds: Circle cannot execute the review's tuple argument
from parameters (observed live on Base Sepolia). All destination, wallet,
chain, ABI parameters, zero value and idempotency fields must match; the
re-encoded calldata must be exact. Transfer, deploy, cancel, accelerate,
arbitrary requests and cross-environment requests fail.

This child runs within Circle's credential boundary: the pinned CLI can read
its existing userToken, encryptionKey, encryptedUserSecret and storageKey.
Daski creates no additional credential store and never logs vendor output or
errors. The installed vendor dependencies remain part of the existing vendor
trust boundary; entrypoint integrity is not a claim that the whole local host
or every transitive dependency is attested.

## What is recorded

Before the first execution call, Daski atomically records a stable
idempotency key, package version, exact call binding, the profile chain's
final height and submissionStarted. While the vendor runs, the child appends
each step that decides what Circle can do to a private progress file before
forwarding it: the execution request, the challenge Circle issued, that
challenge's approval, and the transaction and state the challenge names. A
step that cannot be recorded is not forwarded. Circle executes only an
approved challenge, so a run that recorded no approval (an expired session, a
refused request, or a run that could not create its progress file and so never
started) restores the prepared review and answers
`DASKI_CIRCLE_REVIEW_NOT_STARTED`: nothing was sent, and the same approved
call can be submitted again. Any other failure, a timeout or an unreadable
result keeps the record with every identity Circle gave and answers
`DASKI_CIRCLE_REVIEW_UNKNOWN`. A started vendor operation is never executed
again: `--submit` is refused while its record is open.

## Recovery

Resume performs only vendor reads and chain checks; it never calls wallet
execute, cancel or accelerate. It asks Circle's history for the transaction by
the challenge's transaction ID, otherwise by the exact call created after the
submission started: the pinned CLIs print neither the idempotency key nor the
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
reconcile rather than creating a second execution.

## Reviews prepared before 0.5.0

Earlier buyers saved a prepared direct review's hash and binding but not the
call, so `--estimate` and `--submit` refuse it with
`DASKI_CONFIRMATION_NOT_PREPARED`. Prepare the same choice again: when the new
call has the saved callHash, the record is restored with its call
(`restored: true`) and keeps its original preparation time. A different choice
is refused; if the earlier call was never sent, `--abandon` clears it first.

Offline tests cover transport scope, the pinned CLIs' request sequence and
printed history, tuple shape, preserved auth headers, journal crash windows,
progress recording, hash lineage, chain discovery and read-only resume. Live
execution and finality remain separately qualified as described in
[conformance](conformance.md).
