/**
 * PRO-PW-10 (DEC-31) — the HTML the server sends carries the direction the
 * page will render. With Arabic chosen (the locale cookie), an English-only
 * public page is `lang="en" dir="ltr"` in the first frame, not only after
 * hydration; a translated page and the app follow the locale. The root layout
 * is called as the server calls it, with the request's cookies and the path
 * the middleware stamps (REQUEST_PATHNAME_HEADER).
 */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const req = vi.hoisted(() => ({ cookies: {} as Record<string, string>, headers: {} as Record<string, string> }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name in req.cookies ? { name, value: req.cookies[name] } : undefined) }),
  headers: async () => ({ get: (name: string) => req.headers[name.toLowerCase()] ?? null }),
}));
vi.mock("../../app/fonts", () => ({
  jakarta: { variable: "f-j" },
  headerFont: { variable: "f-h" },
  notoArabic: { variable: "f-a" },
  FONT_STRATEGY: "system",
}));

import RootLayout from "../../app/layout";
import { LOCALE_COOKIE, LOCALE_MODE_COOKIE } from "../../lib/i18n";
import { REQUEST_PATHNAME_HEADER } from "../../lib/request-pathname-header";

async function documentFor(path: string | null) {
  req.headers = path === null ? {} : { [REQUEST_PATHNAME_HEADER]: path };
  const el = (await RootLayout({ children: null })) as React.ReactElement<{ lang: string; dir: string }>;
  return { lang: el.props.lang, dir: el.props.dir };
}

beforeEach(() => {
  req.cookies = { [LOCALE_COOKIE]: "ar", [LOCALE_MODE_COOKIE]: "manual" };
});

describe("PRO-PW-10 server-rendered document direction", () => {
  it("an English-only public page stays English and left-to-right with Arabic chosen", async () => {
    for (const path of ["/", "/about", "/pricing", "/legal/privacy"]) {
      expect(await documentFor(path)).toEqual({ lang: "en", dir: "ltr" });
    }
  });

  it("a translated page and the app follow the chosen locale", async () => {
    for (const path of ["/support", "/home", "/evidence/1"]) {
      expect(await documentFor(path)).toEqual({ lang: "ar", dir: "rtl" });
    }
  });

  it("without the stamped path the locale decides (as before)", async () => {
    expect(await documentFor(null)).toEqual({ lang: "ar", dir: "rtl" });
  });

  it("English chosen: every page is left-to-right", async () => {
    req.cookies = {};
    expect(await documentFor("/home")).toEqual({ lang: "en", dir: "ltr" });
  });
});
