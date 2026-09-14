/**
 * What a contract-account signer must satisfy before it may buy.
 *
 * Two facts, both read rather than trusted: the gateway must verify contract
 * accounts at all (`payerAccounts.types` in its well-known document), and the
 * wallet must be deployed (`getCode` non-empty), because a counterfactual
 * signature is refused at the gateway and the facilitator alike and a refusal
 * there must never be the first signal. An EOA signer passes through here
 * without a single RPC call (T7).
 */
import type { Address } from "viem";
import type { SignerAdapter } from "@daski/x402-scheme";
import { isDeployedCode, type ChainReader } from "../chain/reader.js";
import { CliError } from "../cli/errors.js";
import type { GatewayMetadata } from "../gateway/metadata.js";

export type Deployment = "deployed" | "not-deployed" | "not-applicable";

export const NOT_DEPLOYED_REMEDIATION =
  "Send a zero-value transfer from the wallet to itself with the circle CLI, then run doctor again.";

export function isContractSigner(signer: SignerAdapter): boolean {
  return signer.describe().accountType === "contract";
}

export function signerNotDeployed(address: Address): CliError {
  return new CliError({
    code: "DASKI_SIGNER_NOT_DEPLOYED",
    message:
      `The contract wallet ${address} has no code on this chain, so its signatures cannot be ` +
      "verified and its purchases would be refused as counterfactual.",
    remediation: NOT_DEPLOYED_REMEDIATION,
  });
}

export function gatewayEoaOnly(gatewayUrl: string): CliError {
  return new CliError({
    code: "DASKI_GATEWAY_EOA_ONLY",
    message:
      `The gateway at ${gatewayUrl} verifies plain wallets (EOA) only; it does not list ` +
      "contract accounts under payerAccounts.types, so a contract wallet cannot buy there yet.",
    remediation:
      "On a durable machine use a local key (daski wallet create). On an ephemeral host, stop " +
      "and tell the user that purchasing from this host is not available until the gateway " +
      "enables contract wallets.",
  });
}

/** Whether a signer's wallet is deployed. EOA signers are not applicable and cost no RPC. */
export async function checkDeployment(signer: SignerAdapter, chain: ChainReader): Promise<Deployment> {
  if (!isContractSigner(signer)) return "not-applicable";
  const code = await chain.getCode(await signer.getAddress());
  return isDeployedCode(code) ? "deployed" : "not-deployed";
}

/**
 * Refuses a contract signer the gateway cannot verify or the chain has not
 * seen deployed. Called before a purchase asks for a challenge, so nothing is
 * signed for a wallet that cannot pay.
 */
export async function assertContractSignerUsable(args: {
  signer: SignerAdapter;
  chain: ChainReader;
  metadata: () => Promise<GatewayMetadata>;
  gatewayUrl: string;
}): Promise<void> {
  if (!isContractSigner(args.signer)) return;
  const metadata = await args.metadata();
  if (!metadata.payerAccounts?.types.includes("contract")) throw gatewayEoaOnly(args.gatewayUrl);
  const address = await args.signer.getAddress();
  if (!isDeployedCode(await args.chain.getCode(address))) throw signerNotDeployed(address);
}
