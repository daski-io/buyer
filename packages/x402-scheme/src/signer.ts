/**
 * The signer boundary.
 *
 * Everything above this line decides *what* may be signed; everything below
 * it holds the key. The gateway is on neither side — it never sees key
 * material, and no adapter here returns any.
 */
import type { Address, Hex } from "viem";
import type { TypedDataRequest } from "./eip712.js";

/** How a signer describes itself to `daski doctor`. */
export interface SignerDescription {
  /** e.g. `local`, `cdp`, `circle`. */
  provider: string;
  /** e.g. `eoa`, `smart-contract`. */
  accountType: "eoa" | "smart-contract" | "unknown";
  /** Set when an adapter has not yet passed the §6 conformance suite. */
  conformance?: "verified" | "candidate-pending-conformance";
}

/**
 * The one interface every wallet backend implements. Deliberately tiny: an
 * address, a typed-data signature, and a self-description. No raw message
 * signing, no transaction signing, no key export.
 */
export interface SignerAdapter {
  getAddress(): Promise<Address>;
  signTypedData(payload: TypedDataRequest): Promise<Hex>;
  describe(): SignerDescription;
}

/**
 * Adapts a `SignerAdapter` to the shape `@x402/evm`'s stock scheme expects.
 * The stock handler wants a synchronous `address`, so the caller resolves it
 * once up front.
 */
export function toClientEvmSigner(
  address: Address,
  adapter: SignerAdapter,
): { address: Address; signTypedData(payload: TypedDataRequest): Promise<Hex> } {
  return {
    address,
    signTypedData: (payload) => adapter.signTypedData(payload),
  };
}
