/**
 * `daski wallet` — create a local key, or read the active payer.
 *
 * Creation is refused unless every fact lines up: the signer kind is `local`
 * (hosted wallets are created with the vendor's tool), the host is not
 * declared ephemeral, the key backend is one that holds a local key, the
 * platform supports that backend, no key exists yet, and a human approved
 * the step. Existing profile keys are never overwritten.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import { CliError } from "../cli/errors.js";
import { confirmPhrase, isInteractive } from "../cli/prompt.js";
import { loadConfig, SIGNER_KINDS, type SignerKind } from "../config.js";
import { readBalances } from "../gateway/balance.js";
import {
  HOSTED_BACKENDS, keyBackendFor, resolveHost, type HostEnvironment,
} from "../host.js";
import { createSigner } from "../signers/index.js";
import { localKeyStore } from "../signers/local.js";
import {
  hasKey, keychainUnsupportedOnLinux, localKeyRefusedOnHost, locateKey, storeKey,
} from "../store/keystore.js";

const DOC = "https://github.com/daski-io/buyer/blob/main/docs/keys.md";

export interface WalletOptions {
  profile?: string | undefined;
  yesHumanApproved?: boolean;
  signerOverride?: string | undefined;
  cdpAccount?: string | undefined;
  circleWallet?: string | undefined;
  /** The resolved host; defaults to this process's environment and platform. */
  host?: HostEnvironment | undefined;
}

const CREATE_PHRASE = "create a new key";

function signerKindOf(options: WalletOptions, configured: SignerKind): SignerKind {
  const kind = (options.signerOverride ?? configured) as SignerKind;
  if (!SIGNER_KINDS.includes(kind)) {
    throw new CliError({
      code: "DASKI_SIGNER_UNKNOWN",
      message: `Unknown signer "${kind}".`,
      remediation: `Use one of: ${SIGNER_KINDS.join(", ")}.`,
    });
  }
  return kind;
}

export async function createWallet(options: WalletOptions): Promise<Record<string, unknown>> {
  const loaded = loadConfig(options.profile);
  const profileName = loaded.profileName;
  const host = options.host ?? resolveHost();
  const signerKind = signerKindOf(options, loaded.profile.signer);

  if (signerKind !== "local") {
    throw new CliError({
      code: "DASKI_WALLET_CREATE_LOCAL_ONLY",
      message:
        `daski wallet create generates local keys only; the "${signerKind}" signer holds its ` +
        "wallet with the vendor.",
      remediation:
        `Set up the hosted wallet with the vendor's tool, then run daski doctor --json --signer ` +
        `${signerKind}. To keep a local key instead, pass --signer local. See ${DOC}`,
    });
  }
  if (host.hostClass === "ephemeral") {
    throw new CliError({
      code: "DASKI_LOCAL_KEY_REFUSED_ON_HOST",
      message:
        "This host is declared ephemeral (DASKI_HOST_CLASS=ephemeral); a local key created here " +
        "would be lost with the host.",
      remediation:
        "Use the Circle agent wallet: set DASKI_KEY_BACKEND=circle-agent, set the profile signer " +
        "to circle-agent, and follow the gateway's setup skill. Only a durable machine " +
        `(DASKI_HOST_CLASS=durable) may hold a local key. See ${DOC}`,
    });
  }
  const backend = keyBackendFor(host, "local");
  if (HOSTED_BACKENDS.has(backend)) throw localKeyRefusedOnHost(profileName, backend);
  if (backend === "keychain" && host.platform === "linux") throw keychainUnsupportedOnLinux(profileName);
  const store = localKeyStore(host);

  if (await hasKey(profileName, store)) {
    throw new CliError({
      code: "DASKI_KEY_ALREADY_EXISTS",
      message: `A signing key already exists for the "${profileName}" profile.`,
      remediation:
        `Use the existing signer with daski wallet address --profile ${profileName}.`,
    });
  }

  if (!options.yesHumanApproved) {
    if (!isInteractive()) {
      throw new CliError({
        code: "DASKI_KEY_CREATION_NEEDS_HUMAN",
        message:
          "Wallet setup needs authorization; this session has no interactive terminal.",
        remediation:
          "Ask the user to create the wallet interactively, or use " +
          "`daski wallet create --yes-human-approved` after they authorize wallet setup.",
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
  const location = await storeKey(profileName, privateKey, store);

  // The address is public; the key is not, and does not appear here or anywhere.
  return {
    created: true,
    profile: profileName,
    address: account.address,
    network: loaded.profile.network,
    storedIn: location.description,
    keyBackend: backend,
    keyDurability: location.durability,
    hostClass: host.hostClass,
    keyMaterial: "never printed, never logged, never sent to the gateway",
  };
}

async function activeSigner(options: WalletOptions) {
  const loaded = loadConfig(options.profile);
  const host = options.host ?? resolveHost();
  const kind = signerKindOf(options, loaded.profile.signer);
  const signer = await createSigner({
    kind,
    profile: loaded.profileName,
    host,
    chainId: loaded.profile.chainId,
    cdpAccount: options.cdpAccount,
    circleWallet: options.circleWallet,
  });
  const location = kind === "local" ? await locateKey(loaded.profileName, localKeyStore(host)) : undefined;
  return { loaded, signer, location };
}

export async function walletAddress(options: WalletOptions): Promise<Record<string, unknown>> {
  const { loaded, signer, location } = await activeSigner(options);
  return {
    profile: loaded.profileName,
    network: loaded.profile.network,
    address: await signer.getAddress(),
    signer: signer.describe().provider,
    accountType: signer.describe().accountType,
    keySource: location?.source ?? "none",
    keyDurability: location?.durability ?? "none",
  };
}

export async function walletBalance(options: WalletOptions): Promise<Record<string, unknown>> {
  const { loaded, signer } = await activeSigner(options);
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
