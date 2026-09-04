import { canonicalHash, formatUsdc, type OrderBinding } from "@daski/x402-scheme";
import { getAddress } from "viem";
import { atomicUsdc } from "../config.js";
import { CliError } from "../cli/errors.js";
import { confirm, isInteractive } from "../cli/prompt.js";
import { note } from "../cli/output.js";
import type { PaymentRequirement } from "../gateway/client.js";
import { isUnspent, listOrders } from "../store/orders.js";

/** Approval survives quote expiry only while all purchase terms stay the same. */
export function purchaseApproval(args: {
  gatewayUrl: string; payer: string; providerAgentId: string; outcomeId: string;
  requirement: PaymentRequirement; binding: OrderBinding;
  purchaseNumber?: number;
}) {
  const binding = args.binding;
  const terms = {
    gateway: args.gatewayUrl.replace(/\/$/, ""), payer: getAddress(args.payer),
    providerAgentId: args.providerAgentId, outcomeId: args.outcomeId,
    network: args.requirement.network, token: getAddress(args.requirement.asset),
    payTo: getAddress(args.requirement.payTo), amount: BigInt(args.requirement.amount).toString(),
    requestHash: binding.canonicalRequestHash,
    listing: binding.version === 2 ? binding.runtimeCommitmentHash : binding.listingManifestHash,
    providerTerms: binding.version === 2 ? binding.providerIntentHash : binding.providerOfferHash,
  };
  const termsHash = canonicalHash(terms);
  const purchaseNumber = args.purchaseNumber ?? 1;
  return { id: canonicalHash({ termsHash, purchaseNumber }), termsHash, purchaseNumber, ...terms };
}

/** A consumed approval cannot authorize another purchase with identical terms. */
export function nextPurchaseApproval(args: Parameters<typeof purchaseApproval>[0], profile: string) {
  const first = purchaseApproval(args);
  const prior = listOrders(profile).filter((order) => order.approvalTermsHash === first.termsHash && !isUnspent(order));
  const pending = prior.find((order) => ["AUTHORIZED", "SUBMITTED", "PENDING_RECONCILIATION"].includes(order.state));
  if (pending) throw new CliError({ code: "DASKI_PAYMENT_PENDING_RECONCILIATION",
    message: "This purchase already has an authorized or pending order.",
    remediation: `Continue with daski order reconcile ${pending.intentId}.`,
    details: { intentId: pending.intentId, orderHandle: pending.handle ?? null } });
  return purchaseApproval({ ...args, purchaseNumber: prior.length + 1 });
}

export async function approvePurchase(args: {
  approval: ReturnType<typeof purchaseApproval>; approved?: string | undefined;
  threshold: string; json: boolean; summary?: unknown;
}): Promise<void> {
  if (args.approved !== undefined) {
    if (args.approved === args.approval.id) return;
    throw new CliError({ code: "DASKI_QUOTE_CHANGED",
      message: "The quote or purchase differs from the approved one.",
      remediation: "Show the new quote to the user, then pass its approval.id with --approve.",
      details: { approval: args.approval, approvalSummary: args.summary }, exitCode: 2 });
  }
  if (BigInt(args.approval.amount) <= atomicUsdc(args.threshold)) return;
  if (args.json || !isInteractive()) {
    throw new CliError({ code: "DASKI_HUMAN_APPROVAL_REQUIRED",
      message: `Approve this purchase for ${formatUsdc(BigInt(args.approval.amount))}.`,
      remediation: "Show the quote to the user. After approval, repeat the command with --approve <approval.id>.",
      details: { approval: args.approval, approvalSummary: args.summary }, exitCode: 2 });
  }
  note(JSON.stringify(args.summary ?? args.approval, null, 2));
  if (!await confirm(`Pay ${formatUsdc(BigInt(args.approval.amount))} on ${args.approval.network}?`)) {
    throw new CliError({ code: "DASKI_PURCHASE_DECLINED", message: "The purchase was declined.",
      remediation: "Run the command again when ready.", exitCode: 2 });
  }
}
