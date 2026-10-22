/**
 * Native EAS review profiles qualified from finalized Base/Deployed-code facts.
 * Contract version and signing domain version are independently pinned.
 * Unknown code, domains or type hashes fail before a payer signs anything.
 */
import { hashDomain, keccak256, parseAbi, type Address, type Hex } from "viem";
import { readContracts, type ChainReader } from "./reader.js";
import { CliError } from "../cli/errors.js";

export type EasReviewProfileId = "eas-native-1.0.1" | "eas-native-1.2.0" | "eas-native-1.4.1-beta.3";
export interface EasReviewProfile {
  id: EasReviewProfileId;
  chainId: number;
  contractVersion: string;
  domainVersion: string;
  signedDeadline: boolean;
  /** The signed Attest or Revoke struct starts with the signer, as `attester` or `revoker`. */
  signedSigner: boolean;
  implementation: Address;
  codeHash: Hex;
  attestTypeHash: Hex;
  revokeTypeHash: Hex;
}
/** A chain can present more than one: its EAS proxy names the implementation in use. */
export const EAS_REVIEW_PROFILES: Readonly<Record<EasReviewProfileId, EasReviewProfile>> = {
  "eas-native-1.0.1": { id: "eas-native-1.0.1", chainId: 8453, contractVersion: "1.0.1", domainVersion: "1.0.1", signedDeadline: false, signedSigner: false,
    implementation: "0xbEb5Fc579115071764c7423A4f12eDde41f106Ed",
    codeHash: "0x16b293cd7ed66fa1e03076e5847c59b146a83c187d991c42fe6056b3c1cc0513",
    attestTypeHash: "0xdbfdf8dc2b135c26253e00d5b6cbe6f20457e003fd526d97cea183883570de61",
    revokeTypeHash: "0xa98d02348410c9c76735e0d0bb1396f4015ac2bb9615f9c2611d19d7a8a99650" },
  "eas-native-1.2.0": { id: "eas-native-1.2.0", chainId: 84532, contractVersion: "1.2.0", domainVersion: "1.2.0", signedDeadline: true, signedSigner: false,
    implementation: "0xC0D3c0D3C0d3c0D3c0D3C0D3c0D3c0d3c0d30021",
    codeHash: "0x703f246f804f8d4b315fd7b5fc504671f726230373571e02b69794d0f2614fd7",
    attestTypeHash: "0xf83bb2b0ede93a840239f7e701a54d9bc35f03701f51ae153d601c6947ff3d3f",
    revokeTypeHash: "0x2d4116d8c9824e4c316453e5c2843a1885580374159ce8768603c49085ef424c" },
  // Base Sepolia's predeploy upgrade at block 48858051 (2026-10-22): signing domain 1.3.0.
  "eas-native-1.4.1-beta.3": { id: "eas-native-1.4.1-beta.3", chainId: 84532, contractVersion: "1.4.1-beta.3", domainVersion: "1.3.0", signedDeadline: true, signedSigner: true,
    implementation: "0xc919d2C8d3a7B617feA7604b68D862027bD02e64",
    codeHash: "0x5b1a9eac43a2752a4f6b83617cd580cf17abc5b15812c3cea6c26c4dd68fa721",
    attestTypeHash: "0xfeb2925a02bae3dae48d424a0437a2b6ac939aa9230ddc55a1a76f065d988076",
    revokeTypeHash: "0xb5d556f07587ec0f08cf386545cc4362c702a001650c2058002615ee5c9d1e75" },
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
  const candidates = Object.values(EAS_REVIEW_PROFILES).filter(profile => profile.chainId === chainId);
  if (!candidates.length || eas.toLowerCase() !== "0x4200000000000000000000000000000000000021" || !chain.getStorageAt) throw incompatibleEas();
  const blockNumber = await chain.getFinalBlockNumber();
  const [slot, [version, domain, attest, revoke]] = await Promise.all([
    chain.getStorageAt(eas, IMPLEMENTATION_SLOT, blockNumber),
    // One batched eth_call: a public RPC refuses a burst of separate ones.
    readContracts(chain, ["version", "getDomainSeparator", "getAttestTypeHash", "getRevokeTypeHash"].map(functionName =>
      ({ address: eas, abi: EAS_IDENTITY_ABI, functionName, args: [] })), blockNumber) as Promise<readonly (string | undefined)[]>,
  ]);
  // The proxy's implementation slot selects the candidate; every other fact must then match it exactly.
  const profile = candidates.find(candidate => slot?.slice(-40).toLowerCase() === candidate.implementation.slice(2).toLowerCase());
  if (!profile) throw incompatibleEas();
  const code = await chain.getCode(profile.implementation, blockNumber);
  if (!code || code === "0x" || keccak256(code) !== profile.codeHash || version !== profile.contractVersion ||
      domain?.toLowerCase() !== hashDomain({ types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] }, domain: { name: "EAS", version: profile.domainVersion, chainId: BigInt(chainId), verifyingContract: eas } }).toLowerCase() ||
      attest?.toLowerCase() !== profile.attestTypeHash || revoke?.toLowerCase() !== profile.revokeTypeHash) throw incompatibleEas();
  return profile;
}
