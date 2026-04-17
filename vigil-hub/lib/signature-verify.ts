/**
 * ed25519 signature verification for per-agent tamper-evident check results.
 *
 * The agent generates a keypair on first run and sends its raw 32-byte ed25519
 * public key (hex) in the `register` message. The Hub pins that key to the
 * agent record (`Agent.resultSigningPubkey`). Every subsequent agent→Hub
 * message carries a `signature` field containing the hex-encoded ed25519
 * signature over the *canonical JSON form of the message with the `signature`
 * field removed*.
 *
 * Canonicalisation is load-bearing. Both sides MUST produce the exact same
 * bytes: object keys sorted alphabetically at every level, arrays in original
 * order, scalars (strings, numbers, booleans, null) serialised exactly how
 * serde_json / JSON.stringify would. The Rust agent uses a matching helper in
 * `vigil-agent/src/result_signing.rs::canonical_json`.
 *
 * Node's built-in `crypto` supports ed25519 natively via the SPKI DER wrapper;
 * we convert a 32-byte raw hex pubkey to SPKI by prefixing the 12-byte
 * `SubjectPublicKeyInfo` header defined in RFC 8410 §4.
 */

import { createPublicKey, verify as cryptoVerify } from "crypto";

// RFC 8410 §4 SPKI prefix for Ed25519 public keys. 12 bytes:
//   30 2A               SEQUENCE, length 42
//   30 05               SEQUENCE (AlgorithmIdentifier), length 5
//   06 03 2B 65 70      OID 1.3.101.112 (Ed25519)
//   03 21 00            BIT STRING, length 33, 0 unused bits
// …followed by the 32-byte raw key.
const ED25519_SPKI_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/**
 * Wrap a raw 32-byte ed25519 public key into SPKI DER so Node's `createPublicKey`
 * can ingest it.
 */
function rawPubkeyToSpki(rawHex: string): Buffer {
  const raw = Buffer.from(rawHex, "hex");
  if (raw.length !== 32) {
    throw new Error(`ed25519 public key must be 32 bytes, got ${raw.length}`);
  }
  return Buffer.concat([ED25519_SPKI_PREFIX, raw]);
}

/**
 * Verify an ed25519 signature. Returns `true` iff the signature is valid for
 * the given message + public key. Any malformed input returns `false` — the
 * callers at the WS layer must not distinguish "bad input" from "bad sig",
 * both are treated as rejection.
 */
export function verifyEd25519(
  publicKeyHex: string,
  signatureHex: string,
  message: string | Buffer,
): boolean {
  try {
    const sigBytes = Buffer.from(signatureHex, "hex");
    if (sigBytes.length !== 64) return false;
    const spki = rawPubkeyToSpki(publicKeyHex);
    const keyObj = createPublicKey({ key: spki, format: "der", type: "spki" });
    const msgBuf =
      typeof message === "string" ? Buffer.from(message, "utf8") : message;
    // ed25519 does not accept a digest algorithm parameter — `null` tells
    // Node to feed the raw message in, matching ring's behaviour on the
    // agent side.
    return cryptoVerify(null, msgBuf, keyObj, sigBytes);
  } catch {
    return false;
  }
}

/**
 * Canonical JSON: stringify `value` with object keys sorted alphabetically at
 * every level. Arrays retain their order. Must be byte-for-byte identical to
 * the agent's Rust helper (`canonical_json` in result_signing.rs) or
 * signatures will fail to verify.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    // JSON.stringify already handles all finite number edge cases; non-finite
    // becomes "null" to match serde_json's handling of f64::NAN/INF (which
    // serde_json rejects — agents should never emit these).
    if (!Number.isFinite(value)) return "null";
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      // Drop undefined values (serde_json + JSON.stringify both skip them).
      if (obj[k] === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${serialize(obj[k])}`);
    }
    return `{${parts.join(",")}}`;
  }
  // Unknown type — fall through to JSON.stringify as a last resort.
  return JSON.stringify(value);
}

/**
 * Convenience: given a parsed WS message object, strip its `signature` field
 * and return the canonical JSON representation that the agent signed over.
 *
 * Does NOT mutate the input — takes a shallow copy before removing the field.
 */
export function canonicalBodyForSigning(
  msg: Readonly<Record<string, unknown>>,
): string {
  const clone: Record<string, unknown> = { ...msg };
  delete clone.signature;
  return canonicalJson(clone);
}
