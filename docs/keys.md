# Key storage

The gateway never sees your key. Nothing in this codebase sends key material
anywhere, and every printed value passes through a redaction guard on the way
out — keys are never supposed to reach output, but "supposed to" is not a
guarantee, and a leaked key is unrecoverable.

## Where keys live

1. **OS keychain** (default) — Windows Credential Manager, macOS Keychain, or
   libsecret, via [`@napi-rs/keyring`](https://www.npmjs.com/package/@napi-rs/keyring).
   Chosen over `keytar`, which is archived and needs a `node-gyp` postinstall;
   `@napi-rs/keyring` ships prebuilt binaries as optional dependencies and runs
   no install scripts.
2. **Encrypted file** — `~/.daski/keystore.json`, scrypt (N=2^17, r=8, p=1) +
   AES-256-GCM, passphrase prompted without echo. Used automatically when no
   keychain is available (headless Linux without libsecret, for example).
3. **`DASKI_PAYER_PRIVATE_KEY`** — developer/sandbox only.

Entries are namespaced per profile, so a sandbox key and a mainnet key never
share a slot.

## The environment variable

`DASKI_PAYER_PRIVATE_KEY` works, and `daski doctor` flags it as a warning
every time. The key sits in the process environment, where child processes and
most crash reporters can read it. It is refused outright on any non-sandbox
profile.

Move it into the keychain when you are done experimenting:

```bash
unset DASKI_PAYER_PRIVATE_KEY && daski wallet create --profile sandbox
```

## Creating a key

`daski wallet create` generates a local EOA **only after a human confirms**:
an interactive terminal, and the phrase `create a new key` typed in full. In a
non-TTY session it refuses unless `--yes-human-approved` is passed, whose name
is its documentation — whoever passes it is asserting that a human approved
this.

Only the address is printed. The key is never written to stdout, logs, or
error messages.

## What this CLI deliberately does not do

No `wallet fund` or faucet integration. No sweep, recovery, or rotation
commands. No overwrite of an existing key.

Replacing a key is a deliberate manual act, so an accidental re-run can never
strand funds. If you lose a keystore passphrase, the key cannot be recovered
from the file — that is what encryption means.
