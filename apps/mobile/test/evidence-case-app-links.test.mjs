/**
 * MOBILE-006 — evidence and case links have a production path into the app.
 *
 * The app could resolve /evidence/<id> and /cases/<id> through the server
 * (POST /v1/deep-link/resolve) but neither platform claimed the paths, so those
 * e-mails always opened the browser. Both platforms now claim them; the web's
 * /evidence/archive page under the same prefix opens the archive screen instead
 * of being sent to the resolve as a record id.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadModule } from "./support/render.mjs";

let D;
before(async () => {
  D = await loadModule("src/deep-link.ts");
});

test("both platforms claim /evidence and /cases on both hosts", () => {
  const app = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8"));
  const data = app.expo.android.intentFilters.flatMap((f) => f.data ?? []);
  for (const host of ["www.proovra.com", "proovra.com"]) {
    for (const p of ["/evidence/", "/cases/"]) {
      assert.ok(data.some((d) => d.host === host && d.pathPrefix === p), `${host}${p} is not claimed on Android`);
    }
  }
  const aasa = JSON.parse(readFileSync(new URL("../../web/public/.well-known/apple-app-site-association", import.meta.url), "utf8"));
  const paths = aasa.applinks.details.flatMap((d) => d.components.map((c) => c["/"]));
  assert.ok(paths.includes("/evidence/*") && paths.includes("/cases/*"));
});

test("a claimed record link goes to the server resolve; the archive page does not", () => {
  assert.equal(D.parseCanonicalMobileDeepLink("https://www.proovra.com/evidence/ev-1").route, "/(stack)/evidence/ev-1");
  assert.equal(D.parseCanonicalMobileDeepLink("https://proovra.com/cases/c-1").route, "/(stack)/case/c-1");
  assert.equal(D.parseCanonicalMobileDeepLink("https://www.proovra.com/evidence/archive"), null);
  assert.equal(D.workspacePageDeepLink("https://www.proovra.com/evidence/archive"), "/(stack)/evidence-archive");
  assert.equal(D.workspacePageDeepLink("https://www.proovra.com/evidence/ev-1"), null);
});
