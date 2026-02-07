import { NextResponse, type NextRequest } from "next/server";

const APP_BASE = process.env.NEXT_PUBLIC_APP_BASE;
const WEB_BASE = process.env.NEXT_PUBLIC_WEB_BASE;

function parseHost(base: string | undefined) {
  if (!base) return null;
  try {
    return new URL(base).host;
  } catch {
    try {
      return new URL(`https://${base}`).host;
    } catch {
      return null;
    }
  }
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

export function middleware(req: NextRequest) {
  const host = req.headers.get("host");
  if (!host || host.includes("localhost") || host.includes("127.0.0.1")) {
    return NextResponse.next();
  }

  const appHost = parseHost(APP_BASE);
  const webHost = parseHost(WEB_BASE);
  const appBaseUrl = normalizeBaseUrl(APP_BASE);
  const webBaseUrl = normalizeBaseUrl(WEB_BASE);
  const pathname = req.nextUrl.pathname;

  const isAppHost = appHost && host.includes(appHost);
  const isWebHost = webHost && host.includes(webHost);

  if (isAppHost) {
    if (pathname === "/") {
      const url = req.nextUrl.clone();
      url.pathname = "/home";
      return NextResponse.redirect(url);
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
        return NextResponse.redirect(new URL(pathname, webBaseUrl));
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
        return NextResponse.redirect(new URL(pathname, appBaseUrl));
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next|favicon.ico).*)"]
};
