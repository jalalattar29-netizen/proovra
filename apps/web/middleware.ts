import { NextResponse, type NextRequest } from "next/server";

const APP_BASE = process.env.NEXT_PUBLIC_APP_BASE;
const WEB_BASE = process.env.NEXT_PUBLIC_WEB_BASE;

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
    const host = req.headers.get("host");
    if (!host || host.includes("localhost") || host.includes("127.0.0.1")) {
      return NextResponse.next();
    }
    if (host.endsWith(".vercel.app")) {
      return NextResponse.next();
    }

    const appBaseUrl = normalizeBaseUrl(APP_BASE);
    const webBaseUrl = normalizeBaseUrl(WEB_BASE);
    if (!appBaseUrl && !webBaseUrl) {
      return NextResponse.next();
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
          const target = new URL(webBaseUrl);
          target.pathname = pathname;
          return NextResponse.redirect(target);
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
          return NextResponse.redirect(target);
        }
      }
    }

    return NextResponse.next();
  } catch {
    return NextResponse.next();
  }
}

export const config = {
  matcher: ["/((?!_next|favicon.ico).*)"]
};
