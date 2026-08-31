/**
 * `daski wallet` — create, address, balance.
 *
 * Creating a key is the one action here that cannot be undone by re-running a
 * command, so it is gated on a human: an interactive terminal and a typed
 * confirmation phrase. `--yes-human-approved` exists for provisioning
 * scripts, and its name is the documentation: whoever passes it is asserting a
 * human approved this.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import { CliError } from "../cli/errors.js";
import { confirmPhrase, isInteractive } from "../cli/prompt.js";
import { loadConfig } from "../config.js";
import { readBalances } from "../gateway/balance.js";
import { hasKey, locateKey, storeKey } from "../store/keystore.js";
import { createSigner } from "../signers/index.js";

export interface WalletOptions {
  profile?: string | undefined;
  yesHumanApproved?: boolean;
  signerOverride?: string | undefined;
  cdpAccount?: string | undefined;
}

const CREATE_PHRASE = "create a new key";

export async function createWallet(options: WalletOptions): Promise<Record<string, unknown>> {
  const loaded = loadConfig(options.profile);
  const profileName = loaded.profileName;

  if (await hasKey(profileName)) {
    throw new CliError({
      code: "DASKI_KEY_ALREADY_EXISTS",
      message: `A signing key already exists for the "${profileName}" profile.`,
      remediation:
        `Use it with \`daski wallet address --profile ${profileName}\`. This CLI ` +
        "has no rotate or overwrite command: replacing a key is a deliberate " +
        "manual act, so an accidental re-run can never strand funds.",
    });
  }

  if (!options.yesHumanApproved) {
    if (!isInteractive()) {
      throw new CliError({
        code: "DASKI_KEY_CREATION_NEEDS_HUMAN",
        message:
          "Creating a signing key requires a human, and this session has no terminal.",
        remediation:
          "Run it from an interactive terminal, or — if a human has approved " +
          `this — re-run with --yes-human-approved.`,
      });
    }
    const approved = await confirmPhrase(
      `This creates a new signing key for the "${profileName}" profile ` +
      `(${loaded.profile.network}).\n` +
      "The key is stored on this machine and never sent to the gateway.\n" +
      "There is no recovery command: if you lose it, funds held by it are gone.",
      CREATE_PHRASE,
    );
    if (!approved) {
      throw new CliError({
        code: "DASKI_KEY_CREATION_DECLINED",
        message: "Key creation was not confirmed.",
        remediation: `Re-run and type "${CREATE_PHRASE}" to confirm.`,
        exitCode: 2,
      });
    }
  }

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const location = await storeKey(profileName, privateKey);

  // The address is public; the key is not, and does not appear here or anywhere.
  return {
    created: true,
    profile: profileName,
    address: account.address,
    network: loaded.profile.network,
    storedIn: location.description,
    keyMaterial: "never printed, never logged, never sent to the gateway",
  };
}

export async function walletAddress(options: WalletOptions): Promise<Record<string, unknown>> {
  const loaded = loadConfig(options.profile);
  const signer = await createSigner({
    kind: (options.signerOverride as never) ?? loaded.profile.signer,
    profile: loaded.profileName,
    cdpAccount: options.cdpAccount,
  });
  const location = await locateKey(loaded.profileName);
  return {
    profile: loaded.profileName,
    network: loaded.profile.network,
    address: await signer.getAddress(),
    signer: signer.describe().provider,
    keySource: location?.source ?? "unknown",
  };
}

export async function walletBalance(options: WalletOptions): Promise<Record<string, unknown>> {
  const loaded = loadConfig(options.profile);
  const signer = await createSigner({
    kind: (options.signerOverride as never) ?? loaded.profile.signer,
    profile: loaded.profileName,
    cdpAccount: options.cdpAccount,
  });
  const address = getAddress(await signer.getAddress());
  const balances = await readBalances({
    rpcUrl: loaded.profile.rpcUrl,
    address,
    usdcAddress: loaded.profile.usdcAddress,
  });
  return {
    profile: loaded.profileName,
    network: loaded.profile.network,
    address,
    ...balances,
  };
}
