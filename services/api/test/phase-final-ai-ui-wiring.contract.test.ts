/**
 * FINAL ENTERPRISE COMPLETION — UI wiring source contracts.
 *
 * Pins the frontend consumers of every user-facing AI route so none can
 * silently become an orphan again:
 *
 *   1. NlSearchBox — /v1/ai/search/nl, handles ALL four result kinds
 *      (REFUSED / UNSUPPORTED_FILTER / STATE_QUERY / TEXT_SEARCH), mounted
 *      on the Search page.
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "apps", "web");
const read = (rel: string) => readFileSync(join(WEB, rel), "utf8");

describe("UI wiring — NL search", () => {
  const src = read("components/ai-copilot/NlSearchBox.tsx");
  it("calls the canonical route and handles every result kind honestly", () => {
    expect(src).toContain("/v1/ai/search/nl");
    for (const kind of ["REFUSED", "UNSUPPORTED_FILTER", "STATE_QUERY", "TEXT_SEARCH"]) {
      expect(src).toContain(`"${kind}"`);
    }
  });
  it("is mounted on the Search page", () => {
    expect(read("app/(app)/search/page.tsx")).toContain("<NlSearchBox");
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
    for (const rel of [
      "components/ai-copilot/NlSearchBox.tsx",
      "components/ai-copilot/QcSamplingPanel.tsx",
      "components/ai-copilot/EvidenceCopilotPanel.tsx",
      "components/ai-copilot/ReviewerCopilotPanel.tsx",
      "components/ai-copilot/CaseCopilotPanel.tsx",
      "components/ai-copilot/OperationsIntelligencePanel.tsx",
      "app/(app)/settings/reviewer-criteria/page.tsx",
    ]) {
      const src = read(rel).toLowerCase();
      expect(src, `${rel} must not mention a provider`).not.toContain("openai");
      expect(src, `${rel} must not mention a model`).not.toContain("gpt-");
    }
  });
});
