/**
 * A last line of defence on the way out.
 *
 * Keys are never *supposed* to reach output — no code path passes one to a
 * printer — but "supposed to" is not a guarantee, and a leaked key is
 * unrecoverable. Everything the CLI prints goes through here first.
 *
 * What this deliberately does **not** do is redact by hex shape. A 32-byte
 * private key and a 32-byte hash are the same shape, and this CLI's whole job
 * involves printing hashes: authorization nonces, request hashes, order keys.
 * Blanking them all would corrupt the tool's own output — an operator could no
 * longer check the nonce their wallet signed — while an attacker who can
 * already get a key into a printed field can trivially reshape it.
 *
 * So the signals used here are the ones that actually discriminate: the field
 * name a value arrived under, and the unmistakable shape of a seed phrase.
 */

/** BIP-39 style phrases: twelve or more lowercase words in a row. */
const MNEMONIC_PATTERN = /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g;

/**
 * Field names whose contents are secret whatever they look like.
 *
 * Kept narrow on purpose. `authorization` and `token` are *not* here: in this
 * domain an "authorization" is the EIP-3009 transfer authorization that
 * `daski sign-payment` exists to print, and a "token" is an ERC-20 contract
 * address. Redacting a field because its name sounds sensitive elsewhere
 * would blank the tool's own output while protecting nothing.
 */
const KEYLIKE_FIELDS = new Set([
  "privatekey", "private_key", "privkey", "secret", "secretkey", "secret_key",
  "mnemonic", "seed", "seedphrase", "seed_phrase", "passphrase", "password",
  "keystore", "keymaterial", "key_material", "daski_payer_private_key",
  "apikey", "api_key",
]);

export interface RedactOptions {
  /** Also blank signatures. Optional for run logs; keys are never optional. */
  signatures?: boolean;
  /** Internal: the field name the current value was found under. */
  fieldName?: string | undefined;
}

export function redactValue(value: unknown, options: RedactOptions = {}): unknown {
  const { fieldName } = options;
  if (fieldName && KEYLIKE_FIELDS.has(fieldName.toLowerCase())) return "[redacted]";
  if (options.signatures && fieldName?.toLowerCase() === "signature") return "[redacted]";

  if (typeof value === "string") return value.replace(MNEMONIC_PATTERN, "[redacted]");
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, { ...options, fieldName: undefined }));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, redactValue(item, { ...options, fieldName: key })]),
    );
  }
  return value;
}

export function redactText(text: string): string {
  return String(redactValue(text));
}
