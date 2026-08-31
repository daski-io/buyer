/**
 * The local viem-account signer: the one adapter implemented in full.
 *
 * The key is held in this closure and never leaves it. `describe()` reports
 * where it came from so `doctor` can flag the developer environment variable.
 */
import { privateKeyToAccount } from "viem/accounts";
import { type Address, type Hex } from "viem";
import type { SignerAdapter, SignerDescription, TypedDataRequest } from "@daski/x402-scheme";
import { loadKey, locateKey } from "../store/keystore.js";

export async function createLocalSigner(profile: string): Promise<SignerAdapter> {
  const location = await locateKey(profile);
  const account = privateKeyToAccount(await loadKey(profile));
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
