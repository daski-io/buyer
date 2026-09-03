/**
 * `daski doctor` — is this machine ready to buy, and if not, exactly what do I
 * type next?
 *
 * Every issue carries a remediation that is a command or a URL, never advice.
 * Exit 0 iff nothing blocking was found; warnings (a dev-mode key, a
 * world-writable config) report but do not fail, because they describe a
 * posture rather than a broken setup.
 */
import type { Address } from "viem";
import { CliError } from "../cli/errors.js";
import { permissionWarnings, applyCapOverrides, loadConfig, CONFIG_DOC } from "../config.js";
import { readBalances } from "../gateway/balance.js";
import { GatewayClient, probeGatewayProtocol, readiness, type GatewayProtocolProbe } from "../gateway/client.js";
import { configPath, daskiHome } from "../paths.js";
import { createSigner } from "../signers/index.js";
import { runSignerSelfTest, type SignerSelfTestResult } from "../signers/selfTest.js";
import { locateKey } from "../store/keystore.js";
import { authorizedTotalAtomic } from "../store/orders.js";
import { CLI_VERSION } from "../version.js";
import type { SignerAdapter } from "@daski/x402-scheme";

const SIGNERS_DOC = "https://github.com/daski-io/buyer/blob/main/docs/signers.md";

export interface DoctorIssue {
  severity: "blocking" | "warning";
  code: string;
  message: string;
  remediation: string;
}

export interface DoctorOptions {
  profile?: string | undefined;
  maxPerOrderUsdc?: string | undefined;
  sessionCapUsdc?: string | undefined;
  signerOverride?: string | undefined;
  cdpAccount?: string | undefined;
  circleWallet?: string | undefined;
}

export interface DoctorReport {
  cliVersion: string;
  profile: string;
  stateDirectory: string;
  configFile: string;
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
  const loaded = loadConfig(options.profile);
  const profile = applyCapOverrides(loaded.profile, {
    maxPerOrderUsdc: options.maxPerOrderUsdc,
    sessionCapUsdc: options.sessionCapUsdc,
  });
  for (const warning of [...loaded.warnings, ...permissionWarnings(configPath())]) {
    if (issues.some((issue) => issue.code === warning.code)) continue;
    issues.push({ severity: "warning", ...warning });
  }

  // -- signer --------------------------------------------------------------
  const location = await locateKey(loaded.profileName);
  let signer: SignerAdapter | undefined;
  let address: Address | undefined;
  let selfTest: SignerSelfTestResult | undefined;
  const signerKind = options.signerOverride ?? profile.signer;
  try {
    signer = await createSigner({
      kind: signerKind as never,
      profile: loaded.profileName,
      cdpAccount: options.cdpAccount,
      circleWallet: options.circleWallet,
    });
    address = await signer.getAddress();
    // The signer's word is not enough: sign a fixed, unsettleable vector and
    // check it the way the gateway will. A signer that throws fails here too.
    selfTest = await runSignerSelfTest(signer, profile.chainId);
    if (!selfTest.passed) {
      issues.push({
        severity: "blocking",
        code: "DASKI_SIGNER_SELF_TEST_FAILED",
        message:
          `The ${signerKind} signer failed the self-test: ` +
          `${selfTest.reason ?? "no reason given"}.`,
        remediation:
          "Daski settles EIP-3009 typed data by plain low-s ECDSA recovery, so a " +
          "signer whose signatures do not recover to its own address cannot buy. " +
          `Try --signer local, or see ${SIGNERS_DOC}#self-test`,
      });
    }
  } catch (error) {
    issues.push({
      severity: "blocking",
      code: error instanceof CliError ? error.code : "DASKI_SIGNER_UNAVAILABLE",
      message: error instanceof Error ? error.message : String(error),
      remediation: error instanceof CliError
        ? error.remediation
        : `Run: daski wallet create --profile ${loaded.profileName}`,
    });
  }
  if (location?.source === "environment") {
    issues.push({
      severity: "warning",
      code: "DASKI_ENV_KEY_IN_USE",
      message:
        "The signing key comes from DASKI_PAYER_PRIVATE_KEY. That is a " +
        "developer/sandbox convenience: the key sits in this process's " +
        "environment, where any child process and most crash reporters can read it.",
      remediation:
        `Move it into the OS keychain: unset DASKI_PAYER_PRIVATE_KEY and run ` +
        `\`daski wallet create --profile ${loaded.profileName}\`. See ${CONFIG_DOC}`,
    });
  }
  const description = signer?.describe();
  if (description?.conformance === "candidate-pending-conformance") {
    issues.push({
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
      balances = { ...await readBalances({
        rpcUrl: profile.rpcUrl,
        address,
        usdcAddress: profile.usdcAddress,
      }) };
      if (BigInt(String(balances.usdcAtomic)) === 0n) {
        issues.push({
          severity: "warning",
          code: "DASKI_NO_USDC",
          message: `${address} holds no USDC on ${profile.network}, so no purchase can settle.`,
          // The same sentence on every chain: where the USDC comes from is the
          // operator's business, and this CLI has no opinion about it.
          remediation: `Fund ${address} with USDC on ${profile.network} before buying.`,
        });
      }
    } catch (error) {
      issues.push({
        severity: "warning",
        code: "DASKI_RPC_UNAVAILABLE",
        message: `Could not read balances from ${profile.rpcUrl}: ${(error as Error).message}`,
        remediation: `Set a working rpcUrl for the "${loaded.profileName}" profile in ${configPath()}`,
      });
    }
  }

  // -- gateway -------------------------------------------------------------
  const health = await readiness(profile.gatewayUrl);
  if (!health.reachable) {
    issues.push({
      severity: "blocking",
      code: "DASKI_GATEWAY_UNREACHABLE",
      message: `${profile.gatewayUrl}/health/ready did not answer: ${health.error ?? "unknown error"}`,
      remediation:
        `Check connectivity and the gatewayUrl for the "${loaded.profileName}" ` +
        `profile in ${configPath()}`,
    });
  } else if (health.status !== "ready") {
    issues.push({
      severity: "blocking",
      code: "DASKI_GATEWAY_NOT_READY",
      message: `The gateway reports status "${health.status ?? "unknown"}".`,
      remediation: "Wait for the gateway to become ready, then re-run: daski doctor --json",
    });
  }

  // -- gateway protocol ----------------------------------------------------
  // /health/ready says the process is up; it cannot say whether this CLI can
  // read what the MCP tools return. One read-only round trip settles that,
  // so "exit 0" means a purchase can actually complete.
  let protocol: GatewayProtocolProbe | null = null;
  if (health.reachable && health.status === "ready") {
    protocol = await probeGatewayProtocol(new GatewayClient({ gatewayUrl: profile.gatewayUrl }));
    if (!protocol.reachable) {
      issues.push({
        severity: "blocking",
        code: "DASKI_GATEWAY_MCP_UNREACHABLE",
        message: `${profile.gatewayUrl}/mcp did not answer: ${protocol.error ?? "unknown error"}`,
        remediation: "Check connectivity to the gateway's /mcp endpoint, then re-run: daski doctor --json",
      });
    } else if (!protocol.tools.includes("daski_buy_outcome")) {
      issues.push({
        severity: "blocking",
        code: "DASKI_GATEWAY_TOOLS_MISSING",
        message: `The gateway at ${profile.gatewayUrl} does not advertise daski_buy_outcome.`,
        remediation:
          `Point the "${loaded.profileName}" profile's gatewayUrl at a Daski gateway in ` +
          `${configPath()}, then re-run: daski doctor --json`,
      });
    } else if (!protocol.readableVia) {
      issues.push({
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
    signer: {
      provider: description?.provider ?? signerKind,
      accountType: description?.accountType ?? "unknown",
      conformance: description?.conformance ?? "unknown",
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
      rpcUrl: profile.rpcUrl,
    },
    balances,
    caps: {
      maxPerOrderUsdc: profile.maxPerOrderUsdc,
      sessionCapUsdc: profile.sessionCapUsdc,
      requireApprovalAboveUsdc: profile.requireApprovalAboveUsdc,
      sessionAuthorizedAtomic: spent.toString(),
      note: "Caps are human-owned: edit the config file. Flags may only lower them.",
    },
    gateway: {
      url: profile.gatewayUrl,
      reachable: health.reachable,
      status: health.status ?? null,
      version: health.version ?? null,
      mcp: protocol
        ? { reachable: protocol.reachable, tools: protocol.tools.length, readableVia: protocol.readableVia }
        : null,
    },
    issues,
    ok: !issues.some((issue) => issue.severity === "blocking"),
  };
}
