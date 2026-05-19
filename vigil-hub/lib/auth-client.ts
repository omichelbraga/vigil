import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";

// Use the browser's actual origin at runtime. NEXT_PUBLIC_* env vars are
// inlined at build time, so the previous fallback to NEXT_PUBLIC_APP_URL ||
// "http://localhost:3000" baked the dev URL into the client bundle and
// every prod deploy hit it (CSP then blocks the request as a cross-origin
// fetch). window.location.origin adapts to whatever URL the user is on,
// including https://vigil.<your-domain> behind a reverse proxy.
const baseURL =
  typeof window !== "undefined"
    ? window.location.origin
    : process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export const authClient = createAuthClient({
  baseURL,
  plugins: [twoFactorClient()],
});

export const {
  signIn,
  signUp,
  signOut,
  useSession,
  twoFactor,
} = authClient;
