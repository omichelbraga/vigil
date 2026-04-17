import { createHash, createPublicKey, verify as cryptoVerify } from "crypto";

/**
 * Release-signing helpers (P6.3).
 *
 * A release is signed by computing ed25519 signature over the UTF-8 lowercase
 * hex of the binary's SHA-256. The signature is 64 bytes -> 128 hex chars.
 * The signing pubkey is a raw 32-byte ed25519 public key, encoded as 64 hex.
 * The fingerprint is the first 8 chars of sha256(pubkey).
 */

const ED25519_PUBKEY_BYTES = 32;
const ED25519_SIG_BYTES = 64;

/**
 * Parse a hex string strictly. Returns null when input isn't hex or length
 * doesn't match expected bytes.
 */
function parseHex(input: string, expectedBytes: number): Buffer | null {
  if (typeof input !== "string") return null;
  if (input.length !== expectedBytes * 2) return null;
  if (!/^[0-9a-fA-F]+$/.test(input)) return null;
  return Buffer.from(input, "hex");
}

/**
 * Convert a raw 32-byte ed25519 pubkey into a KeyObject using the SubjectPublicKeyInfo
 * DER wrapper (prefix: `302a300506032b6570032100` + raw key).
 */
function rawEd25519PubkeyToKeyObject(raw: Buffer): ReturnType<typeof createPublicKey> | null {
  if (raw.length !== ED25519_PUBKEY_BYTES) return null;
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const spki = Buffer.concat([spkiPrefix, raw]);
  try {
    return createPublicKey({ key: spki, format: "der", type: "spki" });
  } catch {
    return null;
  }
}

/**
 * Verify an ed25519 signature over a hex string payload (sha256 of the release
 * binary). All hex inputs are case-insensitive.
 */
export function verifyReleaseSignature(params: {
  sha256Hex: string;
  signatureHex: string;
  pubkeyHex: string;
}): boolean {
  const sigBuf = parseHex(params.signatureHex, ED25519_SIG_BYTES);
  if (!sigBuf) return false;

  const pubkeyRaw = parseHex(params.pubkeyHex, ED25519_PUBKEY_BYTES);
  if (!pubkeyRaw) return false;
  const keyObject = rawEd25519PubkeyToKeyObject(pubkeyRaw);
  if (!keyObject) return false;

  // Signed payload is the lowercase hex of sha256(binary).
  const payload = Buffer.from(params.sha256Hex.toLowerCase(), "utf8");

  try {
    return cryptoVerify(null, payload, keyObject, sigBuf);
  } catch {
    return false;
  }
}

/**
 * 8-char hex fingerprint of a raw 32-byte ed25519 pubkey (hex).
 */
export function pubkeyFingerprint(pubkeyHex: string): string | null {
  const raw = parseHex(pubkeyHex, ED25519_PUBKEY_BYTES);
  if (!raw) return null;
  return createHash("sha256").update(raw).digest("hex").slice(0, 8);
}

/**
 * Admin-configured signing pubkey from env. Used to display "Signing key: <fp>"
 * in the /admin/agent-releases header. Returns null when unset or invalid.
 */
export function configuredSigningPubkey(): {
  pubkeyHex: string;
  fingerprint: string;
} | null {
  const raw = process.env.VIGIL_UPDATE_PUBKEY;
  if (!raw || raw.length === 0) return null;
  const fp = pubkeyFingerprint(raw);
  if (!fp) return null;
  return { pubkeyHex: raw, fingerprint: fp };
}
