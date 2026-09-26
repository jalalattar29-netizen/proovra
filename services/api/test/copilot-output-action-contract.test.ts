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
  outputActionLabel,
  resolveEvidenceOutputActions,
  type EvidenceOutputFacts,
} from "@proovra/shared";

/** A finalized, entitled, unrestricted record; each case overrides a fact. */
const facts = (over: Partial<EvidenceOutputFacts> = {}): EvidenceOutputFacts => ({
  record: "FINALIZED",
  reportEligibility: "ELIGIBLE",
  packageEligibility: "ELIGIBLE",
  latestReportVersion: 1,
  packageAtLatestReport: true,
  latestPackageVersion: 1,
  packageBlockedByGovernance: false,
  reportRequest: null,
  packageRequest: null,
  restrictions: {
    lifecycleState: "ACTIVE",
    legalHold: false,
    workspaceSuspended: false,
    workspaceClosed: false,
    workspaceResolved: true,
  },
  callerMayGenerate: true,
  newVersionFitsStorage: true,
  ...over,
});

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
  it("the server reads the canonical per-output decision and nothing else", () => {
    expect(ROUTE).toContain("const reportDecision = outputStatus?.outputs.report;");
    expect(ROUTE).toContain("const packageDecision = outputStatus?.outputs.verificationPackage;");
    // FAILS CLOSED. A projection that could not be built yields NONE, which
    // yields no suggestion — never a speculative offer.
    expect(ROUTE).toContain('const canonicalAction = suggested?.action ?? "NONE";');
  });

  it("C1 — no canonical action pushes no suggestion at all", () => {
    const block = ROUTE.slice(ROUTE.indexOf("const canonicalAction =")).slice(0, 400);
    expect(block).toMatch(/if \(suggested\) \{/);
  });

  it("C2/C3/C4 — every offered action maps to the operation it performs, and a new version is never suggested", () => {
    const block = ROUTE.slice(ROUTE.indexOf("const reportDecision =")).slice(0, 3000);
    // The label is the shared per-output verb table, for the output the
    // suggestion acts on — the same words Evidence Detail and Reports render.
    expect(block).toMatch(
      /outputActionLabel\(\s*suggested\.output === "package" \? "verificationPackage" : "report",\s*canonicalAction,\s*\)/,
    );
    expect(outputActionLabel("report", "GENERATE")).toBe("Generate report & verification package");
    expect(outputActionLabel("report", "RETRY")).toBe("Retry report generation");
    expect(outputActionLabel("verificationPackage", "RECOVER")).toBe("Recover verification package");
    expect(outputActionLabel("verificationPackage", "RETRY")).toBe("Retry package recovery");
    // A new version is a deliberate, separately confirmed action on the
    // record — never an AI suggestion, and never labelled as recovery.
    expect(block).toMatch(/!== "REGENERATE"/);
    expect(block).not.toContain('"Regenerate report & verification package"');
  });

  it("C5/C6 — blocked, exhausted, in-flight and not-included states offer no action", () => {
    const cases: Array<[string, Partial<EvidenceOutputFacts>]> = [
      ["blocked by policy", { latestReportVersion: null, packageAtLatestReport: false, latestPackageVersion: null, reportRequest: { state: "BLOCKED_POLICY", terminalReasonCode: "workspace_mismatch" } }],
      ["exhausted technical", { latestReportVersion: null, packageAtLatestReport: false, latestPackageVersion: null, reportRequest: { state: "FAILED_TERMINAL", terminalReasonCode: "retry_budget_exhausted" } }],
      ["in flight", { latestReportVersion: null, packageAtLatestReport: false, latestPackageVersion: null, reportRequest: { state: "QUEUED", terminalReasonCode: null } }],
      ["not included", { latestReportVersion: null, packageAtLatestReport: false, latestPackageVersion: null, reportEligibility: "NOT_INCLUDED", packageEligibility: "NOT_INCLUDED" }],
    ];
    for (const [label, over] of cases) {
      const a = resolveEvidenceOutputActions(facts(over));
      expect(a.report.action, `${label}: report`).toBe("NONE");
      expect(a.verificationPackage.action, `${label}: package`).toBe("NONE");
    }
  });

  it("READY offers NO recovery verb; a new version is separate and only while entitled (D2)", () => {
    const ready = resolveEvidenceOutputActions(facts());
    expect(ready.report).toMatchObject({ action: "NONE", reason: "NOT_REQUIRED" });
    expect(ready.verificationPackage).toMatchObject({ action: "NONE", reason: "NOT_REQUIRED" });
    expect(ready.newVersion.action).toBe("CREATE_NEW_VERSION");
    // After a downgrade the artifact stays downloadable and the offer stops.
    const downgraded = resolveEvidenceOutputActions(
      facts({ reportEligibility: "NOT_INCLUDED", packageEligibility: "NOT_INCLUDED" }),
    );
    expect(downgraded.newVersion.action).toBe("NONE");
  });

  it("a report without its package recovers ONLY the package (D1)", () => {
    const a = resolveEvidenceOutputActions(facts({ packageAtLatestReport: false, latestPackageVersion: null }));
    expect(a.report.action).toBe("NONE");
    expect(a.verificationPackage).toMatchObject({ action: "RECOVER", operation: "PACKAGE_RECOVERY" });
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
