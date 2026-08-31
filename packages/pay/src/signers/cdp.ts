/**
 * CDP Server Wallets v2 — scaffolded behind the signer interface, wired into
 * the conformance suite, and marked **candidate pending conformance**.
 *
 * The adapter is deliberately thin: `@coinbase/cdp-sdk` exposes a
 * viem-compatible account, so the whole integration is "resolve an account,
 * forward typed-data signing". What is *not* yet established is whether that
 * account's signatures satisfy the gateway's plain low-s ECDSA recovery on
 * every account type CDP can mint — which is what `npm run conformance --
 * --signer cdp` exists to answer.
 *
 * Until that run passes, `describe()` reports the candidate status so `doctor`
 * can say so out loud rather than implying a guarantee nobody has checked.
 */
import type { Address, Hex } from "viem";
import type { SignerAdapter, TypedDataRequest } from "@daski/x402-scheme";
import { CliError } from "../cli/errors.js";

const DOC = "https://github.com/daski-io/buyer/blob/main/docs/signers.md#cdp";

interface CdpViemAccount {
  address: Address;
  signTypedData(payload: unknown): Promise<Hex>;
}

export interface CdpSignerOptions {
  /** CDP account name or address; defaults to `$DASKI_CDP_ACCOUNT`. */
  account?: string | undefined;
}

export async function createCdpSigner(options: CdpSignerOptions = {}): Promise<SignerAdapter> {
  const accountName = options.account ?? process.env.DASKI_CDP_ACCOUNT;
  if (!accountName) {
    throw new CliError({
      code: "DASKI_CDP_ACCOUNT_UNSET",
      message: "The CDP signer needs an account name or address.",
      remediation: `Set DASKI_CDP_ACCOUNT, or pass --cdp-account. See ${DOC}`,
    });
  }
  const sdk = await importCdp();
  const client = new sdk.CdpClient();
  const account = await client.evm.getOrCreateAccount({ name: accountName }) as CdpViemAccount;
  return {
    getAddress: async () => account.address,
    signTypedData: (payload: TypedDataRequest) => account.signTypedData(payload),
    describe: () => ({
      provider: "cdp",
      // CDP can mint both; the conformance run is what pins this down per account.
      accountType: "unknown",
      conformance: "candidate-pending-conformance",
    }),
  };
}

interface CdpModule {
  CdpClient: new () => {
    evm: { getOrCreateAccount(args: { name: string }): Promise<unknown> };
  };
}

/**
 * `@coinbase/cdp-sdk` is not a dependency of this package: installing it is
 * the operator's choice, and the local signer must not carry its weight.
 */
async function importCdp(): Promise<CdpModule> {
  try {
    return (await import("@coinbase/cdp-sdk" as string)) as CdpModule;
  } catch {
    throw new CliError({
      code: "DASKI_CDP_SDK_MISSING",
      message: "The CDP signer requires @coinbase/cdp-sdk, which is not installed.",
      remediation: `Run: npm install @coinbase/cdp-sdk — then see ${DOC}`,
    });
  }
}
