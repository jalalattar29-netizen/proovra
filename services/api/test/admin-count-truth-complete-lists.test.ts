/**
 * THE ENDPOINTS A PAGE IS ALLOWED TO COUNT BY LENGTH.
 *
 * ===========================================================================
 * WHAT THIS BACKS
 * ===========================================================================
 * `apps/web/scripts/admin-count-truth-audit.mjs` classifies every count an
 * admin page renders by what stands behind it. Most resolve to a server
 * `total`, a `hasMore`, or a disclosed cap. A few resolve to nothing at all —
 * the page prints `rows.length` — and for those the audit accepts a written
 * declaration that THE SERVER RETURNS THE WHOLE LIST.
 *
 * That declaration is a claim about a handler in THIS service, and the web
 * audit cannot see this service. So the claim is asserted here. Add a `take`
 * to one of these queries and the page silently starts printing a page size as
 * a population; this test fails first.
 *
 * ===========================================================================
 * WHY A SOURCE ASSERTION RATHER THAN A SEEDED READ
 * ===========================================================================
 * A seeded read proves the handler returned 120 rows when 120 existed. It does
 * not prove there is no cap — only that the cap, if any, is above 120. The
 * property being claimed is the ABSENCE of a bound, and absence is what the
 * source states directly.
 *
 * The corresponding risk is that this test passes while the endpoint is broken
 * in some other way, which is why it is scoped to exactly one question and
 * says so.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/**
 * Mirrors `COMPLETE_LISTS` in the web audit. The two lists are kept in step by
 * `completeListDeclarationsMatch`, below — a declaration added on one side
 * without the other fails rather than quietly losing its proof.
 */
const COMPLETE_LISTS = [
  {
    endpoint: "GET /v1/automation/rules",
    file: "routes/automation.routes.ts",
    /** The exact query the handler runs to build the list. */
    query: "prisma.automationRule.findMany({",
    countedBy: "/admin/platform/automation — `{envelope.rules.length} rule`",
  },
] as const;

/**
 * The text of the `findMany({ … })` call, brace-balanced from the opening one.
 *
 * A fixed-length slice would run past the call into whatever followed and pick
 * up a `take:` belonging to a different query — which is the failure mode that
 * makes a guard like this worse than none.
 */
function callBody(source: string, needle: string): string {
  const start = source.indexOf(needle);
  if (start === -1) throw new Error(`query not found: ${needle}`);
  let depth = 0;
  for (let i = start + needle.length - 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after: ${needle}`);
}

describe("counts a page may take from a list's own length", () => {
  for (const decl of COMPLETE_LISTS) {
    it(`${decl.endpoint} returns every row — no take, no cursor`, () => {
      const source = readFileSync(resolve(SRC, decl.file), "utf8");
      const body = callBody(source, decl.query);

      // A cap under any of its spellings. `skip` counts too: an offset without
      // a bound is still a window, and a window's length is not a population.
      expect(body, `${decl.endpoint} is counted by length at ${decl.countedBy}`)
        .not.toMatch(/\b(take|skip|cursor)\s*:/);
    });
  }

  it("declares the same endpoints the web audit declares", async () => {
    // The web script is ESM and side-effect-free until it walks its own tree,
    // so the declaration table is read as TEXT rather than imported — this
    // service must not start executing a script from apps/web.
    const webAudit = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../apps/web/scripts/admin-count-truth-audit.mjs",
    );
    const text = readFileSync(webAudit, "utf8");
    for (const decl of COMPLETE_LISTS) {
      expect(
        text,
        `${decl.endpoint} is proved here but not declared in the web audit`,
      ).toContain(decl.endpoint);
    }
    // And the reverse: every `endpoint:` the audit declares is proved here.
    const declared = [...text.matchAll(/endpoint:\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    for (const endpoint of declared) {
      expect(
        COMPLETE_LISTS.map((d) => d.endpoint),
        `the web audit declares ${endpoint} complete with nothing proving it`,
      ).toContain(endpoint);
    }
  });
});
