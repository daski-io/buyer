/**
 * `@daski/x402-scheme` — the composite Exact-EVM client plugin, and the
 * policy validator both this package and `@daski/pay` sign through.
 *
 * The rule that shapes the whole surface: the server proposes, this package
 * validates against its own expectations and recomputes, the wallet signs,
 * and the gateway never sees the key. There is no exported "just sign this"
 * function, and there never will be.
 */
export {
  parseOrderBinding,
  type OrderBinding,
  type OrderBindingV1,
  type OrderBindingV2,
} from "./binding.js";

export { canonicalHash, canonicalJson } from "./canonical.js";

export {
  AUTHORIZATION_FIELDS,
  isClosedTransferWithAuthorizationTypes,
  TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  transferWithAuthorizationTypedData,
  type Eip712Domain,
  type TransferAuthorization,
  type TypedDataRequest,
} from "./eip712.js";

export {
  PolicyRefusal,
  refuse,
  type PolicyCheck,
  type PolicyRefusalDetail,
} from "./errors.js";

export {
  DASKI_ORDER_BINDING,
  DASKI_SIGN_REQUEST,
  issuedPaymentIdentifier,
  PAYMENT_IDENTIFIER,
  PAYMENT_IDENTIFIER_PATTERN,
  paymentEchoExtensions,
  withPaymentIdentifier,
} from "./extensions.js";

export {
  LIFECYCLE_CLOCK_SKEW_SECONDS,
  MAX_LIFECYCLE_LIFETIME_SECONDS,
  ORDER_ACTION_TYPES,
  orderActionResourceUri,
  orderActionTypedData,
  validateOrderActionChallenge,
  validateWalletActionChallenge,
  WALLET_ACTION_TYPES,
  walletActionTypedData,
  type OrderAction,
  type OrderActionAuthorization,
  type OrderActionChallenge,
  type OrderActionExpectations,
  type WalletActionChallenge,
  type WalletActionExpectations,
} from "./lifecycle.js";

export {
  bindingFromExtensions,
  DEFAULT_MAX_AUTHORIZATION_LIFETIME_SECONDS,
  DEFAULT_MAX_BACKDATE_SECONDS,
  DEFAULT_MIN_AUTHORIZATION_LIFETIME_SECONDS,
  formatUsdc,
  parseUsdcToAtomic,
  USDC_DECIMALS,
  validatePurchaseAuthorization,
  type PolicyConfig,
  type PurchaseExpectations,
  type SessionLedger,
  type SplitterEvidence,
  type SplitterResolver,
  type ValidatedPurchase,
} from "./policy.js";

export {
  deriveBindingNonce,
  RECIPE_NONCE_DOMAIN_V1,
  RECIPE_NONCE_DOMAIN_V2,
  recipeNonce,
  recipeNonceV2,
  type RecipeNonceV1Input,
  type RecipeNonceV2Input,
  type RecipePaymentFacts,
} from "./recipe.js";

export { registerDaskiExactEvmScheme, type RegisterOptions, type X402ClientLike } from "./register.js";

export {
  DaskiExactEvmScheme,
  type DaskiExactEvmSchemeOptions,
  type PaymentPayloadContextLike,
  type PaymentPayloadResultLike,
  type PaymentRequirementsLike,
  type PurchaseContextResolver,
  type SchemeNetworkClientLike,
} from "./scheme.js";

export { parseSignRequest, proposedNonce, type ParsedSignRequest } from "./signRequest.js";

export {
  toClientEvmSigner,
  type SignerAdapter,
  type SignerDescription,
} from "./signer.js";
