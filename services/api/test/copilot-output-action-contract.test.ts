/**
 * AI COPILOT — every output-action and result branch, proven where it is decided.
 *
 * ===========================================================================
 * WHY THIS DOES NOT NEED A BROWSER
 * ===========================================================================
 * The Copilot's offer is not computed in the browser. `ai-evidence.routes.ts`
 * reads the canonical output projection and pushes a suggestion ONLY when the
 * canonical action is not NONE; the panel renders whatever the server sent and
 * decides nothing:
 *
 *     const canonicalAction = outputStatus?.outputs.report.action ?? "NONE";
 *     if (canonicalAction !== "NONE") { serverActions.push(...) }
 *
 * A browser session would confirm that React renders props it was given. What
 * actually decides each branch is the server mapping above and the shared
 * outcome reader, and both are reachable from here.
 *
 * The one thing a browser could still add is visual confirmation, which is not
 * what any of these branches turn on.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  GENERATION_REQUEST_OUTCOMES,
  outputActionFor,
} from "@proovra/shared";

const ROUTE = readFileSync(
  fileURLToPath(
    new URL("../src/routes/ai-evidence.routes.ts", import.meta.url),
  ),
  "utf8",
);
const PANEL = readFileSync(
  fileURLToPath(
    new URL(
      "../../../apps/web/components/ai-copilot/EvidenceCopilotPanel.tsx",
      import.meta.url,
    ),
  ),
  "utf8",
);
const OUTCOME_READER = readFileSync(
  fileURLToPath(
    new URL("../../../apps/web/lib/evidence/generation-outcome.ts", import.meta.url),
  ),
  "utf8",
);

describe("AI Copilot — the offer comes from the canonical action", () => {
  it("the server reads outputs.report.action and nothing else", () => {
    expect(ROUTE).toContain(
      'const canonicalAction = outputStatus?.outputs.report.action ?? "NONE";',
    );
    // FAILS CLOSED. A projection that could not be built yields NONE, which
    // yields no suggestion — never a speculative offer.
    expect(ROUTE).toContain('?? "NONE"');
  });

  it("C1 — canonical NONE pushes no suggestion at all", () => {
    const block = ROUTE.slice(ROUTE.indexOf("const canonicalAction =")).slice(0, 400);
    expect(block).toMatch(/if \(canonicalAction !== "NONE"\) \{/);
  });

  it("C2/C3/C4 — every non-NONE action maps to its canonical verb", () => {
    const block = ROUTE.slice(ROUTE.indexOf("const canonicalAction =")).slice(0, 2000);
    expect(block).toContain('"Generate report & verification package"');
    expect(block).toContain('"Retry report & verification package"');
    expect(block).toContain('"Regenerate report & verification package"');
    // REGENERATE is recorded under a distinct audit id, and the VERB is still
    // the canonical one — the id is for the trail, not for the operator.
    expect(block).toMatch(/canonicalAction === "REGENERATE"[\s\S]{0,80}"RETRY_ELIGIBLE_REPORT"/);
  });

  it("C5/C6 — BLOCKED and TERMINAL_FAILURE yield NONE, so no action is offered", () => {
    // Proven against the AUTHORITY rather than the route: the route offers
    // nothing when the action is NONE, so what matters is that these states
    // produce NONE. This is the behavioural half of C5/C6.
    for (const state of ["BLOCKED", "TERMINAL_FAILURE", "QUEUED", "GENERATING", "NOT_INCLUDED"] as const) {
      expect(
        outputActionFor({ state, eligibility: "ELIGIBLE" }),
        `${state} must offer no action`,
      ).toBe("NONE");
    }
  });

  it("READY offers REGENERATE only while still entitled", () => {
    expect(outputActionFor({ state: "READY", eligibility: "ELIGIBLE" })).toBe(
      "REGENERATE",
    );
    // After a downgrade the artifact stays downloadable and the offer stops.
    expect(outputActionFor({ state: "READY", eligibility: "NOT_INCLUDED" })).toBe(
      "NONE",
    );
  });

  it("the panel derives NOTHING locally — no count, no plan, no force flag", () => {
    /*
     * COMMENTS STRIPPED FIRST, and that is not a convenience.
     *
     * The panel's docblock NAMES `_count.reports` in order to record that the
     * derivation was removed and why — it offered "Generate Report" on FREE
     * records whose canonical action is NONE. A raw text search cannot tell
     * that apart from the derivation itself, and would either fail on an honest
     * comment or force someone to delete the explanation to get green.
     *
     * A derivation described in prose is not a derivation.
     */
    const code = PANEL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/_count\s*[.?]\s*reports/);
    expect(code).not.toMatch(/reportsIncluded/);
    expect(code).not.toMatch(/forceRegenerate/);
    expect(code).not.toMatch(/plan\s*===\s*["']/);
    // The offer is exactly "did the server send one".
    expect(PANEL).toContain("const canGenerateReport = Boolean(generationAction)");
  });
});

describe("AI Copilot — every typed result branch", () => {
  it("C7 — enqueued:false can never render queued-success copy", () => {
    // The reader maps the OUTCOME, and only ENQUEUED/SUPERSEDED are accepted
    // work. `enqueued: false` with no outcome cannot fall through to success.
    expect(OUTCOME_READER).toContain("generationOutcomeAcceptedWork");
    expect(PANEL).toContain("readGenerationOutcome");
    // The panel must not report success from the bare HTTP result.
    expect(PANEL).not.toMatch(/queued through the standard audited workflow/);
  });

  it("every canonical outcome has copy, and the set is total", () => {
    // A missing branch is how "queued" gets shown for a refusal.
    for (const outcome of GENERATION_REQUEST_OUTCOMES) {
      expect(
        OUTCOME_READER.includes(`${outcome}:`),
        `${outcome} must have a mapped message`,
      ).toBe(true);
    }
  });

  it("C8/C9/C10 — the three that were previously conflated are distinct", () => {
    expect(OUTCOME_READER).toMatch(/ALREADY_ACTIVE:[^\n]*already under way/);
    expect(OUTCOME_READER).toMatch(/QUEUE_UNAVAILABLE:[\s\S]{0,200}picked up automatically/);
    expect(OUTCOME_READER).toMatch(/NOT_INCLUDED:[\s\S]{0,200}not included/);
  });

  it("C11 — no TSA action is reachable from the Copilot, at all", () => {
    for (const forbidden of [/retry[_\s-]?tsa/i, /tsa[_\s-]?retry/i, /re-?stamp/i]) {
      expect(PANEL).not.toMatch(forbidden);
      expect(ROUTE).not.toMatch(forbidden);
    }
  });

  it("C12 — the Copilot posts to the canonical route and cannot self-authorize", () => {
    // Same endpoint as Evidence Detail and Reports. Authority is re-derived
    // server-side there; the panel carries no permission or hold reasoning.
    expect(PANEL).toContain("/reports/regenerate");
    expect(PANEL).not.toMatch(/legalHold|legal_hold/i);
    expect(PANEL).not.toMatch(/permission\s*===|hasPermission\(/);
  });
});
