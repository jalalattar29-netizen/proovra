import { NextResponse, type NextRequest } from "next/server";

const APP_BASE = process.env.NEXT_PUBLIC_APP_BASE;
const WEB_BASE = process.env.NEXT_PUBLIC_WEB_BASE;
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "https://api.proovra.com";

function buildCsp(nonce: string, relaxed: boolean, allowEval: boolean) {
  const base = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "img-src 'self' data: https:",
    "font-src 'self' data: https:",
    `connect-src 'self' ${API_BASE} https://accounts.google.com https://appleid.apple.com https://appleid.cdn-apple.com`,
    "frame-src 'self' https://accounts.google.com https://appleid.apple.com",
    "form-action 'self' https://appleid.apple.com",
    "style-src-attr 'unsafe-inline'",
    "style-src-elem 'self' 'unsafe-inline' https://accounts.google.com https://appleid.cdn-apple.com"
  ];

  if (relaxed) {
    base.push(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://accounts.google.com https://appleid.cdn-apple.com",
      "style-src 'self' 'unsafe-inline'"
    );
  } else {
    const scriptParts = [`'nonce-${nonce}'`, "https://accounts.google.com", "https://appleid.cdn-apple.com"];
    if (allowEval) scriptParts.push("'unsafe-eval'");
    base.push(`script-src 'self' ${scriptParts.join(" ")}`, `style-src 'self' 'nonce-${nonce}' 'unsafe-inline'`);
  }

  return base.join("; ");
}

function applySecurityHeaders(response: NextResponse, nonce: string, relaxed: boolean, allowEval: boolean) {
  const csp = buildCsp(nonce, relaxed, allowEval);
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
  return NextResponse.next({ request: { headers: requestHeaders } });
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
    const allowEval = process.env.CSP_ALLOW_EVAL === "true";
    const nonce = btoa(crypto.randomUUID());

    const host = req.headers.get("host");
    const pathname = req.nextUrl.pathname;

    if (isProd) {
      const logMode = relaxed ? "relaxed" : allowEval ? "strict-eval" : "strict";
      console.info(`[csp] mode=${logMode} path=${pathname}`);
    }
    // ✅ Always keep legal + policy pages on the SAME host (no cross-domain redirect)
    // This prevents "looks like signed out" when user is inside the app.
    const KEEP_SAME_HOST = ["/legal", "/privacy", "/terms"];
    const isKeepSameHostPath = KEEP_SAME_HOST.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`)
    );

    if (isKeepSameHostPath) {
      const res = nextWithNonce(req, nonce);
      if (isProd) applySecurityHeaders(res, nonce, relaxed, allowEval);
      return res;
    }
    // dev / vercel preview: no host switching
    if (!host || host.includes("localhost") || host.includes("127.0.0.1") || host.endsWith(".vercel.app")) {
      const res = nextWithNonce(req, nonce);
      if (isProd) applySecurityHeaders(res, nonce, relaxed, allowEval);
      return res;
    }

    const appBaseUrl = normalizeBaseUrl(APP_BASE);
    const webBaseUrl = normalizeBaseUrl(WEB_BASE);

    if (!appBaseUrl && !webBaseUrl) {
      const res = nextWithNonce(req, nonce);
      if (isProd) applySecurityHeaders(res, nonce, relaxed, allowEval);
      return res;
    }

    const appHost = getHost(appBaseUrl);
    const webHost = getHost(webBaseUrl);

    const isAppHost = appHost ? host.endsWith(appHost) : false;
    const isWebHost = webHost ? host.endsWith(webHost) : false;

    // app root -> /home
    if (isAppHost && pathname === "/") {
      const target = new URL(req.url);
      target.pathname = "/home";
      const res = NextResponse.redirect(target);
      if (isProd) applySecurityHeaders(res, nonce, relaxed, allowEval);
      return res;
    }

    // app login/register -> web login/register
    if (isAppHost && (pathname === "/login" || pathname === "/register")) {
      const target = new URL(webBaseUrl ?? "https://www.proovra.com");
      target.pathname = pathname;
      req.nextUrl.searchParams.forEach((v, k) => target.searchParams.set(k, v));
      const res = NextResponse.redirect(target);
      if (isProd) applySecurityHeaders(res, nonce, relaxed, allowEval);
      return res;
    }

    // web app-pages -> app host
    const APP_PREFIXES = ["/home", "/capture", "/cases", "/teams", "/reports", "/billing", "/settings"];
    const isAppPath = APP_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

    if (isWebHost && isAppPath && appBaseUrl) {
      const target = new URL(appBaseUrl);
      target.pathname = pathname;
      const res = NextResponse.redirect(target);
      if (isProd) applySecurityHeaders(res, nonce, relaxed, allowEval);
      return res;
    }

    const res = nextWithNonce(req, nonce);
    if (isProd) applySecurityHeaders(res, nonce, relaxed, allowEval);
    return res;
  } catch {
    return NextResponse.next();
  }
}

export const config = {
  matcher: ["/((?!_next|favicon.ico).*)"]
};