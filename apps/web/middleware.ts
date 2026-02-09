import { NextResponse, type NextRequest } from "next/server";

const APP_BASE = process.env.NEXT_PUBLIC_APP_BASE;
const WEB_BASE = process.env.NEXT_PUBLIC_WEB_BASE;
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "https://api.proovra.com";

function buildCsp(nonce: string, relaxed: boolean) {
  const base = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "img-src 'self' data: https:",
    "font-src 'self' data: https:",
    `connect-src 'self' ${API_BASE} https://accounts.google.com https://appleid.apple.com https://appleid.cdn-apple.com`,
    "frame-src 'self' https://accounts.google.com https://appleid.apple.com",
    "form-action 'self' https://appleid.apple.com"
  ];

  if (relaxed) {
    base.push(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://accounts.google.com https://appleid.cdn-apple.com",
      "style-src 'self' 'unsafe-inline'"
    );
  } else {
    base.push(
      `script-src 'self' 'nonce-${nonce}' https://accounts.google.com https://appleid.cdn-apple.com`,
      `style-src 'self' 'nonce-${nonce}' 'unsafe-inline'`
    );
  }

  return base.join("; ");
}

function applySecurityHeaders(response: NextResponse, nonce: string, relaxed: boolean) {
  const csp = buildCsp(nonce, relaxed);
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set("Permissions-Policy", "geolocation=(self)");
  response.headers.set("x-nonce", nonce);
}

function nextWithNonce(req: NextRequest, nonce: string) {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  return NextResponse.next({
    request: {
      headers: requestHeaders
    }
  });
}

function normalizeBaseUrl(base: string | undefined) {
  if (!base) return null;
  try {
    return new URL(base).toString();
  } catch {
    try {
      return new URL(`https://${base}`).toString();
    } catch {
      return null;
    }
  }
}

function getHost(baseUrl: string | null) {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

export function middleware(req: NextRequest) {
  try {
    const isProd = process.env.NODE_ENV === "production";
    const relaxed = process.env.CSP_RELAXED === "true";
    const nonce = btoa(crypto.randomUUID());
    const logMode = relaxed ? "relaxed" : "strict";
    if (isProd) {
      console.info(`[csp] mode=${logMode} path=${req.nextUrl.pathname}`);
    }

    const host = req.headers.get("host");
    if (!host || host.includes("localhost") || host.includes("127.0.0.1")) {
      const res = nextWithNonce(req, nonce);
      if (isProd) applySecurityHeaders(res, nonce, relaxed);
      return res;
    }
    if (host.endsWith(".vercel.app")) {
      const res = nextWithNonce(req, nonce);
      if (isProd) applySecurityHeaders(res, nonce, relaxed);
      return res;
    }

    const appBaseUrl = normalizeBaseUrl(APP_BASE);
    const webBaseUrl = normalizeBaseUrl(WEB_BASE);
    if (!appBaseUrl && !webBaseUrl) {
      const res = nextWithNonce(req, nonce);
      if (isProd) applySecurityHeaders(res, nonce, relaxed);
      return res;
    }

    const appHost = getHost(appBaseUrl);
    const webHost = getHost(webBaseUrl);
    const pathname = req.nextUrl.pathname;

    const isAppHost = appHost ? host.endsWith(appHost) : false;
    const isWebHost = webHost ? host.endsWith(webHost) : false;

    if (isAppHost) {
      if (pathname === "/") {
        const url = req.nextUrl.clone();
        url.pathname = "/home";
        const res = NextResponse.redirect(url);
        if (isProd) applySecurityHeaders(res, nonce, relaxed);
        return res;
      }
      if (
        pathname.startsWith("/legal") ||
        pathname.startsWith("/privacy") ||
        pathname.startsWith("/terms") ||
        pathname.startsWith("/verify") ||
        pathname === "/pricing" ||
        pathname === "/support"
      ) {
        if (webBaseUrl) {
          const target = new URL(webBaseUrl);
          target.pathname = pathname;
          const res = NextResponse.redirect(target);
          if (isProd) applySecurityHeaders(res, nonce, relaxed);
          return res;
        }
      }
    }

    if (isWebHost) {
      if (
        pathname.startsWith("/home") ||
        pathname.startsWith("/capture") ||
        pathname.startsWith("/evidence") ||
        pathname.startsWith("/cases") ||
        pathname.startsWith("/teams") ||
        pathname.startsWith("/settings") ||
        pathname === "/dashboard"
      ) {
        if (appBaseUrl) {
          const target = new URL(appBaseUrl);
          target.pathname = pathname;
          const res = NextResponse.redirect(target);
          if (isProd) applySecurityHeaders(res, nonce, relaxed);
          return res;
        }
      }
    }

    const res = nextWithNonce(req, nonce);
    if (isProd) applySecurityHeaders(res, nonce, relaxed);
    return res;
  } catch {
    return NextResponse.next();
  }
}

export const config = {
  matcher: ["/((?!_next|favicon.ico).*)"]
};
