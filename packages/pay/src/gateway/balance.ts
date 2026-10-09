/**
 * Balance reads. RPC only, never a signing path.
 */
import { createPublicClient, erc20Abi, formatUnits, http, type Address } from "viem";
import { rpcFailure, rpcFetch } from "../chain/reader.js";

export interface Balances {
  nativeWei: string;
  native: string;
  usdcAtomic: string;
  usdc: string;
}

export async function readBalances(options: {
  rpcUrl: string;
  address: Address;
  usdcAddress: Address;
}): Promise<Balances> {
  const client = createPublicClient({ transport: http(options.rpcUrl, { fetchFn: rpcFetch }) });
  // A viem error's message ends with the full request URL, where providers put API keys.
  const [native, usdc] = await Promise.all([
    client.getBalance({ address: options.address }),
    client.readContract({
      address: options.usdcAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [options.address],
    }) as Promise<bigint>,
  ]).catch((error: unknown) => { throw rpcFailure(options.rpcUrl, error); });
  return {
    nativeWei: native.toString(),
    native: `${formatUnits(native, 18)} ETH`,
    usdcAtomic: usdc.toString(),
    usdc: `${formatUnits(usdc, 6)} USDC`,
  };
}
