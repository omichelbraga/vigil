import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { twoFactor } from "better-auth/plugins";
import { db } from "./db";

export const auth = betterAuth({
  database: prismaAdapter(db, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // 5 minutes
    },
  },
  advanced: {
    cookiePrefix: "vigil",
    generateId: false,
  },
  plugins: [twoFactor()],
  // TODO(oauth-db-runtime): Better Auth initializes at module load time (singleton),
  // so social providers cannot be swapped in dynamically at runtime from DB settings.
  // Current approach: credentials are configured via environment variables
  // (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AZURE_AD_CLIENT_ID, AZURE_AD_CLIENT_SECRET,
  //  AZURE_AD_TENANT_ID) and the server must be restarted after changes.
  //
  // The Settings UI (Settings → OAuth tab) stores credentials and enabled flags in
  // app_config for reference/documentation. The login page reads the enabled flags
  // from /api/settings/oauth to conditionally show the OAuth buttons.
  //
  // To fully wire up DB-based credentials at runtime, you would need to either:
  //   a) Run Better Auth as a dynamic factory (reinitialize on config change), or
  //   b) Use a proxy OAuth handler that reads DB creds per-request before delegating.
  socialProviders: {
    ...(process.env.AZURE_AD_CLIENT_ID && process.env.AZURE_AD_CLIENT_SECRET
      ? {
          microsoft: {
            clientId: process.env.AZURE_AD_CLIENT_ID,
            clientSecret: process.env.AZURE_AD_CLIENT_SECRET,
            tenantId: process.env.AZURE_AD_TENANT_ID || "common",
          },
        }
      : {}),
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {}),
  },
});

export type Session = typeof auth.$Infer.Session;
