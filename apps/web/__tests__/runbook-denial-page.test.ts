/**
 * The page a refused runbook request receives (middleware, 401/403).
 *
 * It replaced a bare text/plain sentence that a browser showed with no
 * landmark, heading or way forward. These pins keep it a complete accessible
 * page that carries no runbook content and can only send a reader back to
 * this origin.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { runbookDenialHtml } from "../lib/runbooks/denial-page";

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

for (const access of ["UNAUTHENTICATED", "FORBIDDEN"] as const) {
  test(`${access}: one <main>, one <h1>, a language, and no script`, () => {
    const html = runbookDenialHtml(access, "/admin/platform/runbooks/tsa-timestamp-failure");
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<html lang="en">/);
    assert.equal(count(html, /<main[\s>]/g), 1);
    assert.equal(count(html, /<h1[\s>]/g), 1);
    assert.equal(count(html, /<script/gi), 0);
    // The refusal is recognisable as one (the admin matrix's own wording).
    assert.match(html, /Platform administrator only|elevation is required/);
  });

  test(`${access}: carries no runbook text`, () => {
    const html = runbookDenialHtml(access, "/admin/platform/runbooks/tsa-timestamp-failure");
    const catalog = readFileSync(new URL("../lib/runbooks/catalog.generated.ts", import.meta.url), "utf8");
    const title = /slug: "tsa-timestamp-failure",\n\s+title: "([^"]+)"/.exec(catalog)?.[1];
    assert.ok(title, "the fixture runbook must exist in the catalog");
    assert.ok(!html.includes(title!), "the runbook title leaked into the refusal");
    assert.ok(!html.includes("tsa-timestamp-failure") || access === "UNAUTHENTICATED", "the slug leaked into a 403");
  });
}

test("an anonymous reader is offered sign-in that returns to the same path", () => {
  const html = runbookDenialHtml("UNAUTHENTICATED", "/admin/platform/runbooks/tsa-timestamp-failure");
  assert.match(html, /href="\/login\?next=%2Fadmin%2Fplatform%2Frunbooks%2Ftsa-timestamp-failure"/);
  assert.match(html, />Sign in</);
});

test("a signed-in reader without the capability is not offered sign-in again", () => {
  const html = runbookDenialHtml("FORBIDDEN", "/admin/platform/runbooks/tsa-timestamp-failure");
  assert.ok(!html.includes("/login"));
  assert.match(html, /href="\/"/);
});

test("the return path cannot leave this origin or break out of the attribute", () => {
  const offsite = runbookDenialHtml("UNAUTHENTICATED", "//evil.example/x");
  assert.match(offsite, /href="\/login\?next=%2F"/);
  const quoted = runbookDenialHtml("UNAUTHENTICATED", '/admin/platform/runbooks/"><script>');
  assert.equal(count(quoted, /<script/gi), 0);
  const href = /<a href="([^"]*)"/.exec(quoted)?.[1] ?? "";
  assert.equal(href, "/login?next=%2Fadmin%2Fplatform%2Frunbooks%2F%22%3E%3Cscript%3E", "the path escaped its attribute");
});
