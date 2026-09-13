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
  orderArtifact, orderCancel, orderConfirm, orderImport, orderInput, orderStatus, orderReconcile,
  type OrderArtifactOptions, type OrderImportOptions, type OrderInputOptions, type OrderOptions,
} from "./commands/order.js";
export {
  selectConfirmationMode, validateConfirmationPreparation, validateDirectCall,
  type ConfirmationFacts, type ConfirmationMode, type ConfirmationOptions, type DirectCall,
} from "./commands/confirmation.js";
export { runSignPayment, type SignPaymentOptions } from "./commands/signPayment.js";
export { createWallet, walletAddress, walletBalance, type WalletOptions } from "./commands/wallet.js";

export { CliError, type CliErrorOptions } from "./cli/errors.js";
export { redactText, redactValue } from "./cli/redact.js";

export {
  applyCapOverrides, atomicUsdc, configureBudgets, ensureConfig, loadConfig, permissionWarnings,
  type DaskiConfig, type LoadedConfig, type ProfileConfig, type SignerKind,
} from "./config.js";
export { createContext, type CommandContext, type ContextOptions, type OrderBinding } from "./context.js";
export {
  detectLegacyKeyringEntry, keyBackendFor, resolveHost,
  type HostClass, type HostEnvironment, type KeyBackend, type KeyDurability,
} from "./host.js";
export { createChainReader, finalityTagFor, type ChainReader, type FinalityTag } from "./chain/reader.js";

export { Catalog, CATALOG_TTL_SECONDS, type OutcomeSummary } from "./gateway/catalog.js";
export {
  GatewayClient, readiness,
  type GatewayCallLog, type PaymentChallenge, type PaymentRequirement, type PaymentSubmission,
} from "./gateway/client.js";
export { callAuthorizedLifecycleTool, callWalletQuery } from "./gateway/lifecycle.js";
export {
  parseGatewayMetadata, pinnedBuyerCli, readGatewayMetadata,
  type GatewayMetadata, type PinnedBuyerCli,
} from "./gateway/metadata.js";
export {
  authorizePayment, listPayerOrders, localOrderState, readPayerOrderRows, readSettlement, reconcileByIdentifier,
  recordIntent, requestChallenge, submitPayment,
  type AuthorizedPayment, type ChallengeResult, type PayerOrderRow, type SettlementReading,
} from "./gateway/purchase.js";

export { createSigner, type SignerSelection } from "./signers/index.js";
export { createCircleAgentSigner, type CircleAgentSignerOptions } from "./signers/circleAgent.js";
export { assertContractSignerUsable, checkDeployment, type Deployment } from "./signers/contract.js";
export {
  runContractSignerSelfTest, runEoaSignerSelfTest, runSignerSelfTest, selfTestVector,
  type SignerSelfTestResult,
} from "./signers/selfTest.js";
export {
  activeReadCapability, authorizedTotalAtomic, findByIntent, findOrder,
  listOrders, updateOrder, upsertOrder,
  type ConfirmationTxRecord, type ConfirmationTxState, type OrderRecord, type OrderState,
} from "./store/orders.js";
export {
  hasKey, locateKey, type KeyLocation, type KeySource, type KeyStoreSelection,
} from "./store/keystore.js";
export { CLI_VERSION } from "./version.js";
