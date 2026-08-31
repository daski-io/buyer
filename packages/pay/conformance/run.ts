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
  authorizePayment, newIntentId, recordIntent, requestChallenge, submitPayment,
} from "../src/gateway/purchase.js";
import { updateOrder } from "../src/store/orders.js";

interface Step {
  name: string;
  ok: boolean;
  detail?: string;
  durationMs: number;
}

/**
 * The §6 budget assumes the spec-01 surfaces: one challenge, one paid retry,
 * one grant-read, and reads served by the capability. Where the gateway does
 * not yet expose them, each read costs a challenge plus an authorized retry,
 * so the suite states the tier it ran in rather than quietly failing a budget
 * that does not apply.
 */
const SPEC01_CALL_BUDGET = 6;
const FALLBACK_CALL_BUDGET = 12;

async function main(): Promise<number> {
  const { flags } = parseArgs(process.argv.slice(2));
  const profile = stringFlag(flags, "profile") ?? "sandbox";
  const signerOverride = stringFlag(flags, "signer");
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
  let specTier: "spec-01" | "fallback" = "fallback";

  try {
    // -- doctor ------------------------------------------------------------
    const report = await step("doctor passes", async () => {
      const doctor = await runDoctor({ profile, signerOverride });
      const blocking = doctor.issues.filter((issue) => issue.severity === "blocking");
      if (blocking.length > 0) {
        throw new Error(`blocking issues: ${blocking.map((i) => i.code).join(", ")}`);
      }
      return doctor;
    });

    const context = await createContext({ profile, signerOverride, onCall: log });
    try {
      specTier = await context.client.hasTool("daski_get_payment_challenge") &&
        await context.client.hasTool("daski_get_order_access")
        ? "spec-01" : "fallback";

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
      const intentId = newIntentId();
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

      // -- reads: capability if available, per-action signing otherwise -----
      await step("status", () => orderStatus({ profile, signerOverride, handle: orderHandle!, json: true }));
      await step("artifact", () => orderArtifact({
        profile, signerOverride, handle: orderHandle!, json: true,
        output: join(runDirectory, "artifact.bin"),
      }));
      if (withConfirm) {
        await step("confirm delivery", () => orderConfirm({
          profile, signerOverride, handle: orderHandle!, json: true,
        }));
      }
    } finally {
      await context.close();
    }

    // -- assertions --------------------------------------------------------
    const budget = specTier === "spec-01" ? SPEC01_CALL_BUDGET : FALLBACK_CALL_BUDGET;
    const used = calls.length;
    if (used > budget) {
      steps.push({
        name: `daski calls within the ${specTier} budget`,
        ok: false,
        detail: `used ${used}, budget ${budget}`,
        durationMs: 0,
      });
      process.stderr.write(`  FAIL call budget: used ${used}, budget ${budget} (${specTier})\n`);
    } else {
      steps.push({
        name: `daski calls within the ${specTier} budget`,
        ok: true,
        detail: `used ${used} of ${budget}`,
        durationMs: 0,
      });
      process.stderr.write(`  ok   call budget: used ${used} of ${budget} (${specTier} tier)\n`);
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
    specTier,
    orderHandle: orderHandle ?? null,
    firstAttemptAccepted,
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
