import { randomBytes } from "node:crypto";
import argon2 from "argon2";

const TOKEN_PREFIX = "vgl_";
const TOKEN_RANDOM_BYTES = 32;

export interface GeneratedToken {
  plaintext: string;
  displayPrefix: string;
}

/**
 * Generate a new API token.
 * Returns:
 *   plaintext — "vgl_<base64url>" (48+ chars). Only returned once at creation.
 *   displayPrefix — first 8 chars of the plaintext, for UI display after the fact.
 */
export function generateApiToken(): GeneratedToken {
  const raw = randomBytes(TOKEN_RANDOM_BYTES).toString("base64url");
  const plaintext = `${TOKEN_PREFIX}${raw}`;
  return { plaintext, displayPrefix: plaintext.slice(0, 8) };
}

export async function hashApiToken(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, { type: argon2.argon2id });
}

export async function verifyApiToken(
  hash: string,
  plaintext: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}

export const VALID_SCOPES = ["read", "write", "admin"] as const;
export type ApiScope = (typeof VALID_SCOPES)[number];

export function sanitizeScopes(input: unknown): ApiScope[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<ApiScope>();
  for (const item of input) {
    if (typeof item === "string" && (VALID_SCOPES as readonly string[]).includes(item)) {
      seen.add(item as ApiScope);
    }
  }
  return Array.from(seen);
}

export const EXPIRY_PRESETS: Record<string, number | null> = {
  never: null,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
  "1y": 365 * 24 * 60 * 60 * 1000,
};

export function resolveExpiry(preset: string | null | undefined): Date | null {
  if (!preset || preset === "never") return null;
  const ms = EXPIRY_PRESETS[preset];
  if (ms == null) return null;
  return new Date(Date.now() + ms);
}
