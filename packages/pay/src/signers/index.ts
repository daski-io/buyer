/**
 * Signer selection.
 *
 * Four adapters behind one interface: `local` (a viem account from the key
 * store, verified by the conformance suite), `circle-agent` (a deployed
 * contract account operated through the pinned Circle CLI, the default for
 * agent-hosted runtimes), and `cdp` and `circle` (developer-controlled
 * candidates). Whatever the backend, the request it signs has already been
 * through the §4 validator, and `daski doctor` puts every adapter through the
 * self-test for its account type before calling it usable.
 */
import type { SignerAdapter } from "@daski/x402-scheme";
import { CliError } from "../cli/errors.js";
import { SIGNER_KINDS, type SignerKind } from "../config.js";
import type { HostEnvironment } from "../host.js";
import { createCdpSigner } from "./cdp.js";
import { createCircleSigner } from "./circle.js";
import { createCircleAgentSigner } from "./circleAgent.js";
import { createLocalSigner } from "./local.js";

export interface SignerSelection {
  kind: SignerKind;
  profile: string;
  /** Where a local key may live on this host. */
  host: HostEnvironment;
  /** The profile's chain, which the Circle agent wallet maps to a chain name. */
  chainId: number;
  cdpAccount?: string | undefined;
  /** A Circle developer-controlled wallet id, or the agent wallet address to select. */
  circleWallet?: string | undefined;
}

export async function createSigner(selection: SignerSelection): Promise<SignerAdapter> {
  switch (selection.kind) {
    case "local":
      return createLocalSigner(selection.profile, selection.host);
    case "circle-agent":
      return createCircleAgentSigner({ chainId: selection.chainId, address: selection.circleWallet });
    case "cdp":
      return createCdpSigner({ account: selection.cdpAccount });
    case "circle":
      return createCircleSigner({ wallet: selection.circleWallet });
    default:
      throw new CliError({
        code: "DASKI_SIGNER_UNKNOWN",
        message: `Unknown signer "${String(selection.kind)}".`,
        remediation: `Set profiles.<name>.signer to one of: ${SIGNER_KINDS.join(", ")}.`,
      });
  }
}

export { createCdpSigner, createCircleAgentSigner, createCircleSigner, createLocalSigner };
