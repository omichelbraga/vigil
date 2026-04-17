/**
 * Generic redaction helpers for diagnostics bundles and log exports.
 *
 * Strategy: redact by key name, not value. We don't try to fingerprint secrets
 * by shape — we just assume any field whose name looks like a secret IS a
 * secret and drop its value. This errs on the side of over-redacting, which is
 * the correct bias for a bundle operators hand to vendors or paste into chat.
 */

/**
 * Case-insensitive patterns matched against key names. A key matches if any
 * pattern is found as a substring (case-insensitive). This also catches the
 * wildcard forms requested in the spec: `*_SECRET`, `*_TOKEN`, `*_KEY`,
 * `*_PASSWORD`, `AUTH`, `PRIVATE`, `COOKIE`.
 *
 * Exported so tests can assert the list without re-defining it.
 */
export const REDACT_KEY_PATTERNS: readonly string[] = [
  "secret",
  "token",
  "key",
  "password",
  "auth",
  "private",
  "cookie",
  "passphrase",
  "credential",
  "client_secret",
  "clientsecret",
  "apikey",
  "api_key",
  "webhook", // URLs often contain per-tenant secrets
  "session",
  "database_url", // contains pg user:pass@host
  "pg_url",
  "mongo_url",
  "redis_url",
  "dsn",
  "sentry",
  "dns", // DNS tokens for DNS-based challenges
] as const;

const REDACT_VALUE = "<redacted>";

/**
 * Regex that spots `scheme://user:password@host` credentials in a string.
 * Case-insensitive; only flags when a `:` appears between scheme:// and the
 * `@`, i.e. an actual userinfo pair. Used to scrub env values whose *key*
 * wouldn't have matched (e.g. some bespoke connection string).
 */
const URL_USERINFO_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@/i;

/**
 * Hosts whose webhook URLs embed a per-tenant secret in the path. Any string
 * value pointing at these hosts is a secret by construction and MUST be
 * redacted regardless of key name.
 */
const WEBHOOK_HOST_PATTERNS: readonly RegExp[] = [
  /hooks\.slack\.com\//i,
  /discord(?:app)?\.com\/api\/webhooks\//i,
  /outlook\.office\.com\/webhook\//i,
  /webhook\.office\.com\//i,
  /api\.telegram\.org\/bot/i,
  /events\.pagerduty\.com\//i,
] as const;

/**
 * True if a string looks like a webhook URL that embeds a secret in its path.
 * Pure — safe to call in the redact worker.
 */
export function isWebhookSecretUrl(value: string): boolean {
  for (const re of WEBHOOK_HOST_PATTERNS) {
    if (re.test(value)) return true;
  }
  return false;
}

/** True if a key name matches any redact pattern (case-insensitive). */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  for (const pat of REDACT_KEY_PATTERNS) {
    if (lower.includes(pat)) return true;
  }
  return false;
}

/**
 * Return a new object where every env var whose name matches a redact pattern
 * has its value replaced with `<redacted>`. Keys themselves are preserved so
 * the operator can see what the hub knows about.
 */
export function redactEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (isSensitiveKey(k)) {
      out[k] = REDACT_VALUE;
    } else if (URL_USERINFO_RE.test(v)) {
      // Connection string with embedded credentials — scheme://user:pass@host.
      // Preserve scheme+host for operators, redact the userinfo segment.
      out[k] = v.replace(URL_USERINFO_RE, (match) => {
        const schemeIdx = match.indexOf("://");
        const scheme = match.slice(0, schemeIdx + 3);
        return `${scheme}<redacted>@`;
      });
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Deep walk a JSON-like value. For every string value at a key that matches a
 * redact pattern, replace with `<redacted>`. Arrays/objects are recreated
 * immutably — input is never mutated. Non-string sensitive values (e.g. a
 * nested object stored under `"config"`) are walked further so we redact
 * leaves too.
 *
 * Note: Buffers, Dates, and other non-plain objects are returned as-is — we
 * never hand-walk into class instances because their internals are opaque.
 */
export function redactJson(input: unknown): unknown {
  return redactWalk(input, false);
}

/**
 * Typed variant for DB rows. Identical behaviour to `redactJson` but preserves
 * the row's type so callers can keep their Prisma type narrowing.
 */
export function redactDbBlob<T extends Record<string, unknown>>(row: T): T {
  return redactWalk(row, false) as T;
}

/**
 * Internal worker. `parentSensitive` tells us that the enclosing key matched a
 * redact pattern, so every primitive *inside* this subtree should be dropped
 * regardless of its local key name. This catches the common "config: { url,
 * token }" shape on AlertChannel rows.
 */
function redactWalk(value: unknown, parentSensitive: boolean): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (parentSensitive) return REDACT_VALUE;
    if (isWebhookSecretUrl(value)) return REDACT_VALUE;
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return parentSensitive ? REDACT_VALUE : value;
  }

  if (Array.isArray(value)) {
    return value.map((v) => redactWalk(v, parentSensitive));
  }

  if (typeof value === "object") {
    // Only walk plain objects — leave Date/Buffer/etc. untouched.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return value;
    }
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      const sensitive = parentSensitive || isSensitiveKey(k);
      if (sensitive && (v === null || typeof v !== "object")) {
        out[k] = REDACT_VALUE;
      } else {
        out[k] = redactWalk(v, sensitive);
      }
    }
    return out;
  }

  return value;
}
