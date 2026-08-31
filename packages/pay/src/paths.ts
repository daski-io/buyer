/** Where the bridge keeps its state. One directory, three files, no surprises. */
import { homedir } from "node:os";
import { join } from "node:path";

/** `~/.daski`, or `$DASKI_HOME` when set (used by the conformance suite). */
export function daskiHome(): string {
  return process.env.DASKI_HOME ?? join(homedir(), ".daski");
}

export const configPath = (): string => join(daskiHome(), "config.json");
export const ordersPath = (): string => join(daskiHome(), "orders.json");
export const keystorePath = (): string => join(daskiHome(), "keystore.json");
