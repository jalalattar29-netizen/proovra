import { NextResponse, type NextRequest } from "next/server";

const APP_BASE = process.env.NEXT_PUBLIC_APP_BASE;
const WEB_BASE = process.env.NEXT_PUBLIC_WEB_BASE;

function normalizeHost(url: string | undefined) {
  if (!url) return null;
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function middleware(req: NextRequest) {
  const host = req.headers.get("host");
  if (!host || host.includes("localhost") || host.includes("127.0.0.1")) {
    return NextResponse.next();
  }

  const appHost = normalizeHost(APP_BASE);
  const webHost = normalizeHost(WEB_BASE);
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
      if (WEB_BASE) {
        return NextResponse.redirect(new URL(pathname, WEB_BASE));
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
      if (APP_BASE) {
        return NextResponse.redirect(new URL(pathname, APP_BASE));
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next|favicon.ico).*)"]
};
