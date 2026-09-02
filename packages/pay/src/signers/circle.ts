/**
 * Circle Developer-Controlled Wallets — implemented for the EOA account type,
 * wired into the conformance suite, and marked **candidate pending conformance**.
 *
 * The adapter is thin on purpose: resolve the wallet, refuse anything that is
 * not an externally owned account, and forward typed-data signing to Circle's
 * `signTypedData`. What Circle receives is exactly the `TypedDataRequest` the
 * policy validator produced — domain, types, primaryType, message — as JSON.
 * Nothing is added and nothing is rewritten on the way out, which is what the
 * doctor self-test later checks by recovering the signer from that same data.
 *
 * Smart-contract accounts (SCA) are refused outright. They sign through
 * ERC-1271, where the contract decides what a valid signature is, and the
 * gateway verifies purchase authorizations by plain low-s ECDSA recovery of an
 * EOA. No amount of adapter code turns one into the other, so the adapter says
 * so instead of producing signatures the facilitator cannot verify.
 *
 * What is *not* yet established is that Circle's EOA signatures settle on the
 * live gateway end to end — that is what `npm run conformance -- --signer
 * circle` exists to answer, and until it passes `describe()` reports the
 * candidate status so `doctor` can say so out loud.
 *
 * Credentials come from the environment only (`CIRCLE_API_KEY`,
 * `CIRCLE_ENTITY_SECRET`): a flag would put them in the process list and the
 * shell history. Neither is ever printed, logged, or sent to the gateway.
 */
import { getAddress, isAddress, type Address, type Hex } from "viem";
import type { SignerAdapter, TypedDataRequest } from "@daski/x402-scheme";
import { CliError } from "../cli/errors.js";

const DOC = "https://github.com/daski-io/buyer/blob/main/docs/signers.md#circle";
const SDK_PACKAGE = "@circle-fin/developer-controlled-wallets";

/** The slice of a Circle wallet record the adapter reads. */
export interface CircleWallet {
  address: string;
  /** `"EOA"` or `"SCA"`. */
  accountType: string;
  blockchain?: string;
}

/** The slice of the Circle client the adapter uses. */
export interface CircleClient {
  getWallet(input: { id: string }): Promise<{ data?: { wallet: CircleWallet } | undefined }>;
  signTypedData(input: { walletId: string; data: string; memo?: string }): Promise<{
    data?: { signature: string } | undefined;
  }>;
}

/** The slice of `@circle-fin/developer-controlled-wallets` the adapter imports. */
export interface CircleModule {
  initiateDeveloperControlledWalletsClient(config: {
    apiKey: string;
    entitySecret: string;
  }): CircleClient;
}

export interface CircleSignerOptions {
  /** Circle wallet id; defaults to `$DASKI_CIRCLE_WALLET`. */
  wallet?: string | undefined;
  /**
   * The SDK module, or a loader for it. Defaults to a dynamic import of the
   * real package; injectable so unit tests can run without installing it.
   */
  sdk?: CircleModule | (() => Promise<CircleModule>) | undefined;
}

export async function createCircleSigner(options: CircleSignerOptions = {}): Promise<SignerAdapter> {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) {
    throw new CliError({
      code: "DASKI_CIRCLE_CREDENTIALS_UNSET",
      message:
        "The Circle signer needs CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET in the " +
        "environment. They are never taken from a flag.",
      remediation: `Export both from your Circle developer console, then re-run. See ${DOC}`,
    });
  }
  const walletId = options.wallet ?? process.env.DASKI_CIRCLE_WALLET;
  if (!walletId) {
    throw new CliError({
      code: "DASKI_CIRCLE_WALLET_UNSET",
      message: "The Circle signer needs a wallet id.",
      remediation: `Set DASKI_CIRCLE_WALLET, or pass --circle-wallet <id>. See ${DOC}`,
    });
  }
  const sdk = await loadSdk(options.sdk);
  const client = sdk.initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  const wallet = (await client.getWallet({ id: walletId })).data?.wallet;
  if (!wallet || typeof wallet.address !== "string") {
    throw new CliError({
      code: "DASKI_CIRCLE_WALLET_NOT_FOUND",
      message: `Circle returned no wallet for id ${walletId}.`,
      remediation: `Check the id in your Circle console, or pass another --circle-wallet <id>. See ${DOC}`,
    });
  }
  if (wallet.accountType !== "EOA") {
    throw new CliError({
      code: "DASKI_CIRCLE_SCA_UNSUPPORTED",
      message:
        `Circle wallet ${walletId} is a ${wallet.accountType} account. Smart-contract ` +
        "accounts sign through ERC-1271, where the contract decides what a valid " +
        "signature is; the gateway verifies purchase authorizations by plain low-s " +
        "ECDSA recovery of an EOA, which cannot verify them.",
      remediation:
        "Use a Circle wallet created with accountType EOA and pass its id with " +
        `--circle-wallet <id>. See ${DOC}`,
    });
  }
  if (!isAddress(wallet.address, { strict: false })) {
    throw new CliError({
      code: "DASKI_CIRCLE_WALLET_NOT_EVM",
      message:
        `Circle wallet ${walletId} is on ${wallet.blockchain ?? "an unknown blockchain"} ` +
        "and has no EVM address.",
      remediation:
        "Pass the id of an EVM wallet (for the sandbox: BASE-SEPOLIA or EVM-TESTNET). " +
        `See ${DOC}`,
    });
  }
  const address = getAddress(wallet.address);
  return {
    getAddress: async (): Promise<Address> => address,
    signTypedData: async (payload: TypedDataRequest): Promise<Hex> => {
      const response = await client.signTypedData({
        walletId,
        data: serializeTypedData(payload),
        memo: `daski: ${payload.primaryType} on eip155:${payload.domain.chainId}`,
      });
      const signature = response.data?.signature;
      if (typeof signature !== "string") {
        throw new CliError({
          code: "DASKI_CIRCLE_SIGNATURE_MISSING",
          message: "Circle answered the signing request without a signature.",
          remediation: `Check the wallet's state in your Circle console and re-run. See ${DOC}`,
        });
      }
      return signature as Hex;
    },
    describe: () => ({
      provider: "circle",
      accountType: "eoa",
      conformance: "candidate-pending-conformance",
    }),
  };
}

/**
 * Exactly the request the validator produced — domain, types, primaryType,
 * message — as the JSON string Circle's `signTypedData` takes. `uint256`
 * values arrive as bigints, which JSON cannot carry, so they go out as decimal
 * strings: the same wire form the authorization itself uses. `EIP712Domain` is
 * not added to `types`; it is derived from `domain`, as the validator does.
 */
export function serializeTypedData(payload: TypedDataRequest): string {
  const { domain, types, primaryType, message } = payload;
  return JSON.stringify(
    { domain, types, primaryType, message },
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
  );
}

/**
 * `@circle-fin/developer-controlled-wallets` is not a dependency of this
 * package: installing it is the operator's choice, and the local signer must
 * not carry its weight.
 */
async function loadSdk(
  sdk: CircleModule | (() => Promise<CircleModule>) | undefined,
): Promise<CircleModule> {
  if (sdk && typeof sdk !== "function") return sdk;
  try {
    return sdk ? await sdk() : (await import(SDK_PACKAGE as string)) as CircleModule;
  } catch {
    throw new CliError({
      code: "DASKI_CIRCLE_SDK_MISSING",
      message: `The Circle signer requires ${SDK_PACKAGE}, which is not installed.`,
      remediation: `Run: npm install ${SDK_PACKAGE} — then see ${DOC}`,
    });
  }
}
