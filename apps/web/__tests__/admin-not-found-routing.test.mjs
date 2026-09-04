/**
 * THE AUTHENTICATED 404: STATUS *AND* BODY, MEASURED TOGETHER.
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * A signed-in platform admin who mistyped a runbook slug was shown the PUBLIC
 * marketing 404 — "Go to homepage · Sign in · Contact support" — with no route
 * back to the runbook index. During an incident that ended the trail, and it
 * told somebody holding a valid session that they were signed out.
 *
 * `(app)/not-found.tsx` exists to prevent precisely that and never ran:
 * `dynamicParams = false` makes an unknown param a ROUTING-level 404, which
 * resolves against the ROOT boundary and skips every segment boundary beneath
 * it.
 *
 * ===========================================================================
 * WHY THIS TEST HAS TWO HALVES
 * ===========================================================================
 * The obvious repair — `dynamicParams = true` so `notFound()` raises inside
 * the segment and a boundary under `admin/layout.tsx` renders with the console
 * shell — was implemented and served. It works, and it costs the status code:
 *
 *     GET /admin/platform/runbooks/no-such-runbook   ->  200
 *
 * The (app) layout has committed the response before the slug is known. A
 * not-found served as 200 is read as success by uptime checks, link checkers
 * and monitoring, so the status was kept and the BODY was fixed at the root
 * boundary instead.
 *
 * That is a trade-off, not a win, and the only thing that stops it silently
 * reversing is asserting both halves at once. A test that checked only the
 * body would go green on a change that quietly returned 200; a test that
 * checked only the status would go green on a change that quietly restored
 * "Sign in".
 *
 * ===========================================================================
 * IT NEEDS A SERVER
 * ===========================================================================
 * Status codes are not visible in source. If the fixture web server is not
 * running this SKIPS with a message rather than passing, because a check that
 * passes without running is how the original defect survived four reviews.
 *
 *   node services/api/scripts/dev-admin-fixture-api.mjs
 *   node apps/web/scripts/dev-admin-fixture.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE =
  process.env.PROOVRA_FIXTURE_WEB_BASE ?? "http://localhost:3311";

async function reachable() {
  try {
    const res = await fetch(`${BASE}/login`, {
      signal: AbortSignal.timeout(120_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const LIVE = await reachable();
const skip = LIVE
  ? false
  : `no fixture web server at ${BASE} — start dev-admin-fixture.mjs`;

test("an unknown runbook slug returns a real 404", { skip }, async () => {
  const res = await fetch(`${BASE}/admin/platform/runbooks/no-such-runbook`, {
    signal: AbortSignal.timeout(120_000),
  });
  assert.equal(
    res.status,
    404,
    "a not-found served as 200 is read as success by every monitor",
  );
});

/*
 * This asserted 200 for an ANONYMOUS request, which was true when it was
 * written and stopped being true when runbook authorization moved into
 * middleware: an unauthenticated reader is now refused before the page is
 * composed. The point it was making — a known slug is a real route, not
 * another 404 — still needs making, so it is made against the status the
 * route actually owes an anonymous caller.
 *
 * 401 and 404 are both asserted here on purpose. They are what separates
 * "this route exists and you may not read it" from "this route does not
 * exist", and a change that collapsed the first into the second would
 * otherwise look like a pass.
 */
test("a known runbook slug is a real route, and is refused, not 404", { skip }, async () => {
  const res = await fetch(
    `${BASE}/admin/platform/runbooks/tsa-timestamp-failure`,
    { signal: AbortSignal.timeout(120_000) },
  );
  assert.equal(
    res.status,
    401,
    "an anonymous reader must be refused the runbook, not served it",
  );
  assert.notEqual(
    res.status,
    404,
    "a known slug answering 404 would mean the route stopped resolving",
  );
});

test("an unknown /admin address returns 404", { skip }, async () => {
  const res = await fetch(`${BASE}/admin/definitely-not-a-page`, {
    signal: AbortSignal.timeout(120_000),
  });
  assert.equal(res.status, 404);
});

test("a public unknown address still returns 404", { skip }, async () => {
  const res = await fetch(`${BASE}/definitely-not-a-page`, {
    signal: AbortSignal.timeout(120_000),
  });
  assert.equal(res.status, 404);
});

/**
 * The BODY half.
 *
 * The root boundary is a client component, so the served HTML carries the
 * branch as source rather than as rendered text. Asserting on the module is
 * therefore the honest check for the copy, and it is paired with the live
 * status assertions above so the two cannot drift apart.
 */
test("the /admin branch never says Sign in and offers a way back", () => {
  const src = readFileSync(
    resolve(process.cwd(), "apps/web/app/not-found.tsx"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  const consoleBranch = src.slice(
    src.indexOf("if (inConsole)"),
    src.indexOf("if (inApp)"),
  );
  assert.ok(consoleBranch.length > 0, "the console branch must exist");
  assert.doesNotMatch(
    consoleBranch,
    /Sign in/,
    "the reader holds a session; offering sign-in is the defect",
  );
  assert.match(consoleBranch, /\/admin\/platform\/runbooks/, "no way back to runbooks");
  assert.match(consoleBranch, /href: "\/admin"/, "no way back to the console");
  assert.match(consoleBranch, /Back to Runbooks/, "the spec names this action");
  // usePathname is at the top of the component, not inside the branch — the
  // first version of this assertion was scoped to the slice and failed for
  // that reason rather than for anything about the page.
  assert.match(src, /usePathname/);
});

test("the public branch keeps its public recovery", () => {
  // The fix must not have degraded the signed-out case, which is the one this
  // boundary was originally written for.
  const src = readFileSync(
    resolve(process.cwd(), "apps/web/app/not-found.tsx"),
    "utf8",
  );
  const tail = src.slice(src.lastIndexOf('context="public"'));
  assert.match(tail, /Sign in/);
  assert.match(tail, /Go to homepage/);
});

test("the runbook route keeps dynamicParams = false", () => {
  // This single line is what produces the 404 status. The alternative was
  // measured at 200. Changing it without changing the header above means
  // somebody re-derived the trade-off from scratch and lost.
  const src = readFileSync(
    resolve(
      process.cwd(),
      "apps/web/app/(app)/admin/platform/runbooks/[slug]/page.tsx",
    ),
    "utf8",
  );
  assert.match(src, /^export const dynamicParams = false;$/m);
});
