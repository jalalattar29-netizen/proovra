/**
 * FINAL ENTERPRISE COMPLETION — UI wiring source contracts.
 *
 * Pins the frontend consumers of every user-facing AI route so none can
 * silently become an orphan again:
 *
 *   1. NL search — /v1/ai/search/nl is DELIBERATELY UNMOUNTED (and, since
 *      2026-09-16, a typed 410 tombstone). The word this
 *      suite turns on is "silently": an orphan nobody chose is the failure it
 *      exists to catch, and a withdrawal that is written down in three places
 *      is not one. See the block below.
 *   2. QcSamplingPanel — both QC routes, strategy selector, all three QC
 *      decisions, deep links, catalog-unavailable honesty, mounted on the
 *      Review page.
 *   3. Reviewer Criteria page — consumes the FULL lifecycle API surface:
 *      list, create, draft PATCH, publish, duplicate, retire, detail
 *      (version history).
 *   4. ReviewerCopilotPanel — stale-criteria warning with an EXPLICIT
 *      re-run (never a silent replacement).
 *   5. EvidenceCopilotPanel — server-derived actions only; execution goes
 *      through the EXISTING canonical report endpoint with confirmation.
 *   6. Enterprise UX honesty — no AI component ever renders provider or
 *      model names.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "apps", "web");
const read = (rel: string) => readFileSync(join(WEB, rel), "utf8");

describe("UI wiring — NL search is WITHDRAWN, on the record", () => {
  // INVERTED, DELIBERATELY.
  //
  // This suite pins frontend consumers so a user-facing AI route cannot
  // SILENTLY become an orphan. `/v1/ai/search/nl` is now an orphan on
  // purpose: the "Ask in plain language" card was withdrawn from /search for
  // every workspace type after an audit found it displayed synthesised names
  // for two of its seven presets and bypassed the reviewer-restriction gate
  // that the canonical search applies twice.
  //
  // What replaces the mount assertion is the paper trail, because that is what
  // makes this a decision rather than an accident. All three must hold.
  it("the component is gone, and nothing mounts it", () => {
    const page = read("app/(app)/search/page.tsx");
    expect(page).not.toContain("<NlSearchBox");
    expect(page).not.toMatch(/import \{ NlSearchBox \}/);
    expect(existsSync(join(WEB, "components/ai-copilot/NlSearchBox.tsx"))).toBe(
      false,
    );
  });

  it("the route survives as a typed 410 tombstone, and says why", () => {
    // RETIRED 2026-09-16. The registration is kept — a deleted route is a
    // compatibility break that answers a bare 404 — but the handler is a
    // typed 410 that does no work (runtime proof: phase-final-ai-routes-
    // runtime.test.ts and retired-routes-2026-09-16.test.ts). The audit that
    // withdrew it, and the bar for bringing it back, stay in the docstring.
    const route = readFileSync(
      join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "routes", "ai-search.routes.ts"),
      "utf8",
    );
    expect(route).toContain('app.post("/v1/ai/search/nl"');
    expect(route).toContain("reply.code(410)");
    expect(route).toContain('code: "NL_SEARCH_RETIRED"');
    expect(route).toContain('canonical: "/v1/search"');
    // The handler no longer reaches the parser, the database or the search.
    // (Code only — the docstring names what the audit found.)
    const code = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("parseNlSearch");
    expect(code).not.toContain("executeSearch");
    expect(code).not.toContain("prisma");
    // The audit's two findings, and the bar for bringing it back.
    expect(route).toMatch(/DISPLAY NAMES WERE FABRICATED/);
    expect(route).toMatch(/BYPASSED EVERY VISIBILITY GATE/);
    expect(route).toMatch(/BEFORE natural-language search is offered again/);
  });

  it("the withdrawal is registered as a route disposition", () => {
    // The machine-readable half: without this the route is an UNDISPOSED
    // no-consumer route and the closure gate correctly refuses the release.
    const manifest = JSON.parse(
      readFileSync(
        join(
          fileURLToPath(new URL(".", import.meta.url)),
          "..",
          "scripts",
          "capability-authority",
          "manifests",
          "route-dispositions.json",
        ),
        "utf8",
      ),
    ) as {
      entries: Array<{ routeId: string; disposition: string; evidence: string; replacement?: string }>;
    };
    const entry = manifest.entries.find(
      (e) => e.routeId === "POST /v1/ai/search/nl",
    );
    expect(entry, "the withdrawal must be dispositioned").toBeTruthy();
    // Retired 2026-09-16: dispositioned as the tombstone it now is.
    expect(entry!.disposition).toBe("COMPATIBILITY_TOMBSTONE");
    expect(entry!.evidence).toMatch(/withdrawn/i);
    expect(entry!.replacement).toBe("GET /v1/search");
  });
});

describe("UI wiring — QC sampling panel", () => {
  const src = read("components/ai-copilot/QcSamplingPanel.tsx");
  it("consumes both QC routes with strategy + all three decisions", () => {
    expect(src).toContain("/v1/ai/qc/samples?teamId=");
    expect(src).toContain("/decision");
    for (const d of ["QC_ACCEPTED", "QC_SKIPPED", "QC_REVIEWED"]) expect(src).toContain(d);
    expect(src).toContain("Sampling strategy");
  });
  it("deep-links to review and case surfaces and is honest when the catalog is absent", () => {
    expect(src).toContain("/reviewer-ops/");
    expect(src).toContain("/cases/");
    expect(src).toContain("catalogAvailable");
  });
  it("is mounted on the Review page", () => {
    expect(read("app/(app)/review/page.tsx")).toContain("<QcSamplingPanel");
  });
});

describe("UI wiring — Reviewer Criteria lifecycle page", () => {
  const src = read("app/(app)/settings/reviewer-criteria/page.tsx");
  it("consumes the FULL lifecycle API surface (no orphan criteria route)", () => {
    expect(src).toContain("/v1/reviewer-criteria?teamId="); // list
    expect(src).toContain("`/v1/reviewer-criteria`"); // create
    expect(src).toContain("/draft"); // draft edit (PATCH)
    expect(src).toContain('"PATCH"');
    expect(src).toMatch(/act\(s\.id, "publish"\)/);
    expect(src).toMatch(/act\(s\.id, "duplicate"\)/);
    expect(src).toMatch(/act\(s\.id, "retire"\)/);
    expect(src).toMatch(/\/v1\/reviewer-criteria\/\$\{setId\}\?teamId=/); // detail/history
  });
  it("communicates publish-immutability to the operator", () => {
    expect(src.toLowerCase()).toContain("immutable");
  });
});

describe("UI wiring — stale criteria + server-derived actions", () => {
  it("ReviewerCopilotPanel warns on stale criteria with an EXPLICIT re-run", () => {
    const src = read("components/ai-copilot/ReviewerCopilotPanel.tsx");
    expect(src).toContain("Re-run with v");
    expect(src).toMatch(/stale/i);
  });
  it("EvidenceCopilotPanel executes only SERVER-derived actions via the canonical endpoint with confirmation", () => {
    const src = read("components/ai-copilot/EvidenceCopilotPanel.tsx");
    expect(src).toContain("serverActions");
    expect(src).toContain("/reports/regenerate");
    expect(src).toContain("Confirm and run");
    // The model's free-text suggestions must never be executable.
    expect(src).not.toMatch(/suggestedActions\s*\.map\([^)]*onClick/s);
  });
});

describe("UI honesty — no provider/model names in any AI component", () => {
  it("AI components never render provider or model identifiers", () => {
    // `NlSearchBox.tsx` left this list when the component was deleted with the
    // withdrawn plain-language card. A path that no longer exists cannot be
    // swept; the rule is unchanged for every component that does.
    for (const rel of [
      "components/ai-copilot/QcSamplingPanel.tsx",
      "components/ai-copilot/EvidenceCopilotPanel.tsx",
      "components/ai-copilot/ReviewerCopilotPanel.tsx",
      "components/ai-copilot/CaseCopilotPanel.tsx",
      // `OperationsIntelligencePanel.tsx` was DELETED by the Operations
      // redesign. Its six buttons ran one deterministic snapshot through a
      // language model and returned a paraphrase of counts already on the
      // page, spending an AI operation per press. The rule below is unchanged
      // for every component that still exists.
      "app/(app)/settings/reviewer-criteria/page.tsx",
    ]) {
      const src = read(rel).toLowerCase();
      expect(src, `${rel} must not mention a provider`).not.toContain("openai");
      expect(src, `${rel} must not mention a model`).not.toContain("gpt-");
    }
  });
});
