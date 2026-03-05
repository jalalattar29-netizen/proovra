import { NextResponse, type NextRequest } from "next/server";

const APP_BASE = process.env.NEXT_PUBLIC_APP_BASE;
const WEB_BASE = process.env.NEXT_PUBLIC_WEB_BASE;
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "https://api.proovra.com";

// Cloudflare R2 wildcard (as host allowance)
const R2_HOST = "https://*.r2.cloudflarestorage.com";

function buildCsp(nonce: string, isProd: boolean, relaxed: boolean, allowEval: boolean) {
  // ✅ في production: ممنوع relaxed وممنوع eval نهائياً
  const effectiveRelaxed = isProd ? false : relaxed;
  const effectiveAllowEval = isProd ? false : allowEval;

  const base: string[] = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",

    // ✅ لا تسمح لأي موقع يضمّن موقعك داخل iframe
    // (متوافق مع X-Frame-Options: DENY)
    "frame-ancestors 'none'",

    // images/fonts/media
    `img-src 'self' data: blob: https: ${R2_HOST}`,
    `media-src 'self' blob: https: ${R2_HOST}`,
    "font-src 'self' data: https:",

    // ✅ اتصالات الشبكة: شدّها في production (لا http/ws)
    // (خلي https/wss + API + R2)
    isProd
      ? `connect-src 'self' https: wss: ${API_BASE} ${R2_HOST} https://accounts.google.com https://appleid.apple.com https://appleid.cdn-apple.com`
      : `connect-src 'self' https: http: ws: wss: ${API_BASE} ${R2_HOST} https://accounts.google.com https://appleid.apple.com https://appleid.cdn-apple.com`,

    // OAuth
    "frame-src 'self' https://accounts.google.com https://appleid.apple.com",
    "form-action 'self' https://appleid.apple.com",

    // styles (نخليه مرن لأن Next غالباً يحتاج inline styles)
    "style-src-attr 'unsafe-inline'",
    "style-src-elem 'self' 'unsafe-inline' https://accounts.google.com https://appleid.cdn-apple.com",
  ];

  if (effectiveRelaxed) {
    // ⚠️ relaxed (dev/preview فقط)
    base.push(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://accounts.google.com https://appleid.cdn-apple.com",
      "style-src 'self' 'unsafe-inline'"
    );
  } else {
    // ✅ strict (مع nonce)
    const scriptParts = [`'nonce-${nonce}'`, "https://accounts.google.com", "https://appleid.cdn-apple.com"];
    if (effectiveAllowEval) scriptParts.push("'unsafe-eval'"); // dev/preview فقط
    base.push(`script-src 'self' ${scriptParts.join(" ")}`, `style-src 'self' 'nonce-${nonce}' 'unsafe-inline'`);
  }

  return base.join("; ");
}

function applySecurityHeaders(response: NextResponse, nonce: string, isProd: boolean, relaxed: boolean, allowEval: boolean) {
  const csp = buildCsp(nonce, isProd, relaxed, allowEval);
  response.headers.set("Content-Security-Policy", csp);

  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "same-origin");

  // إذا بدك تشدد أكثر لاحقاً: خليه ( ) بدل (self)
  response.headers.set("Permissions-Policy", "geolocation=(self)");

  // ✅ لا ترسل nonce كـ response header (غير ضروري)
  // response.headers.set("x-nonce", nonce);
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

    // ✅ حتى لو حدا فعّل flags بالغلط في prod، ما رح يؤثر (شف buildCsp)
    const relaxed = process.env.CSP_RELAXED === "true";
    const allowEval = process.env.CSP_ALLOW_EVAL === "true";

    const nonce = btoa(crypto.randomUUID());

    const host = req.headers.get("host");
    const pathname = req.nextUrl.pathname;

    // ✅ لا تسجّل CSP logs في production
    // إذا بدكها فقط في dev:
    // if (!isProd) console.info(`[csp] ...`);

    // dev / vercel preview: no host switching
    if (!host || host.includes("localhost") || host.includes("127.0.0.1") || host.endsWith(".vercel.app")) {
      const res = nextWithNonce(req, nonce);
      if (isProd) applySecurityHeaders(res, nonce, isProd, relaxed, allowEval);
      return res;
    }

    const appBaseUrl = normalizeBaseUrl(APP_BASE);
    const webBaseUrl = normalizeBaseUrl(WEB_BASE);

    if (!appBaseUrl && !webBaseUrl) {
      const res = nextWithNonce(req, nonce);
      if (isProd) applySecurityHeaders(res, nonce, isProd, relaxed, allowEval);
      return res;
    }

    const appHost = getHost(appBaseUrl);
    const webHost = getHost(webBaseUrl);

    const isAppHost = appHost ? host.endsWith(appHost) : false;
    const isWebHost = webHost ? host.endsWith(webHost) : false;

    const isLegalPath = pathname === "/privacy" || pathname === "/terms" || pathname.startsWith("/legal/");

    if (isLegalPath) {
      if (isAppHost) {
        let appLegalPath: string | null = null;

        if (pathname === "/privacy") appLegalPath = "/app-legal/privacy";
        else if (pathname === "/terms") appLegalPath = "/app-legal/terms";
        else if (pathname.startsWith("/legal/")) {
          appLegalPath = pathname.replace("/legal/", "/app-legal/");
        }

        if (appLegalPath) {
          const target = req.nextUrl.clone();
          target.pathname = appLegalPath;
          const res = NextResponse.rewrite(target);
          if (isProd) applySecurityHeaders(res, nonce, isProd, relaxed, allowEval);
          return res;
        }
      }

      const res = nextWithNonce(req, nonce);
      if (isProd) applySecurityHeaders(res, nonce, isProd, relaxed, allowEval);
      return res;
    }

    // app root -> /home
    if (isAppHost && pathname === "/") {
      const target = new URL(req.url);
      target.pathname = "/home";
      const res = NextResponse.redirect(target);
      if (isProd) applySecurityHeaders(res, nonce, isProd, relaxed, allowEval);
      return res;
    }

    // app login/register -> web login/register
    if (isAppHost && (pathname === "/login" || pathname === "/register")) {
      const target = new URL(webBaseUrl ?? "https://www.proovra.com");
      target.pathname = pathname;
      req.nextUrl.searchParams.forEach((v, k) => target.searchParams.set(k, v));
      const res = NextResponse.redirect(target);
      if (isProd) applySecurityHeaders(res, nonce, isProd, relaxed, allowEval);
      return res;
    }

    // web app-pages -> app host
    const APP_PREFIXES = ["/home", "/capture", "/cases", "/teams", "/reports", "/billing", "/settings"];
    const isAppPath = APP_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

    if (isWebHost && isAppPath && appBaseUrl) {
      const target = new URL(appBaseUrl);
      target.pathname = pathname;
      const res = NextResponse.redirect(target);
      if (isProd) applySecurityHeaders(res, nonce, isProd, relaxed, allowEval);
      return res;
    }

    const res = nextWithNonce(req, nonce);
    if (isProd) applySecurityHeaders(res, nonce, isProd, relaxed, allowEval);
    return res;
  } catch {
    return NextResponse.next();
  }
}

export const config = {
  matcher: ["/((?!_next|favicon.ico).*)"],
};