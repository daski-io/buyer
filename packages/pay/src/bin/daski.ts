#!/usr/bin/env node
/**
 * The `daski` entry point.
 *
 * Every command supports `--json`. Every failure exits non-zero with a code
 * and a remediation. Nothing here signs anything: the commands do, and only
 * through the §4 validator.
 */
import { assertKnownFlags, boolFlag, parseArgs, requireFlag, stringFlag } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { emit, emitError } from "../cli/output.js";
import { runBuy } from "../commands/buy.js";
import { runDoctor } from "../commands/doctor.js";
import {
  orderArtifact, orderCancel, orderConfirm, orderInput, orderStatus,
  orderReconcile,
} from "../commands/order.js";
import { runSignPayment } from "../commands/signPayment.js";
import { createWallet, walletAddress, walletBalance } from "../commands/wallet.js";
import { CLI_VERSION } from "../version.js";

/** Flags every command accepts. */
const GLOBAL_FLAGS = [
  "json", "profile", "signer", "cdp-account", "circle-wallet",
  "max-per-order", "session-cap",
] as const;

const USAGE = `daski ${CLI_VERSION} — the Daski buyer bridge

  The server proposes; this bridge validates against its own expectations and
  recomputes; your wallet signs; the gateway never sees your key.

Commands
  doctor                              Readiness report, with a remediation per issue
  wallet create                       Generate a local EOA (requires human confirmation)
  wallet address                      Print the active payer address
  wallet balance                      Print native + USDC balances
  buy --provider <id> --outcome <id> --request <file.json> [--payer <addr>]
                                      Challenge, approve, validate, sign, submit, record
  order status <handle>               Read an order's state
  order artifact <handle> [--output <file>]
                                      Write the result bytes to a file (never to stdout)
  order confirm <handle>              Confirm delivery
  order input <handle> --request <file.json>
                                      Submit requested customer input
  order cancel <handle>               Request cancellation
  order reconcile <handle|intentId>   Ask the gateway whether a payment settled; never re-signs
  sign-payment --challenge <file.json> [--provider <id> --outcome <id>]
                                      Validate, recompute, sign; print the paymentPayload

Global flags
  --json                              Machine-readable output
  --profile <name>                    Config profile (default: sandbox)
  --signer <local|cdp|circle>         Override the profile's signer
  --cdp-account <name>                CDP account for --signer cdp (or DASKI_CDP_ACCOUNT)
  --circle-wallet <id>                Circle wallet id for --signer circle (or DASKI_CIRCLE_WALLET)
  --max-per-order <usdc>              Lower the per-order cap for this run only
  --session-cap <usdc>                Lower the session cap for this run only

Caps live in ~/.daski/config.json and are human-owned: a flag may lower one,
never raise it. See https://github.com/daski-io/buyer#readme
`;

async function main(argv: string[]): Promise<number> {
  const { command, flags } = parseArgs(argv);
  const json = boolFlag(flags, "json");
  const output = { json };

  if (command.length === 0 || command[0] === "help" || boolFlag(flags, "help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command[0] === "version" || boolFlag(flags, "version")) {
    emit({ version: CLI_VERSION }, output);
    return 0;
  }

  const shared = {
    profile: stringFlag(flags, "profile"),
    signerOverride: stringFlag(flags, "signer"),
    cdpAccount: stringFlag(flags, "cdp-account"),
    circleWallet: stringFlag(flags, "circle-wallet"),
    maxPerOrderUsdc: stringFlag(flags, "max-per-order"),
    sessionCapUsdc: stringFlag(flags, "session-cap"),
  };

  switch (command[0]) {
    case "doctor": {
      assertKnownFlags(flags, GLOBAL_FLAGS);
      const report = await runDoctor(shared);
      emit({ ...report }, output);
      return report.ok ? 0 : 1;
    }

    case "wallet": {
      assertKnownFlags(flags, [...GLOBAL_FLAGS, "yes-human-approved"]);
      const walletOptions = {
        profile: shared.profile,
        signerOverride: shared.signerOverride,
        cdpAccount: shared.cdpAccount,
        circleWallet: shared.circleWallet,
        yesHumanApproved: boolFlag(flags, "yes-human-approved"),
      };
      switch (command[1]) {
        case "create": emit(await createWallet(walletOptions), output); return 0;
        case "address": emit(await walletAddress(walletOptions), output); return 0;
        case "balance": emit(await walletBalance(walletOptions), output); return 0;
        default:
          throw unknownSubcommand("wallet", command[1], ["create", "address", "balance"]);
      }
    }

    case "buy": {
      assertKnownFlags(flags, [...GLOBAL_FLAGS, "provider", "outcome", "request", "payer", "legacy-arg", "yes"]);
      const result = await runBuy({
        ...shared,
        providerAgentId: requireFlag(flags, "provider"),
        outcomeId: requireFlag(flags, "outcome"),
        requestFile: requireFlag(flags, "request"),
        payer: stringFlag(flags, "payer"),
        legacyArg: boolFlag(flags, "legacy-arg"),
        yes: boolFlag(flags, "yes"),
        json,
      });
      emit(result, output);
      return 0;
    }

    case "order": {
      const handle = command[2];
      if (!handle) {
        throw new CliError({
          code: "DASKI_ORDER_HANDLE_REQUIRED",
          message: `\`daski order ${command[1] ?? "<action>"}\` needs an order handle.`,
          remediation: "Pass the handle printed by `daski buy`, or its intent id.",
        });
      }
      const base = { ...shared, handle, json };
      switch (command[1]) {
        case "status":
          assertKnownFlags(flags, GLOBAL_FLAGS);
          emit(await orderStatus(base), output);
          return 0;
        case "artifact":
          assertKnownFlags(flags, [...GLOBAL_FLAGS, "output"]);
          emit(await orderArtifact({ ...base, output: stringFlag(flags, "output") }), output);
          return 0;
        case "confirm":
          assertKnownFlags(flags, GLOBAL_FLAGS);
          emit(await orderConfirm(base), output);
          return 0;
        case "cancel":
          assertKnownFlags(flags, GLOBAL_FLAGS);
          emit(await orderCancel(base), output);
          return 0;
        case "input":
          assertKnownFlags(flags, [...GLOBAL_FLAGS, "request"]);
          emit(await orderInput({ ...base, requestFile: requireFlag(flags, "request") }), output);
          return 0;
        case "reconcile":
          assertKnownFlags(flags, GLOBAL_FLAGS);
          emit(await orderReconcile(base), output);
          return 0;
        default:
          throw unknownSubcommand("order", command[1],
            ["status", "artifact", "confirm", "input", "cancel", "reconcile"]);
      }
    }

    case "sign-payment": {
      assertKnownFlags(flags, [...GLOBAL_FLAGS, "challenge", "provider", "outcome"]);
      emit(await runSignPayment({
        ...shared,
        challengeFile: requireFlag(flags, "challenge"),
        providerAgentId: stringFlag(flags, "provider"),
        outcomeId: stringFlag(flags, "outcome"),
        json,
      }), output);
      return 0;
    }

    default:
      throw new CliError({
        code: "DASKI_UNKNOWN_COMMAND",
        message: `Unknown command "${command[0]}".`,
        remediation: "Run `daski help` to see the available commands.",
      });
  }
}

function unknownSubcommand(group: string, given: string | undefined, known: string[]): CliError {
  return new CliError({
    code: "DASKI_UNKNOWN_SUBCOMMAND",
    message: `Unknown \`daski ${group}\` subcommand: ${given ?? "(none)"}`,
    remediation: `Use one of: ${known.map((name) => `daski ${group} ${name}`).join(", ")}`,
  });
}

const json = process.argv.includes("--json");
main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => { process.exitCode = emitError(error, { json }); });
