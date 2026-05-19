import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = [
  "/api/health",
  "/api/auth",
  "/api/update",
  "/api/enroll",
  "/api/setup",          // first-run setup endpoints (self-checks no users exist)
  "/api/settings/test",  // self-checks: setup mode OR admin session
  "/api/settings/oauth", // public — only exposes enabled flags, no secrets
  "/login",
  "/setup",
  "/_next",
  "/favicon.ico",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname.startsWith(p));
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const response = NextResponse.next();

  // Security headers on all responses
  response.headers.set(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload"
  );
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );

  // Next.js 16 ships inline hydration bootstrap scripts. Tightening to
  // script-src 'self' requires nonce-based CSP, which Next.js App Router
  // doesn't wire out of the box — left as a follow-up (see docs/SECURITY.md).
  // Until then: keep 'unsafe-inline'/'unsafe-eval' on scripts, but preserve
  // the other defences (frame-ancestors, form-action, base-uri, no object-src).
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' wss: ws:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
  response.headers.set("Content-Security-Policy", csp);

  // Skip auth for public paths
  if (isPublicPath(pathname)) {
    return response;
  }

  // Check for session cookie (Better Auth sets vigil.session_token, possibly signed).
  // NOTE: presence-only check — route handlers still run getSession() which hits
  // the DB and rejects forged cookies. Middleware is defence-in-depth, not auth.
  const sessionCookie =
    request.cookies.get("vigil.session_token") ||
    request.cookies.get("better-auth.session_token") ||
    request.cookies.get("__Secure-vigil.session_token") ||
    request.cookies.get("__Secure-better-auth.session_token");

  const hasSession = !!sessionCookie?.value;

  // Protect dashboard and API routes. Agents never call these paths over HTTP
  // (they use the /ws/agent WebSocket upgrade, which is handled separately),
  // so no Bearer-token bypass is exposed here.
  if (pathname.startsWith("/dashboard") || pathname.startsWith("/api")) {
    if (!hasSession) {
      if (pathname.startsWith("/api")) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  // Root redirect. With a session: jump to /dashboard. Without one: let the
  // home page render so its server component can choose between /setup
  // (first-run, userCount===0) and /login (post-setup). Redirecting to
  // /login unconditionally here would short-circuit the first-run setup
  // wizard, leaving fresh deployments stuck on the login screen.
  if (pathname === "/") {
    if (sessionCookie?.value) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
    return response;
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|public/).*)"],
};
