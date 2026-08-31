/**
 * Signer selection.
 *
 * `circle` is documented, not implemented (§5): Circle's `circle wallet sign
 * typed-data` path signs from a smart-contract account, and it is an open
 * question whether those signatures satisfy the gateway's plain low-s ECDSA
 * recovery. Shipping a stub that might produce unverifiable signatures would
 * be worse than saying so — the conformance suite is what decides, and until
 * it runs, selecting `circle` fails with that explanation.
 */
import type { SignerAdapter } from "@daski/x402-scheme";
import { CliError } from "../cli/errors.js";
import type { SignerKind } from "../config.js";
import { createCdpSigner } from "./cdp.js";
import { createLocalSigner } from "./local.js";

export interface SignerSelection {
  kind: SignerKind;
  profile: string;
  cdpAccount?: string | undefined;
}

export async function createSigner(selection: SignerSelection): Promise<SignerAdapter> {
  switch (selection.kind) {
    case "local":
      return createLocalSigner(selection.profile);
    case "cdp":
      return createCdpSigner({ account: selection.cdpAccount });
    case "circle":
      throw new CliError({
        code: "DASKI_SIGNER_CIRCLE_NOT_IMPLEMENTED",
        message:
          "The Circle signer is documented but not implemented: its " +
          "smart-contract-account signatures may not satisfy the gateway's " +
          "plain low-s ECDSA recovery, and no conformance run has settled it.",
        remediation:
          "Use --signer local (or cdp) for now. See " +
          "https://github.com/daski-io/buyer/blob/main/docs/signers.md#circle",
      });
    default:
      throw new CliError({
        code: "DASKI_SIGNER_UNKNOWN",
        message: `Unknown signer "${String(selection.kind)}".`,
        remediation: "Set profiles.<name>.signer to one of: local, cdp.",
      });
  }
}

export { createCdpSigner, createLocalSigner };
