/**
 * Auth setup — runs once before the test suite.
 *
 * Authenticates directly via the Better Auth HTTP API.  The API sets
 * Set-Cookie headers; we copy those cookies into the browser context so that
 * every subsequent test page.goto() is already authenticated.
 *
 * Rate-limit awareness:
 *   Better Auth enforces a rate limit of 3 sign-in attempts per 10-second
 *   sliding window per user.  To minimise sign-in calls:
 *   1. Fast path — if admin.json already holds a valid session (probed via
 *      /api/agents), skip the sign-in entirely.
 *   2. Slow path — when the session is missing or expired, retry the sign-in
 *      with exponential back-off to gracefully handle rate-limiting (429).
 */
import { test as setup, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

const ADMIN_EMAIL = "mguimaraes@san-marcos.net";
const ADMIN_PASSWORD = "GeM@4744949";
const AUTH_FILE = path.join(__dirname, "../.auth/admin.json");

async function signInWithRetry(
  page: import("@playwright/test").Page,
  maxAttempts = 5
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await page.request.post("/api/auth/sign-in/email", {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
      },
    });

    if (response.status() === 200) {
      const body = await response.json();
      expect(body).toHaveProperty("token");
      return;
    }

    if (response.status() === 429) {
      if (attempt < maxAttempts) {
        // Wait for the rate-limit window to pass (Better Auth uses 10s window)
        const retryAfterHeader = response.headers()["x-retry-after"];
        const waitSeconds = retryAfterHeader
          ? parseInt(retryAfterHeader, 10) + 1
          : 11;
        await new Promise((r) => setTimeout(r, waitSeconds * 1000));
        continue;
      }
    }

    // Unexpected status — fail immediately
    throw new Error(
      `Sign-in failed with status ${response.status()}: ${await response.text()}`
    );
  }

  throw new Error(`Sign-in failed after ${maxAttempts} attempts`);
}

setup("authenticate as admin", async ({ page }) => {
  // ------------------------------------------------------------------
  // Fast path: reuse existing storage state if the session is still live
  // ------------------------------------------------------------------
  if (fs.existsSync(AUTH_FILE)) {
    const stored = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
    await page.context().addCookies(stored.cookies ?? []);

    const probe = await page.request.get("/api/agents", {
      headers: { Origin: "http://localhost:3000" },
    });

    if (probe.status() === 200) {
      // Session still valid — skip sign-in entirely
      return;
    }

    await page.context().clearCookies();
  }

  // ------------------------------------------------------------------
  // Slow path: sign in fresh (with rate-limit retry)
  // ------------------------------------------------------------------
  await signInWithRetry(page);

  await page.goto("/dashboard");
  await page.waitForURL("**/dashboard", { timeout: 15_000 });

  await page.context().storageState({ path: AUTH_FILE });
});
