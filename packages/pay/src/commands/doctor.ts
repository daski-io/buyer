/**
 * `daski doctor` — is this machine ready to buy, and if not, exactly what do I
 * type next?
 *
 * Every issue carries a remediation that is a command or a URL, never advice.
 * Exit 0 iff nothing blocking was found; warnings (a dev-mode key, a
 * world-writable config) report but do not fail, because they describe a
 * posture rather than a broken setup.
 *
 * The report states each fact on its own: where the CLI runs (host class),
 * where a local key would live (key backend) and what that store guarantees
 * (key durability), which signer is selected and what kind of account it is,
 * how its self-test verified, whether a contract wallet is deployed, and what
 * the gateway verifies and pins.
 */
import { getAddress, isAddressEqual, type Address } from "viem";
import type { SignerAdapter } from "@daski/x402-scheme";
import { createChainReader, type ChainReader } from "../chain/reader.js";
import { CliError } from "../cli/errors.js";
import {
  permissionWarnings, applyCapOverrides, loadConfig, CONFIG_DOC, SIGNER_KINDS, type SignerKind,
} from "../config.js";
import { readBalances } from "../gateway/balance.js";
import {
  GatewayClient,
  compareReleaseVersions,
  probeGatewayProtocol,
  readiness,
  type GatewayProtocolProbe,
} from "../gateway/client.js";
import {
  easAddressMismatch, readGatewayMetadata, type GatewayMetadata,
} from "../gateway/metadata.js";
import {
  detectLegacyKeyringEntry, keyBackendFor, keyNotDurable, resolveHost,
  type HostEnvironment, type KeyDurability,
} from "../host.js";
import { configPath, daskiHome } from "../paths.js";
import {
  checkDeployment, gatewayEoaOnly, isContractSigner, signerNotDeployed, type Deployment,
} from "../signers/contract.js";
import { createSigner } from "../signers/index.js";
import { localKeyStore } from "../signers/local.js";
import { runSignerSelfTest, type SignerSelfTestResult } from "../signers/selfTest.js";
import { locateKey, type KeyLocation } from "../store/keystore.js";
import { authorizedTotalAtomic } from "../store/orders.js";
import { CLI_VERSION } from "../version.js";

const SIGNERS_DOC = "https://github.com/daski-io/buyer/blob/main/docs/signers.md";

export interface DoctorIssue {
  severity: "blocking" | "warning";
  code: string;
  message: string;
  remediation: string;
}

/** The network probes `doctor` runs, injectable so the report can be tested offline. */
export interface DoctorTransport {
  readiness: typeof readiness;
  probe: typeof probeGatewayProtocol;
  metadata: (gatewayUrl: string) => Promise<GatewayMetadata>;
  chain: (rpcUrl: string) => ChainReader;
  balances: typeof readBalances;
}

export interface DoctorOptions {
  profile?: string | undefined;
  maxPerOrderUsdc?: string | undefined;
  sessionCapUsdc?: string | undefined;
  signerOverride?: string | undefined;
  cdpAccount?: string | undefined;
  circleWallet?: string | undefined;
  host?: HostEnvironment | undefined;
  transport?: Partial<DoctorTransport> | undefined;
}

export interface DoctorReport {
  cliVersion: string;
  profile: string;
  stateDirectory: string;
  configFile: string;
  host: { hostClass: string; keyBackend: string; keyDurability: KeyDurability };
  signer: Record<string, unknown>;
  chain: Record<string, unknown>;
  balances: Record<string, unknown> | null;
  caps: Record<string, unknown>;
  gateway: Record<string, unknown>;
  issues: DoctorIssue[];
  ok: boolean;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const issues: DoctorIssue[] = [];
  const addIssue = (issue: DoctorIssue): void => {
    if (!issues.some((existing) => existing.code === issue.code)) issues.push(issue);
  };
  const blockingFrom = (error: unknown, fallbackRemediation: string): DoctorIssue => ({
    severity: "blocking",
    code: error instanceof CliError ? error.code : "DASKI_SIGNER_UNAVAILABLE",
    message: error instanceof Error ? error.message : String(error),
    remediation: error instanceof CliError ? error.remediation : fallbackRemediation,
  });
  const transport: DoctorTransport = {
    readiness, probe: probeGatewayProtocol, metadata: readGatewayMetadata, chain: createChainReader,
    balances: readBalances,
    ...options.transport,
  };

  const loaded = loadConfig(options.profile);
  const profile = applyCapOverrides(loaded.profile, {
    maxPerOrderUsdc: options.maxPerOrderUsdc,
    sessionCapUsdc: options.sessionCapUsdc,
  });
  for (const warning of [...loaded.warnings, ...permissionWarnings(configPath())]) {
    addIssue({ severity: "warning", ...warning });
  }

  // -- host ------------------------------------------------------------------
  let host: HostEnvironment;
  try {
    host = options.host ?? resolveHost();
  } catch (error) {
    addIssue(blockingFrom(error, `See ${CONFIG_DOC}`));
    host = resolveHost({}, process.platform);
  }
  const signerKind = (options.signerOverride ?? profile.signer) as SignerKind;
  const backend = keyBackendFor(host, SIGNER_KINDS.includes(signerKind) ? signerKind : "local");
  const chain = transport.chain(profile.rpcUrl);

  // -- local key -------------------------------------------------------------
  let location: KeyLocation | undefined;
  let keyDurability: KeyDurability = "none";
  if (signerKind === "local") {
    try {
      location = await locateKey(loaded.profileName, localKeyStore(host));
    } catch (error) {
      addIssue(blockingFrom(error, `Run: daski wallet create --profile ${loaded.profileName}`));
    }
    if (location) {
      keyDurability = location.durability;
    } else if (detectLegacyKeyringEntry(host, loaded.profileName)) {
      // A detector only: the key it finds is never read, and nothing overrides this.
      keyDurability = "session-memory";
      addIssue({ severity: "blocking", ...issueFields(keyNotDurable(loaded.profileName)) });
    }
  }

  // -- signer ------------------------------------------------------------------
  let signer: SignerAdapter | undefined;
  let address: Address | undefined;
  let selfTest: SignerSelfTestResult | undefined;
  let deployment: Deployment = "not-applicable";
  try {
    signer = await createSigner({
      kind: signerKind,
      profile: loaded.profileName,
      host,
      chainId: profile.chainId,
      cdpAccount: options.cdpAccount,
      circleWallet: options.circleWallet,
    });
    address = getAddress(await signer.getAddress());
    if (isContractSigner(signer)) {
      // A counterfactual wallet cannot verify anything; say so before the self-test would.
      deployment = await checkDeployment(signer, chain);
      if (deployment === "not-deployed") {
        addIssue({ severity: "blocking", ...issueFields(signerNotDeployed(address)) });
      }
    }
    if (deployment !== "not-deployed") {
      // The signer's word is not enough: sign a fixed, unsettleable vector and
      // check it the way the gateway will. A signer that throws fails here too.
      selfTest = await runSignerSelfTest(signer, profile.chainId, chain);
      if (!selfTest.passed) {
        addIssue({
          severity: "blocking",
          code: "DASKI_SIGNER_SELF_TEST_FAILED",
          message:
            `The ${signerKind} signer failed the self-test: ` +
            `${selfTest.reason ?? "no reason given"}.`,
          remediation: isContractSigner(signer)
            ? "Daski verifies a contract account's signature by asking the deployed wallet's " +
              "isValidSignature for the hash it computed itself, so a wallet that does not " +
              `answer with the ERC-1271 magic value cannot buy. See ${SIGNERS_DOC}#self-test`
            : "Daski settles EIP-3009 typed data by plain low-s ECDSA recovery, so a " +
              "signer whose signatures do not recover to its own address cannot buy. " +
              `Try --signer local, or see ${SIGNERS_DOC}#self-test`,
        });
      }
    }
  } catch (error) {
    addIssue(blockingFrom(error, `Run: daski wallet create --profile ${loaded.profileName}`));
  }
  if (location?.source === "environment") {
    addIssue({
      severity: "warning",
      code: "DASKI_ENV_KEY_IN_USE",
      message:
        "The signing key comes from DASKI_PAYER_PRIVATE_KEY. That is a " +
        "developer/sandbox convenience: the key sits in this process's " +
        "environment, where any child process and most crash reporters can read it.",
      remediation:
        `Move it into a durable store: unset DASKI_PAYER_PRIVATE_KEY and run ` +
        `\`daski wallet create --profile ${loaded.profileName}\`. See ${CONFIG_DOC}`,
    });
  }
  const description = signer?.describe();
  if (description?.conformance === "candidate-pending-conformance") {
    addIssue({
      severity: "warning",
      code: "DASKI_SIGNER_PENDING_CONFORMANCE",
      message:
        `The ${description.provider} signer has not passed the conformance ` +
        "suite, so its signatures are not yet known to satisfy the gateway.",
      remediation:
        `Run: DASKI_CONFORMANCE_SPEND_OK=1 npm run conformance -- --profile ` +
        `${loaded.profileName} --signer ${description.provider}`,
    });
  }

  // -- balances ------------------------------------------------------------
  let balances: Record<string, unknown> | null = null;
  if (address) {
    try {
      balances = { ...await transport.balances({
        rpcUrl: profile.rpcUrl,
        address,
        usdcAddress: profile.usdcAddress,
      }) };
      if (BigInt(String(balances.usdcAtomic)) === 0n) {
        addIssue({
          severity: "warning",
          code: "DASKI_NO_USDC",
          message: `${address} holds no USDC on ${profile.network}, so no purchase can settle.`,
          // The same sentence on every chain: where the USDC comes from is the
          // operator's business, and this CLI has no opinion about it.
          remediation: `Fund ${address} with USDC on ${profile.network} before buying.`,
        });
      }
    } catch (error) {
      addIssue({
        severity: "warning",
        code: "DASKI_RPC_UNAVAILABLE",
        message: `Could not read balances from ${profile.rpcUrl}: ${(error as Error).message}`,
        remediation: `Set a working rpcUrl for the "${loaded.profileName}" profile in ${configPath()}`,
      });
    }
  }

  // -- gateway -------------------------------------------------------------
  const health = await transport.readiness(profile.gatewayUrl);
  if (!health.reachable) {
    addIssue({
      severity: "blocking",
      code: "DASKI_GATEWAY_UNREACHABLE",
      message: `${profile.gatewayUrl}/health/ready did not answer: ${health.error ?? "unknown error"}`,
      remediation:
        `Check connectivity and the gatewayUrl for the "${loaded.profileName}" ` +
        `profile in ${configPath()}`,
    });
  } else if (health.status !== "ready") {
    addIssue({
      severity: "blocking",
      code: "DASKI_GATEWAY_NOT_READY",
      message: `The gateway reports status "${health.status ?? "unknown"}".`,
      remediation: "Wait for the gateway to become ready, then re-run: daski doctor --json",
    });
  }

  // -- gateway metadata: pin, account types, confirmation pins -----------------
  // The gateway's setup guide pins the CLI release agents may use, and
  // publishes it in /.well-known/mcp.json. An older install has known
  // payment defects (0.1.0 and 0.1.1 minted their own payment identifier and
  // every purchase was refused), and on 2026-09-04 one ran unnoticed because
  // the pin lived only in prose. This is the comparison the guide asks for.
  let metadata: GatewayMetadata | null = null;
  if (health.reachable) {
    try {
      metadata = await transport.metadata(profile.gatewayUrl);
    } catch (error) {
      addIssue({ severity: "warning", ...issueFields(error as CliError) });
    }
  }
  const pinned = metadata?.buyerCli ?? null;
  if (pinned) {
    const comparison = compareReleaseVersions(CLI_VERSION, pinned.version);
    if (comparison !== null && comparison < 0) {
      addIssue({
        severity: "blocking",
        code: "DASKI_CLI_OUTDATED",
        message:
          `This is ${pinned.package} ${CLI_VERSION}; the gateway at ${profile.gatewayUrl} ` +
          `pins ${pinned.version}, and releases before the pin have known payment defects.`,
        remediation:
          `${pinned.install ?? `npm install -g ${pinned.package}@${pinned.version}`}, ` +
          "then re-run: daski doctor --json",
      });
    }
  }
  if (metadata && signer && isContractSigner(signer) && !metadata.payerAccounts?.types.includes("contract")) {
    addIssue({ severity: "blocking", ...issueFields(gatewayEoaOnly(profile.gatewayUrl)) });
  }
  const pins = metadata?.confirmationSigning ?? null;
  if (pins && pins.chainId !== profile.chainId) {
    addIssue({
      severity: "blocking",
      code: "DASKI_GATEWAY_CHAIN_MISMATCH",
      message: `The gateway signs confirmations on chain ${pins.chainId}; this profile is on ${profile.chainId}.`,
      remediation: `Point the "${loaded.profileName}" profile at the gateway for ${profile.network} in ${configPath()}`,
    });
  }
  if (pins && !isAddressEqual(pins.eas, profile.easAddress)) {
    addIssue({ severity: "blocking", ...issueFields(easAddressMismatch(pins.eas, profile.easAddress, profile.chainId)) });
  }

  // -- gateway protocol ----------------------------------------------------
  // /health/ready says the process is up; it cannot say whether this CLI can
  // read what the MCP tools return. One read-only round trip settles that,
  // so "exit 0" means a purchase can actually complete.
  let protocol: GatewayProtocolProbe | null = null;
  if (health.reachable && health.status === "ready") {
    protocol = await transport.probe(new GatewayClient({ gatewayUrl: profile.gatewayUrl }));
    if (!protocol.reachable) {
      addIssue({
        severity: "blocking",
        code: "DASKI_GATEWAY_MCP_UNREACHABLE",
        message: `${profile.gatewayUrl}/mcp did not answer: ${protocol.error ?? "unknown error"}`,
        remediation: "Check connectivity to the gateway's /mcp endpoint, then re-run: daski doctor --json",
      });
    } else if (!protocol.tools.includes("daski_buy_outcome")) {
      addIssue({
        severity: "blocking",
        code: "DASKI_GATEWAY_TOOLS_MISSING",
        message: `The gateway at ${profile.gatewayUrl} does not advertise daski_buy_outcome.`,
        remediation:
          `Point the "${loaded.profileName}" profile's gatewayUrl at a Daski gateway in ` +
          `${configPath()}, then re-run: daski doctor --json`,
      });
    } else if (!protocol.readableVia) {
      addIssue({
        severity: "blocking",
        code: "DASKI_GATEWAY_PROTOCOL_MISMATCH",
        message:
          "The gateway answered a read-only tool call, but this CLI found no JSON payload " +
          "in the result, so no purchase, order read, or reconciliation can complete.",
        remediation:
          "Upgrade to the @daski/pay version the gateway's /skills/setup.md pins, then " +
          "re-run: daski doctor --json",
      });
    }
  }

  const spent = authorizedTotalAtomic(loaded.profileName);
  return {
    cliVersion: CLI_VERSION,
    profile: loaded.profileName,
    stateDirectory: daskiHome(),
    configFile: configPath(),
    host: {
      hostClass: host.hostClass,
      keyBackend: backend,
      keyDurability,
    },
    signer: {
      signerKind,
      provider: description?.provider ?? signerKind,
      accountType: description?.accountType ?? "unknown",
      verifiedVia: selfTest?.passed ? selfTest.verifiedVia : null,
      deployment,
      conformance: description?.conformance === "verified" ? "verified"
        : description?.conformance === "candidate-pending-conformance" ? "candidate" : "unknown",
      address: address ?? null,
      keySource: location?.source ?? "none",
      keyLocation: location?.description ?? null,
      // Null only when no signer could be created; every created signer is tested.
      selfTest: selfTest ?? null,
    },
    chain: {
      network: profile.network,
      chainId: profile.chainId,
      canonicalUsdc: profile.usdcAddress,
      easAddress: profile.easAddress,
      rpcUrl: profile.rpcUrl,
    },
    balances,
    caps: {
      maxPerOrderUsdc: profile.maxPerOrderUsdc,
      sessionCapUsdc: profile.sessionCapUsdc,
      requireApprovalAboveUsdc: profile.requireApprovalAboveUsdc,
      sessionAuthorizedAtomic: spent.toString(),
      mode: profile.maxPerOrderUsdc === null && profile.sessionCapUsdc === null
        ? "quote-approval" : "configured-budgets",
      configurationVersion: loaded.config.version,
      note: "Purchases use quote approval. Optional budgets can be viewed or changed with daski budget.",
    },
    gateway: {
      url: profile.gatewayUrl,
      reachable: health.reachable,
      status: health.status ?? null,
      version: health.version ?? null,
      pinnedCli: pinned,
      payerAccounts: metadata?.payerAccounts ?? null,
      confirmation: metadata?.confirmation ?? null,
      confirmationSigning: pins,
      signerClis: metadata?.signerClis ?? null,
      mcp: protocol
        ? { reachable: protocol.reachable, tools: protocol.tools.length, readableVia: protocol.readableVia }
        : null,
    },
    issues,
    ok: !issues.some((issue) => issue.severity === "blocking"),
  };
}

function issueFields(error: CliError): Omit<DoctorIssue, "severity"> {
  return { code: error.code, message: error.message, remediation: error.remediation };
}
