/**
 * Registration helper.
 *
 * `x402Client.register(network, client)` maps one network to one handler, so
 * registering the composite for a network is exactly how the wrap takes
 * effect: Daski challenges take the validating path, everything else reaches
 * the stock handler through the composite unchanged. We never register a
 * second `exact` handler alongside the stock one, and we never rename the
 * scheme.
 */
import type { Address } from "viem";
import { DaskiExactEvmScheme, type DaskiExactEvmSchemeOptions, type SchemeNetworkClientLike } from "./scheme.js";
import type { PolicyConfig } from "./policy.js";
import type { PurchaseContextResolver } from "./scheme.js";
import type { SignerAdapter } from "./signer.js";

/** Minimal structural view of the host's `x402Client`. */
export interface X402ClientLike {
  register(network: string, client: SchemeNetworkClientLike): unknown;
}

export interface RegisterOptions {
  /** CAIP-2 network, e.g. `eip155:84532`. */
  network: string;
  signer: SignerAdapter;
  payerAddress: Address;
  policy: PolicyConfig;
  /** The stock `ExactEvmScheme` instance to wrap. */
  stock: SchemeNetworkClientLike;
  resolvePurchaseContext: PurchaseContextResolver;
  now?: () => number;
}

/**
 * Wraps `stock` in the Daski composite and registers it for one network.
 * Returns the composite so the caller can inspect or reuse it.
 */
export function registerDaskiExactEvmScheme(
  client: X402ClientLike,
  options: RegisterOptions,
): DaskiExactEvmScheme {
  const { network, ...rest } = options;
  const composite = new DaskiExactEvmScheme(rest satisfies DaskiExactEvmSchemeOptions);
  client.register(network, composite);
  return composite;
}
