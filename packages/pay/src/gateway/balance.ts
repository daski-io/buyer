/**
 * Balance reads. RPC only, never a signing path.
 */
import { createPublicClient, erc20Abi, formatUnits, http, type Address } from "viem";

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
  const client = createPublicClient({ transport: http(options.rpcUrl) });
  const [native, usdc] = await Promise.all([
    client.getBalance({ address: options.address }),
    client.readContract({
      address: options.usdcAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [options.address],
    }) as Promise<bigint>,
  ]);
  return {
    nativeWei: native.toString(),
    native: `${formatUnits(native, 18)} ETH`,
    usdcAtomic: usdc.toString(),
    usdc: `${formatUnits(usdc, 6)} USDC`,
  };
}
