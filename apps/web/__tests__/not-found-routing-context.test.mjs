/**
 * A SIGNED-IN OPERATOR MUST NEVER BE OFFERED "SIGN IN".
 *
 * ===========================================================================
 * THE DEFECT, AND THE THING THAT MAKES IT EASY TO REINTRODUCE
 * ===========================================================================
 * `/admin/platform/runbooks/no-such-runbook`, opened by a signed-in platform
 * admin, rendered the PUBLIC marketing 404: "Go to homepage · Sign in ·
 * Contact support", with no route back to the runbook index. During an
 * incident, a mistyped slug ended the trail and told the reader they were
 * signed out.
 *
 * `(app)/not-found.tsx` was written to prevent exactly this — its comment
 * promises recovery stays in-app "so the user never appears signed out". It
 * never ran, because the runbook route sets `dynamicParams = false`, which
 * makes an unknown param a ROUTING-level 404. A routing 404 resolves against
 * the ROOT boundary and skips every segment boundary underneath it.
 *
 * That last sentence is the part worth writing down. The obvious repair — a
 * `not-found.tsx` inside the `[slug]` segment — was tried, and the marketing
 * page still rendered. It is deleted. Anyone reaching for it again will find
 * this test instead.
 *
 * Verified in a browser against the local fixture:
 *   /admin/platform/runbooks/no-such-runbook → 404, data-testid
 *     "admin-not-found", no "Sign in", links to /admin/platform/runbooks
 *   /definitely-not-a-page                   → 404, "public-not-found",
 *     unchanged
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const WEB = resolve(process.cwd(), "apps/web");
const read = (p) => readFileSync(resolve(WEB, p), "utf8");
/** Comments stripped: this file and the source both DISCUSS what they forbid. */
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("the root 404 branches on the pathname", () => {
  const src = code("app/not-found.tsx");
  assert.match(src, /usePathname/);
  assert.match(src, /startsWith\("\/admin"\)/);
});

test("an /admin path is never offered Sign in", () => {
  const src = code("app/not-found.tsx");
  const consoleBranch = src.slice(
    src.indexOf("if (inConsole)"),
    src.indexOf("if (inApp)"),
  );
  assert.ok(consoleBranch.length > 0, "the console branch must exist");
  assert.doesNotMatch(consoleBranch, /Sign in/);
  assert.match(consoleBranch, /\/admin\/platform\/runbooks/);
});

test("the public branch keeps its public recovery", () => {
  // The fix must not have quietly degraded the signed-out case, which is the
  // one this boundary was actually written for.
  const src = code("app/not-found.tsx");
  const tail = src.slice(src.lastIndexOf('context="public"'));
  assert.match(tail, /Sign in/);
  assert.match(tail, /Go to homepage/);
});

test("no segment not-found is reintroduced under the runbook slug", () => {
  // It does not work. Proven, not assumed — see the header.
  assert.equal(
    existsSync(resolve(WEB, "app/(app)/admin/platform/runbooks/[slug]/not-found.tsx")),
    false,
    "a not-found.tsx here is dead code: dynamicParams=false skips segment boundaries",
  );
});

test("the runbook route still returns a REAL 404", () => {
  // The status code is the reason `dynamicParams = false` is there. Trading it
  // for a nicer body would fix the smaller problem by making a worse one.
  const src = code("app/(app)/admin/platform/runbooks/[slug]/page.tsx");
  assert.match(src, /export const dynamicParams = false/);
});
