/**
 * Native EAS review profiles qualified from finalized Base/Deployed-code facts.
 * Contract version and signing domain version are independently pinned.
 * Unknown code, domains or type hashes fail before a payer signs anything.
 */
import { hashDomain, keccak256, parseAbi, type Address, type Hex } from "viem";
import { readContracts, type ChainReader } from "./reader.js";
import { CliError } from "../cli/errors.js";

export type EasReviewProfileId = "eas-native-1.0.1" | "eas-native-1.2.0";
export interface EasReviewProfile {
  id: EasReviewProfileId;
  contractVersion: string;
  domainVersion: string;
  signedDeadline: boolean;
  implementation: Address;
  codeHash: Hex;
  attestTypeHash: Hex;
  revokeTypeHash: Hex;
}
export const EAS_REVIEW_PROFILES: Readonly<Record<number, EasReviewProfile>> = {
  8453: { id: "eas-native-1.0.1", contractVersion: "1.0.1", domainVersion: "1.0.1", signedDeadline: false,
    implementation: "0xbEb5Fc579115071764c7423A4f12eDde41f106Ed",
    codeHash: "0x16b293cd7ed66fa1e03076e5847c59b146a83c187d991c42fe6056b3c1cc0513",
    attestTypeHash: "0xdbfdf8dc2b135c26253e00d5b6cbe6f20457e003fd526d97cea183883570de61",
    revokeTypeHash: "0xa98d02348410c9c76735e0d0bb1396f4015ac2bb9615f9c2611d19d7a8a99650" },
  84532: { id: "eas-native-1.2.0", contractVersion: "1.2.0", domainVersion: "1.2.0", signedDeadline: true,
    implementation: "0xC0D3c0D3C0d3c0D3c0D3C0D3c0D3c0d3c0d30021",
    codeHash: "0x703f246f804f8d4b315fd7b5fc504671f726230373571e02b69794d0f2614fd7",
    attestTypeHash: "0xf83bb2b0ede93a840239f7e701a54d9bc35f03701f51ae153d601c6947ff3d3f",
    revokeTypeHash: "0x2d4116d8c9824e4c316453e5c2843a1885580374159ce8768603c49085ef424c" },
};
export const EAS_IDENTITY_ABI = parseAbi([
  "function version() view returns (string)", "function getDomainSeparator() view returns (bytes32)",
  "function getAttestTypeHash() view returns (bytes32)", "function getRevokeTypeHash() view returns (bytes32)",
]);
const IMPLEMENTATION_SLOT: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export function incompatibleEas(): CliError {
  return new CliError({ code: "DASKI_CONFIRMATION_EAS_INCOMPATIBLE",
    message: "The deployed EAS implementation does not match a qualified review profile.",
    remediation: "Do not sign or submit a review. Update the buyer and have the gateway operator verify the target EAS deployment." });
}

/** Reads through the profile RPC independently of gateway-provided typed data. */
export async function discoverEasReviewProfile(chain: ChainReader, chainId: number, eas: Address): Promise<EasReviewProfile> {
  const profile = EAS_REVIEW_PROFILES[chainId];
  if (!profile || eas.toLowerCase() !== "0x4200000000000000000000000000000000000021" || !chain.getStorageAt) throw incompatibleEas();
  const blockNumber = await chain.getFinalBlockNumber();
  const [slot, code, [version, domain, attest, revoke]] = await Promise.all([
    chain.getStorageAt(eas, IMPLEMENTATION_SLOT, blockNumber),
    chain.getCode(profile.implementation, blockNumber),
    // One batched eth_call: a public RPC refuses a burst of separate ones.
    readContracts(chain, ["version", "getDomainSeparator", "getAttestTypeHash", "getRevokeTypeHash"].map(functionName =>
      ({ address: eas, abi: EAS_IDENTITY_ABI, functionName, args: [] })), blockNumber) as Promise<readonly (string | undefined)[]>,
  ]);
  if (!slot || !code || code === "0x" || slot.slice(-40).toLowerCase() !== profile.implementation.slice(2).toLowerCase() ||
      keccak256(code) !== profile.codeHash || version !== profile.contractVersion ||
      domain?.toLowerCase() !== hashDomain({ types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] }, domain: { name: "EAS", version: profile.domainVersion, chainId, verifyingContract: eas } }).toLowerCase() ||
      attest?.toLowerCase() !== profile.attestTypeHash || revoke?.toLowerCase() !== profile.revokeTypeHash) throw incompatibleEas();
  return profile;
}
