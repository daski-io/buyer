/**
 * Signer selection.
 *
 * Three adapters behind one interface: `local` (a viem account from the key
 * store, verified by the conformance suite), and `cdp` and `circle`
 * (candidates pending conformance). Whatever the backend, the request it
 * signs has already been through the §4 validator, and `daski doctor` puts
 * every adapter through the same self-test before calling it usable.
 */
import type { SignerAdapter } from "@daski/x402-scheme";
import { CliError } from "../cli/errors.js";
import type { SignerKind } from "../config.js";
import { createCdpSigner } from "./cdp.js";
import { createCircleSigner } from "./circle.js";
import { createLocalSigner } from "./local.js";

export interface SignerSelection {
  kind: SignerKind;
  profile: string;
  cdpAccount?: string | undefined;
  circleWallet?: string | undefined;
}

export async function createSigner(selection: SignerSelection): Promise<SignerAdapter> {
  switch (selection.kind) {
    case "local":
      return createLocalSigner(selection.profile);
    case "cdp":
      return createCdpSigner({ account: selection.cdpAccount });
    case "circle":
      return createCircleSigner({ wallet: selection.circleWallet });
    default:
      throw new CliError({
        code: "DASKI_SIGNER_UNKNOWN",
        message: `Unknown signer "${String(selection.kind)}".`,
        remediation: "Set profiles.<name>.signer to one of: local, cdp, circle.",
      });
  }
}

export { createCdpSigner, createCircleSigner, createLocalSigner };
