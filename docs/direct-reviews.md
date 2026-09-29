# Direct Circle delivery reviews

A direct review is prepare-only by default. Choose the review, inspect its
validated call and callHash, then use:

~~~bash
daski order confirm <handle> --estimate --json
daski order confirm <handle> --submit --approve-call <callHash> --json
daski order confirm <handle> --resume --json
~~~

The same actions apply to a prepared revocation. Estimation sends no
transaction. Submission requires the exact saved callHash, a deployed Circle
agent wallet matching the payer, fresh chain validation, and the gateway's
separate circleExecute qualification. An explicitly authorized Base Sepolia\nconformance run can use --qualify-circle-execution with\nDASKI_CONFORMANCE_SPEND_OK=1 to generate the initial evidence; this candidate\nlane never bypasses mainnet qualification. A signing or estimation conformance
result does not enable execution.

The adapter verifies the installed @circle-fin/cli package identity and exact
dist/index.js SHA-256 for version 1.0.0 or 1.1.4. Unknown or changed entrypoints
are refused. It starts a dedicated Node child without a shell, preload hooks,
proxy overrides or Daski environment secrets. It never edits the installed CLI.
The child corrects only the approved EAS attest/revoke tuple at the official
Circle agent endpoint. All destination, wallet, chain, ABI parameters, zero
value and idempotency fields must match; the re-encoded calldata must be exact.
The child permits only the resulting challenge's approval. Transfer, deploy,
cancel, accelerate, arbitrary requests and cross-environment requests fail.

This child runs within Circle's credential boundary: the pinned CLI can read
its existing userToken, encryptionKey, encryptedUserSecret and storageKey.
Daski creates no additional credential store and never logs vendor output or
errors. The installed vendor dependencies remain part of the existing vendor
trust boundary; entrypoint integrity is not a claim that the whole local host
or every transitive dependency is attested.

Before the first execution call, Daski atomically records a stable idempotency
key, package version, exact call binding and submissionStarted. A timeout or
unreadable result keeps that record. Resume performs only vendor reads and
chain checks; it never calls wallet execute, cancel or accelerate.

Vendor discovery requires a matching transaction ID or idempotency key and
exact calldata, wallet, chain and destination. Missing payload/key lookup or
more than one candidate is unresolved, never proof that nothing happened.
Transaction IDs can retain multiple replacement hashes. A final EAS event and
attestation binding are necessary to close the journal; an ERC-4337 outer
success or vendor COMPLETE status alone is insufficient. A started vendor
operation cannot be abandoned locally. Retain it and reconcile rather than
creating a second execution.

Offline tests cover transport scope, tuple shape, preserved auth headers,
journal crash windows, hash lineage, and read-only resume. Live execution and
finality remain separately qualified as described in [conformance](conformance.md).
