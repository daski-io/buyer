/**
 * Native EAS review profiles: the signing formats this buyer can build and check.
 * A profile is qualified by what a payer signs (the EIP-712 domain version and the
 * Attest and Revoke type hashes), read independently from the chain, not by the
 * deployed bytecode. Base upgrades its EAS predeploy in place; an upgrade that
 * keeps a known signing format keeps working, and one that changes it fails
 * before a payer signs anything.
 */
import { hashDomain, parseAbi, type Address, type Hex } from "viem";
import { readContracts, type ChainReader } from "./reader.js";
import { CliError } from "../cli/errors.js";

export type EasReviewProfileId = "eas-native-1.0.1" | "eas-native-1.2.0" | "eas-native-1.4.1-beta.3";
export interface EasReviewProfile {
  /** Named after the EAS release that introduced this signing format. */
  id: EasReviewProfileId;
  domainVersion: string;
  signedDeadline: boolean;
  /** The signed Attest or Revoke struct starts with the signer, as `attester` or `revoker`. */
  signedSigner: boolean;
  attestTypeHash: Hex;
  revokeTypeHash: Hex;
}
/** Each format's domain version and type hashes are distinct, so at most one matches a deployment. */
export const EAS_REVIEW_PROFILES: Readonly<Record<EasReviewProfileId, EasReviewProfile>> = {
  // First qualified on Base (8453), implementation 0xbEb5Fc57…, until Base's 2026-11-04 upgrade.
  "eas-native-1.0.1": { id: "eas-native-1.0.1", domainVersion: "1.0.1", signedDeadline: false, signedSigner: false,
    attestTypeHash: "0xdbfdf8dc2b135c26253e00d5b6cbe6f20457e003fd526d97cea183883570de61",
    revokeTypeHash: "0xa98d02348410c9c76735e0d0bb1396f4015ac2bb9615f9c2611d19d7a8a99650" },
  // First qualified on Base Sepolia (84532) until its 2026-10-22 upgrade.
  "eas-native-1.2.0": { id: "eas-native-1.2.0", domainVersion: "1.2.0", signedDeadline: true, signedSigner: false,
    attestTypeHash: "0xf83bb2b0ede93a840239f7e701a54d9bc35f03701f51ae153d601c6947ff3d3f",
    revokeTypeHash: "0x2d4116d8c9824e4c316453e5c2843a1885580374159ce8768603c49085ef424c" },
  // Signing domain 1.3.0: Base Sepolia since block 48858051 (2026-10-22), Base since block 53508490 (2026-11-04).
  "eas-native-1.4.1-beta.3": { id: "eas-native-1.4.1-beta.3", domainVersion: "1.3.0", signedDeadline: true, signedSigner: true,
    attestTypeHash: "0xfeb2925a02bae3dae48d424a0437a2b6ac939aa9230ddc55a1a76f065d988076",
    revokeTypeHash: "0xb5d556f07587ec0f08cf386545cc4362c702a001650c2058002615ee5c9d1e75" },
};
/** Chains whose EAS is the OP Stack predeploy, whose upgrades only the chain's governance can make. */
export const EAS_REVIEW_CHAINS: ReadonlySet<number> = new Set([8453, 84532]);
const PREDEPLOY = "0x4200000000000000000000000000000000000021";
export const EAS_IDENTITY_ABI = parseAbi([
  "function version() view returns (string)", "function getDomainSeparator() view returns (bytes32)",
  "function getAttestTypeHash() view returns (bytes32)", "function getRevokeTypeHash() view returns (bytes32)",
]);

export function incompatibleEas(): CliError {
  return new CliError({ code: "DASKI_CONFIRMATION_EAS_INCOMPATIBLE",
    message: "The deployed EAS signing format does not match a qualified review profile.",
    remediation: "Do not sign or submit a review. Update the buyer and have the gateway operator verify the target EAS deployment." });
}

/** Reads through the profile RPC independently of gateway-provided typed data. */
export async function discoverEasReviewProfile(chain: ChainReader, chainId: number, eas: Address): Promise<EasReviewProfile> {
  if (!EAS_REVIEW_CHAINS.has(chainId) || eas.toLowerCase() !== PREDEPLOY) throw incompatibleEas();
  const blockNumber = await chain.getFinalBlockNumber();
  // One batched eth_call: a public RPC refuses a burst of separate ones.
  const [domain, attest, revoke] = await readContracts(chain, ["getDomainSeparator", "getAttestTypeHash", "getRevokeTypeHash"].map(functionName =>
    ({ address: eas, abi: EAS_IDENTITY_ABI, functionName, args: [] })), blockNumber) as readonly (string | undefined)[];
  const profile = Object.values(EAS_REVIEW_PROFILES).find(candidate =>
    attest?.toLowerCase() === candidate.attestTypeHash && revoke?.toLowerCase() === candidate.revokeTypeHash &&
    domain?.toLowerCase() === hashDomain({ types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] },
      domain: { name: "EAS", version: candidate.domainVersion, chainId: BigInt(chainId), verifyingContract: eas } }).toLowerCase());
  if (!profile) throw incompatibleEas();
  return profile;
}
