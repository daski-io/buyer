/**
 * §6 — the conformance suite.
 *
 * This is the acceptance gate for every signer adapter, present and future.
 * It runs against the live sandbox with a funded key and spends real testnet
 * USDC, so it refuses to start without an explicit `DASKI_CONFORMANCE_SPEND_OK=1`
 * — a suite that can be triggered by accident is a suite that drains a wallet
 * by accident.
 *
 * Everything is byte-logged to a run directory. Signatures may be redacted by
 * request; keys always are, unconditionally, because a run log is exactly the
 * kind of artifact that gets pasted into an issue tracker.
 *
 *   DASKI_CONFORMANCE_SPEND_OK=1 \
 *   DASKI_PAYER_PRIVATE_KEY=0x... \
 *   npm run conformance -- --profile sandbox --signer local
 *
 * `--signer circle-agent [--circle-wallet <address>]`, `--signer cdp --cdp-account
 * <name>` and `--signer circle --circle-wallet <id>` select the other adapters;
 * their credentials come from the environment or the vendor's own login.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatUsdc, PolicyRefusal } from "@daski/x402-scheme";
import { parseArgs, boolFlag, stringFlag } from "../src/cli/args.js";
import { redactValue } from "../src/cli/redact.js";
import { runDoctor } from "../src/commands/doctor.js";
import { createContext } from "../src/context.js";
import { GatewayClient, type GatewayCallLog } from "../src/gateway/client.js";
import { orderArtifact, orderConfirm, orderStatus } from "../src/commands/order.js";
import {
  authorizePayment, challengeIntentId, recordIntent, requestChallenge, submitPayment,
} from "../src/gateway/purchase.js";
import { CliError } from "../src/cli/errors.js";
import { updateOrder } from "../src/store/orders.js";

interface Step {
  name: string;
  ok: boolean;
  detail?: string;
  durationMs: number;
}

/**
 * The §6 budget: one challenge, one paid retry, one grant-read (a challenge
 * and an authorized retry), and reads served by the capability. Those are
 * the only surfaces this CLI uses, so there is one budget.
 */
const CALL_BUDGET = 6;

/** Codes that mean the order's on-chain reputation record is not there yet. */
const NOT_READY = new Set(["DASKI_CONFIRMATION_MISMATCH", "REPUTATION_NOT_READY"]);
const READY_WAIT_MS = 5 * 60_000;
const READY_POLL_MS = 15_000;

async function retryUntilReady<T>(run: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + READY_WAIT_MS;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof CliError) || !NOT_READY.has(error.code) || Date.now() + READY_POLL_MS > deadline) throw error;
      process.stderr.write(`       waiting for the order's reputation record (${error.code})\n`);
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
  }
}

async function main(): Promise<number> {
  const { flags } = parseArgs(process.argv.slice(2));
  const profile = stringFlag(flags, "profile") ?? "sandbox";
  const signerOverride = stringFlag(flags, "signer");
  const cdpAccount = stringFlag(flags, "cdp-account");
  const circleWallet = stringFlag(flags, "circle-wallet");
  /** The signer selection every step shares, so a wallet flag reaches all of them. */
  const selection = { profile, signerOverride, cdpAccount, circleWallet };
  const redactSignatures = boolFlag(flags, "redact-signatures");
  const withConfirm = boolFlag(flags, "confirm");
  const provider = stringFlag(flags, "provider") ?? "8327";
  const outcome = stringFlag(flags, "outcome") ?? "create-mailbox";

  if (process.env.DASKI_CONFORMANCE_SPEND_OK !== "1") {
    process.stderr.write(
      "refusing to run: this suite spends real testnet USDC from the configured " +
      "wallet.\n\nIf that is what you want, set DASKI_CONFORMANCE_SPEND_OK=1 and " +
      "re-run.\n",
    );
    return 2;
  }

  const startedAt = new Date();
  const runDirectory = join(
    process.env.DASKI_CONFORMANCE_DIR ?? "./conformance-runs",
    `${startedAt.toISOString().replace(/[:.]/g, "-")}-${profile}-${signerOverride ?? "profile"}`,
  );
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });

  const calls: GatewayCallLog[] = [];
  const steps: Step[] = [];
  const log = (entry: GatewayCallLog): void => {
    calls.push(redactValue(entry, { signatures: redactSignatures }) as GatewayCallLog);
  };
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const began = Date.now();
    try {
      const value = await run();
      steps.push({ name, ok: true, durationMs: Date.now() - began });
      process.stderr.write(`  ok   ${name}\n`);
      return value;
    } catch (error) {
      const detail = error instanceof PolicyRefusal
        ? `${error.detail.code} (${error.detail.check})`
        : error instanceof Error ? error.message : String(error);
      steps.push({ name, ok: false, detail, durationMs: Date.now() - began });
      process.stderr.write(`  FAIL ${name}: ${detail}\n`);
      throw error;
    }
  };

  process.stderr.write(`conformance: profile=${profile} signer=${signerOverride ?? "(profile default)"}\n`);
  process.stderr.write(`run directory: ${runDirectory}\n\n`);

  let exitCode = 0;
  let orderHandle: string | undefined;
  let firstAttemptAccepted = false;
  /** What the confirmation step proved: a sponsored submission, or a direct call prepared for the wallet's own tool. */
  let confirmation: Record<string, unknown> | null = null;

  try {
    // -- doctor ------------------------------------------------------------
    const report = await step("doctor passes", async () => {
      const doctor = await runDoctor(selection);
      const blocking = doctor.issues.filter((issue) => issue.severity === "blocking");
      if (blocking.length > 0) {
        throw new Error(`blocking issues: ${blocking.map((i) => i.code).join(", ")}`);
      }
      return doctor;
    });

    const context = await createContext({ ...selection, onCall: log });
    try {
      // -- prepare ---------------------------------------------------------
      const request = { address: `conformance-${Date.now()}@sandbox.daski.io` };
      const challenge = await step("prepare: challenge issued", () => requestChallenge({
        client: context.client,
        providerAgentId: provider,
        outcomeId: outcome,
        request,
        payerAddress: context.payerAddress,
      }));
      const amountAtomic = BigInt(challenge.requirement.amount);
      process.stderr.write(`       price ${formatUsdc(amountAtomic)}\n`);

      // -- policy-validate + sign ------------------------------------------
      // The gateway pins the payment identifier in the challenge; the intent
      // recorded here must be that one, or reconciliation cannot find the order.
      const intentId = challengeIntentId(challenge.challenge.extensions);
      recordIntent({
        intentId, profile: context.profileName, providerAgentId: provider,
        outcomeId: outcome, payer: context.payerAddress,
        amount: amountAtomic.toString(), state: "INTENT_RECORDED", request,
      });
      const authorized = await step("policy-validate + recompute + sign", () => authorizePayment({
        policy: context.policy,
        signer: context.signer,
        challenge,
        providerAgentId: provider,
        outcomeId: outcome,
        approvedQuoteAtomic: amountAtomic,
        intentId,
      }));
      updateOrder(intentId, { state: "AUTHORIZED", authorizationNonce: authorized.nonce });

      // -- buy: the first signed attempt must be accepted -------------------
      orderHandle = await step("buy: first signed attempt accepted", async () => {
        const result = await submitPayment({
          client: context.client,
          providerAgentId: provider,
          outcomeId: outcome,
          request,
          submission: authorized.submission,
        });
        const body = GatewayClient.json(result);
        if (result.isError || typeof body?.orderHandle !== "string") {
          throw new Error(
            `the gateway rejected the first signed authorization: ` +
            `${JSON.stringify(body ?? {})}`,
          );
        }
        firstAttemptAccepted = true;
        updateOrder(intentId, { handle: body.orderHandle, state: "SUBMITTED" });
        return body.orderHandle;
      });
      process.stderr.write(`       order ${orderHandle}\n`);
      await context.close();

      // -- reads: one grant-read, then served by the capability ---------------
      await step("status", () => orderStatus({ ...selection, handle: orderHandle!, json: true }));
      await step("artifact", () => orderArtifact({
        ...selection, handle: orderHandle!, json: true,
        output: join(runDirectory, "artifact.bin"),
      }));
      if (withConfirm) {
        // The order's reputation record appears on chain after fulfillment;
        // until then the chain facts do not match and the gateway is not ready.
        await step("confirm delivery", async () => {
          const result = await retryUntilReady(() => orderConfirm({
            ...selection, handle: orderHandle!, json: true, confirmation: "Confirmed",
          }));
          if (result.mode === "direct") {
            // A contract signer ends at the validated call: this CLI never sends
            // a transaction. The call is kept with the run for the wallet's own
            // tool, and this step is preparation evidence only; conformance for
            // a contract wallet also needs the --tx record and an observed --check.
            const kept = join(runDirectory, "direct-call.json");
            writeFileSync(kept, `${JSON.stringify({ orderHandle, callHash: result.callHash, call: result.call, next: result.next }, null, 2)}\n`, { mode: 0o600 });
            confirmation = { mode: "direct", evidence: "prepared-only", callHash: String(result.callHash), call: kept };
            process.stderr.write(
              `       direct call validated (${String(result.callHash)}) and written to ${kept}; PREPARATION ONLY. ` +
              `Submit it with the wallet's tool, then: daski order confirm ${orderHandle} --tx <hash> and --check\n`,
            );
          } else {
            confirmation = { mode: "sponsored", evidence: "submitted", state: String(result.state ?? "") };
          }
          return result;
        });
      }
    } finally {
      await context.close();
    }

    // -- assertions --------------------------------------------------------
    const used = calls.length;
    if (used > CALL_BUDGET) {
      steps.push({
        name: "daski calls within the budget",
        ok: false,
        detail: `used ${used}, budget ${CALL_BUDGET}`,
        durationMs: 0,
      });
      process.stderr.write(`  FAIL call budget: used ${used}, budget ${CALL_BUDGET}\n`);
    } else {
      steps.push({
        name: "daski calls within the budget",
        ok: true,
        detail: `used ${used} of ${CALL_BUDGET}`,
        durationMs: 0,
      });
      process.stderr.write(`  ok   call budget: used ${used} of ${CALL_BUDGET}\n`);
    }
    void report;
  } catch {
    exitCode = 1;
  }

  const failed = steps.filter((entry) => !entry.ok);
  const summary = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    profile,
    signer: signerOverride ?? "(profile default)",
    callBudget: CALL_BUDGET,
    orderHandle: orderHandle ?? null,
    firstAttemptAccepted,
    confirmation,
    gatewayCalls: calls.length,
    steps,
    passed: failed.length === 0 && exitCode === 0,
  };
  writeFileSync(join(runDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(runDirectory, "calls.jsonl"),
    `${calls.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });

  process.stderr.write(`\n${summary.passed ? "PASS" : "FAIL"} — log: ${runDirectory}\n`);
  return summary.passed ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  process.stderr.write(`conformance harness error: ${String(error)}\n`);
  process.exitCode = 1;
});
