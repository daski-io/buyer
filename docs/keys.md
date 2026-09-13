# Key storage

The gateway never sees your key. Nothing in this codebase sends key material
anywhere, and every printed value passes through a redaction guard on the way
out — keys are never supposed to reach output, but "supposed to" is not a
guarantee, and a leaked key is unrecoverable.

The CLI also never sends a transaction. A local key signs typed data only:
purchase authorizations, order-action authorizations, and sponsored delivery
confirmations that Daski's relayer submits. A contract wallet submits its own
delivery confirmations through the wallet's tool; the CLI validates and
prints the call and sends nothing. See [signers](./signers.md).

## Where keys live

A local key is written only to a store whose persistence is known by
construction. The store is the **key backend**, selected with
`DASKI_KEY_BACKEND`:

| Backend | Where | Durability | Platforms |
|---|---|---|---|
| `keychain` | Windows Credential Manager or macOS Keychain, via [`@napi-rs/keyring`](https://www.npmjs.com/package/@napi-rs/keyring) | `persistent` | macOS, Windows |
| `file` | `<state directory>/keystore.json`, scrypt (N=2^17, r=8, p=1) + AES-256-GCM, passphrase-protected | `encrypted-file` | all |
| `circle-agent`, `cdp` | the hosted wallet; no local key | `none` | all |
| `none` | no local key store at all | `none` | all |

When `DASKI_KEY_BACKEND` is unset, a `local` signer uses the keychain on
macOS and Windows and the encrypted file on Linux; a hosted signer names its
own backend. `DASKI_PAYER_PRIVATE_KEY` (durability `environment`) is the
developer/sandbox escape hatch below.

Entries are namespaced per profile, so a sandbox key and a mainnet key never
share a slot.

### Linux

On Linux the CLI **never loads `@napi-rs/keyring`**. Without a Secret
Service the wrapper silently fell back to the kernel session keyring, and a
key stored there was lost with the login session. Backend `keychain` is
refused on Linux with `DASKI_KEYCHAIN_UNSUPPORTED_ON_LINUX`; use the
encrypted file.

`daski doctor` also looks for a key an earlier release left in the session
keyring (`keyring:payer:<profile>@io.daski.pay` in `/proc/keys`). This is a
detector only: the entry is never read. When it is found and no durable key
exists for the profile, doctor reports key durability `session-memory` and
blocks with `DASKI_KEY_NOT_DURABLE`; `buy` and `sign-payment` refuse with the
same code. There is no override and no migration command: create a new
wallet with the file backend (sandbox funds only exist before mainnet). The
session entry disappears when the login session ends.

### The encrypted file

A missing `keystore.json` is an empty store. A file that exists but cannot
be read, parsed, or trusted — permission denied, malformed JSON, an
unexpected shape, an entry with out-of-range KDF parameters — is
`DASKI_KEYSTORE_UNREADABLE`, and the CLI refuses to create or use a key
until it is repaired; it is never treated as empty.

Every update holds an exclusive lock file (`keystore.json.lock`) in the
state directory, writes a temporary file beside the target with owner-only
mode, flushes it, atomically renames it over the target, flushes the
directory, then reads the file back and decrypts the new entry to the
expected address before reporting success (`DASKI_KEYSTORE_READBACK_MISMATCH`
otherwise). Two creations for the same profile serialize to one key.

`daski doctor` warns (`DASKI_KEYSTORE_NOT_PRIVATE`) when `keystore.json` is
readable or writable by other users. The entries are encrypted, so this is a
posture warning rather than a refusal: `chmod 600` the file.

### The passphrase

The file store's passphrase comes from a terminal, or from the file named by
`DASKI_KEYSTORE_PASSPHRASE_FILE`: a regular file with owner-only permissions
(`chmod 600`) containing only the passphrase. It is never taken from a flag,
so it never reaches a process list or a shell history. With neither a
terminal nor the file, `wallet create` refuses
(`DASKI_PASSPHRASE_REQUIRES_TTY`).

## The environment variable

`DASKI_PAYER_PRIVATE_KEY` works, and `daski doctor` flags it as a warning
every time. The key sits in the process environment, where child processes and
most crash reporters can read it. It is refused outright on any non-sandbox
profile.

Move it into a durable store when you are done experimenting:

```bash
unset DASKI_PAYER_PRIVATE_KEY && daski wallet create --profile sandbox
```

## Creating a key

`daski wallet create` generates a local EOA **only after a human confirms**:
an interactive terminal, and the phrase `create a new key` typed in full. In a
non-TTY session it refuses unless `--yes-human-approved` is passed, whose name
is its documentation — whoever passes it is asserting that a human approved
this.

Before that, every fact must line up:

| Fact | Source | Refusal |
|---|---|---|
| signer kind is `local` | profile `signer` or `--signer` | `DASKI_WALLET_CREATE_LOCAL_ONLY` — hosted wallets are created with the vendor's tool |
| host class is not `ephemeral` | `DASKI_HOST_CLASS` | `DASKI_LOCAL_KEY_REFUSED_ON_HOST` — an agent-managed, shared, or resettable host uses the Circle agent wallet |
| key backend holds a local key | `DASKI_KEY_BACKEND` | `DASKI_LOCAL_KEY_REFUSED_ON_HOST` for `circle-agent`, `cdp`, `none` |
| backend is supported here | platform | `DASKI_KEYCHAIN_UNSUPPORTED_ON_LINUX` |
| no key exists yet | the store | `DASKI_KEY_ALREADY_EXISTS` |

Only the address is printed. The key is never written to stdout, logs, or
error messages.

Doctor reports each of these facts separately: `host.hostClass`,
`host.keyBackend`, `host.keyDurability` (`persistent`, `encrypted-file`,
`session-memory`, `environment`, or `none`), and under `signer` the kind,
account type, how the self-test verified, deployment, and conformance.

## What this CLI deliberately does not do

No `wallet fund` or faucet integration. No sweep, recovery, rotation, or
migration commands. No key export. No overwrite of an existing key. No
transaction of any kind.

Replacing a key is a deliberate manual act, so an accidental re-run can never
strand funds. If you lose a keystore passphrase, the key cannot be recovered
from the file — that is what encryption means.
