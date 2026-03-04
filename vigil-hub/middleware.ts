import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = [
  "/api/health",
  "/api/auth",
  "/api/update",
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

  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    "connect-src 'self' wss: ws:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
  response.headers.set("Content-Security-Policy", csp);

  // Skip auth for public paths
  if (isPublicPath(pathname)) {
    return response;
  }

  // Check for session cookie (Better Auth uses vigil.session_token)
  const sessionCookie =
    request.cookies.get("vigil.session_token") ||
    request.cookies.get("better-auth.session_token");

  // Protect dashboard and API routes
  if (pathname.startsWith("/dashboard") || pathname.startsWith("/api")) {
    if (!sessionCookie?.value) {
      if (pathname.startsWith("/api")) {
        // For API routes, also check Bearer token (agent auth)
        const authHeader = request.headers.get("authorization") || "";
        if (authHeader.startsWith("Bearer ")) {
          return response; // Let the API route handler verify the token
        }
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      // Redirect to login for dashboard pages
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  // Root redirect to dashboard if authenticated, login if not
  if (pathname === "/") {
    if (sessionCookie?.value) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|public/).*)"],
};
