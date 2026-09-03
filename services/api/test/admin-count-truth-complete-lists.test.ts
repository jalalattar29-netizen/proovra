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
    kind: "query",
    /** The exact query the handler runs to build the list. */
    at: "prisma.automationRule.findMany({",
    countedBy: "/admin/platform/automation",
  },
  {
    endpoint: "GET /v1/identity/members",
    file: "services/identity/rbac.service.ts",
    kind: "query",
    at: "client.teamMember.findMany({",
    countedBy: "/admin/identity",
  },
  {
    endpoint: "GET /v1/admin/adoption",
    file: "services/admin/adoption.service.ts",
    kind: "literal",
    /**
     * The rows are a LITERAL ARRAY, one entry per capability the product has.
     * The counts inside each entry come from the database; the number of
     * entries does not, which is the property the page's count relies on.
     */
    at: "const capabilities: CapabilityAdoption[] = [",
    countedBy: "/admin/adoption",
  },
  {
    endpoint: "GET /v1/admin/identity/role-matrix",
    file: "services/access-control/rbac-engine.service.ts",
    kind: "literal",
    at: "export function computeEffectiveRoleMatrix(): ReadonlyArray<EffectiveRoleMatrixRow> {",
    countedBy: "/admin/identity/permission-matrix",
  },
] as const;

/**
 * The text of a `{ … }` or `[ … ]` block, balanced from the opening bracket.
 *
 * A fixed-length slice would run past the construct into whatever followed and
 * pick up a `take:` belonging to a different query — the failure mode that
 * makes a guard like this worse than none.
 */
function blockAt(source: string, needle: string): string {
  const start = source.indexOf(needle);
  if (start === -1) throw new Error(`not found: ${needle}`);
  const openIdx = Math.max(needle.lastIndexOf("{"), needle.lastIndexOf("["));
  if (openIdx === -1) throw new Error(`no opening bracket in: ${needle}`);
  const open = needle[openIdx];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start + openIdx; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced ${open} after: ${needle}`);
}

describe("counts a page may take from a list's own length", () => {
  for (const decl of COMPLETE_LISTS) {
    it(`${decl.endpoint} returns every row`, () => {
      const source = readFileSync(resolve(SRC, decl.file), "utf8");
      const body = blockAt(source, decl.at);
      const why = `${decl.endpoint} is counted by length on ${decl.countedBy}`;

      if (decl.kind === "query") {
        // A cap under any of its spellings. `skip` counts too: an offset with
        // no bound is still a window, and a window's length is not a
        // population.
        expect(body, why).not.toMatch(/\b(take|skip|cursor)\s*:/);
      } else {
        // A literal list. The claim is that its LENGTH is fixed by the source,
        // so the block must not itself be built by a query — a `findMany` or a
        // `.map` over one would make the row count data-dependent again.
        expect(body, `${why} — the list must be literal`).not.toMatch(
          /findMany|\bawait\b/,
        );
      }
    });
  }

  it("declares the same endpoints the web audit declares", async () => {
    // The web script is ESM and side-effect-free until it walks its own tree,
    // so the declaration table is read as TEXT rather than imported — this
    // service must not start executing a script from apps/web.
    // The declaration table moved out of the audit script into a shared
    // module so the composition contract could read it too. This path had to
    // move with it: pointed at the old file it would have found zero
    // declarations, passed vacuously, and left three of them unproven — the
    // exact failure this cross-check exists to prevent.
    const webAudit = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../apps/web/scripts/admin-complete-lists.mjs",
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
