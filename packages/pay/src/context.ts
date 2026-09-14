/**
 * The per-invocation context every command shares: profile, host, signer,
 * gateway, catalog, chain reader, and the assembled PolicyConfig.
 *
 * The PolicyConfig is built here and nowhere else, so there is exactly one
 * place where caps, pins and the session ledger are wired together — and one
 * place to audit that none of them came from a challenge.
 *
 * A context bound to an order builds its signer lazily: a stored, unexpired
 * read capability serves a read without the key store being opened at all,
 * and the signer is constructed on the first signature. The order's recorded
 * payer stands in for the address until then and is checked against the
 * signer the moment it exists.
 */
import type { PolicyConfig, SignerAdapter, TypedDataRequest } from "@daski/x402-scheme";
import { getAddress, type Address, type Hex } from "viem";
import { createChainReader, finalityTagFor, type ChainReader, type FinalityTag } from "./chain/reader.js";
import { CliError } from "./cli/errors.js";
import { applyCapOverrides, loadConfig, type LoadedConfig, type ProfileConfig } from "./config.js";
import { Catalog } from "./gateway/catalog.js";
import { GatewayClient, type GatewayCallLog } from "./gateway/client.js";
import { readGatewayMetadata, type GatewayMetadata } from "./gateway/metadata.js";
import { resolveHost, type HostEnvironment } from "./host.js";
import { createSigner } from "./signers/index.js";
import { authorizedTotalAtomic, findByIntent, isUnspent } from "./store/orders.js";

export interface ContextOptions {
  profile?: string | undefined;
  /** Lowering only; see §4.2. */
  maxPerOrderUsdc?: string | undefined;
  sessionCapUsdc?: string | undefined;
  signerOverride?: string | undefined;
  cdpAccount?: string | undefined;
  circleWallet?: string | undefined;
  onCall?: ((entry: GatewayCallLog) => void) | undefined;
  /** The resolved host; defaults to this process's environment and platform. */
  host?: HostEnvironment | undefined;
  /** A chain reader factory; defaults to the profile RPC. Injectable for tests. */
  chain?: ((rpcUrl: string, finalityTag: FinalityTag) => ChainReader) | undefined;
  /** A well-known document reader; defaults to fetching it. Injectable for tests. */
  metadata?: ((gatewayUrl: string) => Promise<GatewayMetadata>) | undefined;
}

export interface CommandContext {
  loaded: LoadedConfig;
  profileName: string;
  profile: ProfileConfig;
  host: HostEnvironment;
  client: GatewayClient;
  catalog: Catalog;
  signer: SignerAdapter;
  payerAddress: Address;
  policy: PolicyConfig;
  chain: ChainReader;
  /** The gateway's well-known document, read once. */
  metadata(): Promise<GatewayMetadata>;
  /** The real adapter, building it if the context is order-bound and it has not been needed yet. */
  resolveSigner(): Promise<SignerAdapter>;
  close(): Promise<void>;
}

/** Binds a context to an order: its payer is known before any signer exists. */
export interface OrderBinding {
  expectedPayer: string;
}

export async function createContext(
  options: ContextOptions,
  binding?: OrderBinding,
): Promise<CommandContext> {
  const loaded = loadConfig(options.profile);
  const host = options.host ?? resolveHost();
  const profile = applyCapOverrides(loaded.profile, {
    maxPerOrderUsdc: options.maxPerOrderUsdc,
    sessionCapUsdc: options.sessionCapUsdc,
  });
  const client = new GatewayClient({
    gatewayUrl: profile.gatewayUrl,
    ...(options.onCall ? { onCall: options.onCall } : {}),
  });
  const catalog = new Catalog(client);
  const build = (): Promise<SignerAdapter> => createSigner({
    kind: (options.signerOverride as ProfileConfig["signer"] | undefined) ?? profile.signer,
    profile: loaded.profileName,
    host,
    chainId: profile.chainId,
    cdpAccount: options.cdpAccount,
    circleWallet: options.circleWallet,
  });

  let signer: SignerAdapter;
  let payerAddress: Address;
  let resolveSigner: () => Promise<SignerAdapter>;
  if (binding) {
    payerAddress = getAddress(binding.expectedPayer);
    const lazy = lazySigner(build, payerAddress);
    signer = lazy;
    resolveSigner = lazy.resolve;
  } else {
    const built = await build();
    payerAddress = getAddress(await built.getAddress());
    signer = built;
    resolveSigner = async () => built;
  }

  const chain = (options.chain ?? createChainReader)(profile.rpcUrl, finalityTagFor(profile.chainId));
  let metadata: Promise<GatewayMetadata> | undefined;

  const policy: PolicyConfig = {
    payerAddress,
    chainId: profile.chainId,
    canonicalToken: getAddress(profile.usdcAddress),
    maxPerOrderUsdc: profile.maxPerOrderUsdc,
    sessionCapUsdc: profile.sessionCapUsdc,
    resolveSplitter: (providerAgentId, outcomeId) =>
      catalog.splitterEvidence(providerAgentId, outcomeId),
    session: {
      // The running total is the on-disk order store, so the cap survives the
      // process that placed the earlier orders.
      spentAtomic: () => authorizedTotalAtomic(loaded.profileName),
      hasOrderFor: (identifier) => {
        const existing = findByIntent(identifier);
        return existing !== undefined && !isUnspent(existing);
      },
    },
  };

  return {
    loaded,
    profileName: loaded.profileName,
    profile,
    host,
    client,
    catalog,
    signer,
    payerAddress,
    policy,
    chain,
    metadata: () => {
      metadata ??= (options.metadata ?? readGatewayMetadata)(profile.gatewayUrl);
      return metadata;
    },
    resolveSigner,
    close: () => client.close(),
  };
}

/**
 * A signer that is built on first use and must report the payer the order
 * was placed with. Its description is available only once it exists;
 * commands that need the account type call `resolveSigner()` first.
 */
function lazySigner(
  build: () => Promise<SignerAdapter>,
  expectedPayer: Address,
): SignerAdapter & { resolve(): Promise<SignerAdapter> } {
  let pending: Promise<SignerAdapter> | undefined;
  let resolved: SignerAdapter | undefined;
  const resolve = (): Promise<SignerAdapter> => {
    pending ??= build().then(async (adapter) => {
      const actual = getAddress(await adapter.getAddress());
      if (actual !== expectedPayer) {
        throw new CliError({
          code: "DASKI_ORDER_PAYER_MISMATCH",
          message: `The active signer (${actual}) differs from this order's payer (${expectedPayer}).`,
          remediation: "Select the profile or --signer that placed this order.",
        });
      }
      resolved = adapter;
      return adapter;
    });
    return pending;
  };
  return {
    resolve,
    getAddress: async (): Promise<Address> => (await resolve()).getAddress(),
    signTypedData: async (payload: TypedDataRequest): Promise<Hex> => (await resolve()).signTypedData(payload),
    describe: () => {
      if (!resolved) {
        throw new CliError({
          code: "DASKI_SIGNER_NOT_RESOLVED",
          message: "The signer has not been built yet, so it cannot describe itself.",
          remediation: "This is a defect in the calling command: it must resolve the signer first.",
        });
      }
      return resolved.describe();
    },
  };
}
