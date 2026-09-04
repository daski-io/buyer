/**
 * The per-invocation context every command shares: profile, signer, gateway,
 * catalog, and the assembled PolicyConfig.
 *
 * The PolicyConfig is built here and nowhere else, so there is exactly one
 * place where caps, pins and the session ledger are wired together — and one
 * place to audit that none of them came from a challenge.
 */
import type { PolicyConfig, SignerAdapter } from "@daski/x402-scheme";
import { getAddress, type Address } from "viem";
import { applyCapOverrides, loadConfig, type LoadedConfig, type ProfileConfig } from "./config.js";
import { Catalog } from "./gateway/catalog.js";
import { GatewayClient, type GatewayCallLog } from "./gateway/client.js";
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
}

export interface CommandContext {
  loaded: LoadedConfig;
  profileName: string;
  profile: ProfileConfig;
  client: GatewayClient;
  catalog: Catalog;
  signer: SignerAdapter;
  payerAddress: Address;
  policy: PolicyConfig;
  close(): Promise<void>;
}

export async function createContext(options: ContextOptions): Promise<CommandContext> {
  const loaded = loadConfig(options.profile);
  const profile = applyCapOverrides(loaded.profile, {
    maxPerOrderUsdc: options.maxPerOrderUsdc,
    sessionCapUsdc: options.sessionCapUsdc,
  });
  const client = new GatewayClient({
    gatewayUrl: profile.gatewayUrl,
    ...(options.onCall ? { onCall: options.onCall } : {}),
  });
  const catalog = new Catalog(client);
  const signer = await createSigner({
    kind: (options.signerOverride as ProfileConfig["signer"] | undefined) ?? profile.signer,
    profile: loaded.profileName,
    cdpAccount: options.cdpAccount,
    circleWallet: options.circleWallet,
  });
  const payerAddress = getAddress(await signer.getAddress());

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
    client,
    catalog,
    signer,
    payerAddress,
    policy,
    close: () => client.close(),
  };
}
