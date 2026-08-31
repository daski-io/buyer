/**
 * A last line of defence on the way out.
 *
 * Keys are never *supposed* to reach output — no code path passes one to a
 * printer — but "supposed to" is not a guarantee, and a leaked key is
 * unrecoverable. Everything the CLI prints goes through here first.
 */

/** 0x-prefixed 32-byte secrets, and bare 64-hex-char runs. */
const PRIVATE_KEY_PATTERN = /\b(0x)?[0-9a-fA-F]{64}\b/g;
/** BIP-39 style phrases: twelve or more lowercase words in a row. */
const MNEMONIC_PATTERN = /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g;

const KEYLIKE_FIELDS = new Set([
  "privatekey", "private_key", "secret", "mnemonic", "seed", "passphrase",
  "password", "keystore", "daski_payer_private_key",
]);

/**
 * Redacts key-shaped strings. 32-byte hex is also the shape of a legitimate
 * hash, so a bare hex run is only redacted when its field name says it is a
 * secret; a `0x`-prefixed 64-hex string in free text is always redacted
 * because that is the private-key form users actually paste.
 */
export interface RedactOptions {
  /** Also blank signatures. Optional for run logs; keys are never optional. */
  signatures?: boolean;
  /** Internal: the field name the current value was found under. */
  fieldName?: string | undefined;
}

export function redactValue(value: unknown, options: RedactOptions = {}): unknown {
  const { fieldName } = options;
  if (typeof value === "string") {
    if (fieldName && KEYLIKE_FIELDS.has(fieldName.toLowerCase())) return "[redacted]";
    if (options.signatures && fieldName?.toLowerCase() === "signature") return "[redacted]";
    return value
      .replace(PRIVATE_KEY_PATTERN, (match) => (match.startsWith("0x") ? "[redacted]" : match))
      .replace(MNEMONIC_PATTERN, "[redacted]");
  }
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
