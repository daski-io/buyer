/**
 * The local viem-account signer: the one adapter implemented in full.
 *
 * The key is held in this closure and never leaves it. `describe()` reports
 * where it came from so `doctor` can flag the developer environment variable.
 *
 * Before the key is loaded, the paid-use gate runs: a Linux host whose
 * profile key was left in the kernel session keyring by an earlier release
 * has no durable key, and that key is never used (`DASKI_KEY_NOT_DURABLE`).
 * Hosted signers hold no local key and are not subject to this gate.
 */
import { privateKeyToAccount } from "viem/accounts";
import { type Address, type Hex } from "viem";
import type { SignerAdapter, SignerDescription, TypedDataRequest } from "@daski/x402-scheme";
import {
  detectLegacyKeyringEntry, keyBackendFor, keyNotDurable, type HostEnvironment,
} from "../host.js";
import { loadKey, locateKey, type KeyStoreSelection } from "../store/keystore.js";

/** The store a profile's local key uses on this host. */
export function localKeyStore(host: HostEnvironment): KeyStoreSelection {
  return { host, backend: keyBackendFor(host, "local") };
}

export async function createLocalSigner(profile: string, host: HostEnvironment): Promise<SignerAdapter> {
  const store = localKeyStore(host);
  const location = await locateKey(profile, store);
  if (!location && detectLegacyKeyringEntry(host, profile)) throw keyNotDurable(profile);
  const account = privateKeyToAccount(await loadKey(profile, store));
  const description: SignerDescription = {
    provider: location?.source === "environment" ? "local (env)" : "local",
    accountType: "eoa",
    conformance: "verified",
  };
  return {
    getAddress: async (): Promise<Address> => account.address,
    signTypedData: (payload: TypedDataRequest): Promise<Hex> =>
      account.signTypedData(payload as never),
    describe: () => description,
  };
}
