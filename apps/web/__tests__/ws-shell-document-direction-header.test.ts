/**
 * PRO-PW-10 (DEC-31) — the middleware stamps the rendered path on the request
 * it forwards (REQUEST_PATHNAME_HEADER), so the root layout can render the
 * same lang/dir the client will; a value sent by the client is overwritten.
 *
 * Behavioural: the real middleware; the forwarded request headers are read
 * from Next's `x-middleware-request-*` response headers.
 */
import "./support/split-host-env";

import assert from "node:assert/strict";
import { test } from "node:test";

import { NextRequest } from "next/server";

import { middleware } from "../middleware";
import { documentLanguage } from "../lib/i18n-english-only";
import { REQUEST_PATHNAME_HEADER } from "../lib/request-pathname-header";
import { SPLIT_HOSTS } from "./support/split-host-env";

const forwarded = (res: Response) => res.headers.get(`x-middleware-request-${REQUEST_PATHNAME_HEADER}`);

test("PRO-PW-10: an English-only public page is forwarded with its path", async () => {
  const res = await middleware(
    new NextRequest(`https://${SPLIT_HOSTS.web}/about`, { headers: { host: SPLIT_HOSTS.web } }),
  );
  assert.equal(forwarded(res), "/about");
});

test("PRO-PW-10: a client-sent path header is overwritten by the real path", async () => {
  const res = await middleware(
    new NextRequest(`https://${SPLIT_HOSTS.web}/pricing`, {
      headers: { host: SPLIT_HOSTS.web, [REQUEST_PATHNAME_HEADER]: "/home" },
    }),
  );
  assert.equal(forwarded(res), "/pricing");
});

test("PRO-PW-10: one rule for server and client — English-only pages are en/ltr, others follow the locale", () => {
  assert.deepEqual(documentLanguage("ar", "/about"), { lang: "en", dir: "ltr" });
  assert.deepEqual(documentLanguage("ar", "/support"), { lang: "ar", dir: "rtl" });
  assert.deepEqual(documentLanguage("ar", null), { lang: "ar", dir: "rtl" });
  assert.deepEqual(documentLanguage("de", "/home"), { lang: "de", dir: "ltr" });
});
