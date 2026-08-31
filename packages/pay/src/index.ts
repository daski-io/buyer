/**
 * `@daski/pay` as a library.
 *
 * The CLI is the product; this surface exists so a host application can reuse
 * the same validated flows without shelling out. Everything exported here
 * still signs only through the §4 validator.
 */
export { runBuy, type BuyOptions } from "./commands/buy.js";
export { runDoctor, type DoctorIssue, type DoctorOptions, type DoctorReport } from "./commands/doctor.js";
export {
  orderArtifact, orderCancel, orderConfirm, orderInput, orderStatus,
  type OrderArtifactOptions, type OrderInputOptions, type OrderOptions,
} from "./commands/order.js";
export { runSignPayment, type SignPaymentOptions } from "./commands/signPayment.js";
export { createWallet, walletAddress, walletBalance, type WalletOptions } from "./commands/wallet.js";

export { CliError, type CliErrorOptions } from "./cli/errors.js";
export { redactText, redactValue } from "./cli/redact.js";

export {
  applyCapOverrides, atomicUsdc, ensureConfig, loadConfig, permissionWarnings,
  type DaskiConfig, type LoadedConfig, type ProfileConfig, type SignerKind,
} from "./config.js";
export { createContext, type CommandContext, type ContextOptions } from "./context.js";

export { Catalog, CATALOG_TTL_SECONDS, type OutcomeSummary } from "./gateway/catalog.js";
export {
  GatewayClient, readiness,
  type GatewayCallLog, type PaymentChallenge, type PaymentRequirement, type PaymentSubmission,
} from "./gateway/client.js";
export { callAuthorizedLifecycleTool, callWalletQuery } from "./gateway/lifecycle.js";
export {
  authorizePayment, listPayerOrders, newIntentId, reconcileAmbiguousPurchase,
  recordIntent, requestChallenge, submitPayment,
  type AuthorizedPayment, type ChallengeResult, type ReconcileOutcome,
} from "./gateway/purchase.js";

export { createSigner, type SignerSelection } from "./signers/index.js";
export {
  activeReadCapability, authorizedTotalAtomic, findByIntent, findOrder,
  listOrders, updateOrder, upsertOrder, type OrderRecord, type OrderState,
} from "./store/orders.js";
export { hasKey, locateKey, type KeyLocation, type KeySource } from "./store/keystore.js";
export { CLI_VERSION } from "./version.js";
