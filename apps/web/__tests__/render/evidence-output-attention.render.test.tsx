/**
 * EVIDENCE OUTPUT ATTENTION — the one value behind the Overview card, the
 * Artifacts tab indicator and the page-level banner (2026-10-06).
 *
 * Every case is a different SERVER projection; nothing here is decided by the
 * test beyond the input. The page-level agreement (card / tab / banner /
 * Artifacts in one render, navigation and focus, the dialog, the
 * UPDATE_AVAILABLE → IN_PROGRESS → CURRENT transition) is proven on the real
 * page in evidence-detail-workspace-convergence.render.test.tsx.
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectOutputProgress } from "@proovra/shared";

import {
  deriveEvidenceOutputAttention,
  presentOutputAttention,
  type EvidenceOutputAttention,
  type OutputAttentionStatus,
} from "../../components/evidence-outputs/output-attention";
import {
  EvidenceOutputAttentionBanner,
  EvidenceOutputsCard,
  OutputAttentionTabIndicator,
  outputAttentionTabName,
} from "../../components/evidence-outputs/EvidenceOutputAttention";

// ---------------------------------------------------------------------------
// Server projections
// ---------------------------------------------------------------------------

type Slice = OutputAttentionStatus["outputs"]["report"];
const out = (state: string, action = "NONE", extra: Partial<Slice> = {}): Slice => ({
  state,
  action,
  actionUnavailableReason: action === "NONE" ? "NOT_REQUIRED" : null,
  notApplicableReason: null,
  terminalReasonClass: null,
  terminalReasonCode: null,
  version: state === "READY" ? 1 : null,
  ...extra,
});

const TRUST = {
  tsa: { status: "STAMPED", validated: true, validatedAtUtc: "2026-10-06T10:00:00Z", failureCode: null, genTimeUtc: null },
  ots: { status: "ANCHORED", anchorCheck: "PROOF_STRUCTURE", anchoredAtUtc: "2026-10-06T10:05:00Z" },
};

const pair = (v: number, pkg = true) => ({
  reportVersion: v,
  generatedAtUtc: "2026-10-06T09:00:00Z",
  sizeBytes: "100",
  sha256: "a".repeat(64),
  immutableRecorded: true,
  issueKind: null,
  issueReason: null,
  latest: true,
  package: pkg
    ? {
        version: v,
        generatedAtUtc: "2026-10-06T09:00:00Z",
        sizeBytes: "200",
        sha256: "b".repeat(64),
        embeddedReportSha256: "a".repeat(64),
        sealed: true,
        immutableRecorded: true,
        pairing: "REPORT_VERSION" as const,
      }
    : null,
  digestMismatch: false,
});

const active = (state: string, progressStage: string | null, extra: Record<string, unknown> = {}) => ({
  requestId: "req-1",
  intent: "NEW_VERSION",
  artifactType: "REPORT",
  state,
  stage: null,
  progressStage,
  targetVersion: 2,
  terminalReasonCode: null,
  attemptCount: 1,
  createdAtUtc: "2026-10-06T10:00:00Z",
  updatedAtUtc: "2026-10-06T10:00:10Z",
  completedAtUtc: null,
  recent: true,
  progress: projectOutputProgress({ state, stage: null, progressStage, artifactType: "REPORT" }),
  ...extra,
});

function status(over: {
  report?: Slice;
  pkg?: Slice;
  newVersion?: OutputAttentionStatus["outputs"]["newVersion"];
  freshness?: unknown;
  activeRequest?: unknown;
  latest?: ReturnType<typeof pair> | null;
} = {}): OutputAttentionStatus {
  const latest = over.latest === undefined ? pair(1) : over.latest;
  return {
    outputs: {
      report: over.report ?? out("READY"),
      verificationPackage: over.pkg ?? out("READY"),
      newVersion: over.newVersion ?? { action: "NONE", reason: "NOT_REQUIRED", currentVersion: 1, nextVersion: 2 },
      trust: TRUST,
      freshness: (over.freshness ?? { reportVersion: 1, reportGeneratedAtUtc: "2026-10-06T09:00:00Z", hasNewerFacts: false, changes: [] }) as never,
      activeRequest: (over.activeRequest ?? null) as never,
      pollIntervalMs: null,
    },
    versions: latest ? { versions: [latest], unpairedPackages: [] } : { versions: [], unpairedPackages: [] },
    report: { version: 1, generatedAtUtc: "2026-10-06T09:00:00Z" },
    verificationPackage: { version: 1 },
  };
}

const OFFERED = { action: "CREATE_NEW_VERSION", reason: null, currentVersion: 1, nextVersion: 2 };
const NEWER = {
  reportVersion: 1,
  reportGeneratedAtUtc: "2026-10-06T09:00:00Z",
  hasNewerFacts: true,
  changes: [
    { code: "TSA_VALIDATED_AFTER_REPORT", atUtc: "2026-10-06T10:00:00Z" },
    { code: "OTS_ANCHORED_AFTER_REPORT", atUtc: "2026-10-06T10:05:00Z" },
  ],
};

const derive = (s: OutputAttentionStatus, extra: { stalled?: boolean; statusEvidenceId?: string } = {}) =>
  deriveEvidenceOutputAttention({ evidenceId: "ev-1", statusEvidenceId: extra.statusEvidenceId ?? "ev-1", status: s, stalled: extra.stalled });

const STATES: Record<string, OutputAttentionStatus> = {
  CURRENT: status(),
  UPDATE_AVAILABLE: status({ freshness: NEWER, newVersion: OFFERED }),
  IN_PROGRESS: status({
    freshness: NEWER,
    newVersion: { action: "NONE", reason: "IN_PROGRESS", currentVersion: 1, nextVersion: 2 },
    activeRequest: active("PROCESSING", "BUILDING_PACKAGE"),
  }),
  RECOVERY_AVAILABLE: status({ pkg: out("ELIGIBLE_NOT_GENERATED", "RECOVER"), latest: pair(1, false) }),
  BLOCKED: status({
    report: out("TERMINAL_FAILURE", "NONE", {
      actionUnavailableReason: "REPORT_INTEGRITY_REVIEW",
      terminalReasonClass: "INTEGRITY",
      terminalReasonCode: "REPORT_INTEGRITY_MISMATCH",
    }),
    latest: null,
  }),
};

function mountCard(a: EvidenceOutputAttention) {
  const calls = { open: [] as string[], generate: 0, recover: [] as string[] };
  const view = render(
    <EvidenceOutputsCard
      attention={a}
      onOpenArtifacts={(f) => calls.open.push(f)}
      onGenerateUpdatedReport={() => {
        calls.generate += 1;
      }}
      onRecover={(action, output) => calls.recover.push(`${action}:${output}`)}
      busy={false}
      formatDateTime={(v) => String(v)}
    />,
  );
  return { ...view, calls };
}

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// 1-5. The card, one state at a time
// ---------------------------------------------------------------------------

describe("Evidence outputs card", () => {
  it("CURRENT — calm: versions, TSA, OTS, the comparison claim, no update warning", () => {
    const a = derive(STATES.CURRENT)!;
    expect(a.state).toBe("CURRENT");
    const { getByTestId, queryByText, calls } = mountCard(a);
    expect(getByTestId("evidence-outputs-badge").textContent).toBe("Current");
    expect(getByTestId("evidence-outputs-report").textContent).toBe("v1");
    expect(getByTestId("evidence-outputs-package").textContent).toBe("v1");
    expect(getByTestId("evidence-outputs-tsa").textContent).toBe("Validated");
    // The fixture anchor is PROOF_STRUCTURE: present, not chain-verified.
    expect(getByTestId("evidence-outputs-ots").textContent).toBe("Proof present, not chain-verified");
    expect(queryByText("All generated outputs reflect the latest verified facts.")).not.toBeNull();
    expect(queryByText(/New verification facts/)).toBeNull();
    fireEvent.click(getByTestId("evidence-outputs-view"));
    expect(calls.open).toEqual(["status"]);
  });

  it("CURRENT never claims the facts were compared when the API did not compare them", () => {
    const s = status();
    s.outputs.freshness = null;
    const { queryByText } = mountCard(derive(s)!);
    expect(queryByText(/reflect the latest verified facts/)).toBeNull();
  });

  it("UPDATE_AVAILABLE — server change copy, the immutability promise, the direct action", () => {
    const a = derive(STATES.UPDATE_AVAILABLE)!;
    expect(a).toMatchObject({ state: "UPDATE_AVAILABLE", currentVersion: 1, targetVersion: 2, canGenerate: true });
    const { getByTestId, getByText, calls } = mountCard(a);
    expect(getByTestId("evidence-outputs-badge").textContent).toBe("Update available");
    getByText("New verification facts are available");
    const changes = [...getByTestId("evidence-outputs-changes").querySelectorAll("li")].map((li) => li.dataset.freshnessCode);
    expect(changes).toEqual(["TSA_VALIDATED_AFTER_REPORT", "OTS_ANCHORED_AFTER_REPORT"]);
    getByText(/Report v1 will remain unchanged\./);
    fireEvent.click(getByTestId("evidence-outputs-generate"));
    expect(calls.generate).toBe(1);
    fireEvent.click(getByTestId("evidence-outputs-review"));
    expect(calls.open).toEqual(["status"]);
  });

  it("UPDATE_AVAILABLE changes are the server's, never inferred: a custody-only change says custody", () => {
    const a = derive(
      status({
        freshness: { ...NEWER, changes: [{ code: "CUSTODY_CHANGED_AFTER_REPORT", atUtc: null, count: 2 }] },
        newVersion: OFFERED,
      }),
    )!;
    const { getByTestId } = mountCard(a);
    const text = getByTestId("evidence-outputs-changes").textContent ?? "";
    expect(text).toMatch(/2 reportable custody events were recorded after report v1/);
    expect(text).not.toMatch(/timestamp|OpenTimestamps/i);
  });

  it("UPDATE_AVAILABLE without permission states why and offers no Generate", () => {
    const a = derive(status({ freshness: NEWER, newVersion: { action: "NONE", reason: "PERMISSION_DENIED", currentVersion: 1, nextVersion: 2 } }))!;
    expect(a).toMatchObject({ state: "UPDATE_AVAILABLE", canGenerate: false });
    const { queryByTestId, getByTestId } = mountCard(a);
    expect(queryByTestId("evidence-outputs-generate")).toBeNull();
    expect(getByTestId("evidence-outputs-unavailable").textContent).toMatch(/You don't have permission to do that/);
  });

  it("IN_PROGRESS — a compact live line from the durable step; View progress lands on the progress card", () => {
    const a = derive(STATES.IN_PROGRESS)!;
    expect(a).toMatchObject({ state: "IN_PROGRESS", requestId: "req-1", targetVersion: 2, stage: "BUILDING_PACKAGE" });
    const { getByTestId, calls } = mountCard(a);
    expect(getByTestId("evidence-outputs-badge").textContent).toBe("In progress");
    expect(getByTestId("evidence-outputs-progress").textContent).toBe("Generating report v2");
    expect(getByTestId("evidence-outputs-card").textContent).toMatch(/Current step: Building verification package\./);
    fireEvent.click(getByTestId("evidence-outputs-view-progress"));
    expect(calls.open).toEqual(["progress"]);
  });

  it("RECOVERY_AVAILABLE — the exact server verb on the package, the report stays recorded", () => {
    const a = derive(STATES.RECOVERY_AVAILABLE)!;
    expect(a).toMatchObject({ state: "RECOVERY_AVAILABLE", target: "verificationPackage", action: "RECOVER" });
    const { getByTestId, calls, container } = mountCard(a);
    expect(getByTestId("evidence-outputs-badge").textContent).toBe("Action required");
    expect(container.textContent).toMatch(/Verification package v1 could not be completed\./);
    expect(container.textContent).toMatch(/Report v1 remains safely recorded\./);
    const verb = getByTestId("evidence-outputs-recover");
    expect(verb.textContent).toBe("Recover verification package");
    fireEvent.click(verb);
    expect(calls.recover).toEqual(["RECOVER:verificationPackage"]);
    expect(container.textContent).not.toMatch(/Regenerate|\bFix\b/);
  });

  it("RECOVERY_AVAILABLE on a retryable report failure offers Retry report generation", () => {
    const a = derive(status({ report: out("RETRYABLE_FAILURE", "RETRY", { version: null }), latest: null }))!;
    expect(a).toMatchObject({ state: "RECOVERY_AVAILABLE", target: "report", action: "RETRY" });
    const { getByTestId, calls } = mountCard(a);
    fireEvent.click(getByTestId("evidence-outputs-recover"));
    expect(getByTestId("evidence-outputs-recover").textContent).toBe("Retry report generation");
    expect(calls.recover).toEqual(["RETRY:report"]);
  });

  it("BLOCKED — a typed, safe explanation; no raw code, no storage detail", () => {
    const a = derive(STATES.BLOCKED)!;
    expect(a).toMatchObject({ state: "BLOCKED", severity: "CRITICAL" });
    const { getByTestId, container, calls } = mountCard(a);
    expect(getByTestId("evidence-outputs-badge").textContent).toBe("Action required");
    expect(container.textContent).toMatch(/This record needs review/);
    expect(container.textContent).not.toMatch(/REPORT_INTEGRITY|_MISMATCH|storage key|bucket|s3:/i);
    // The summary carries no support reference, so it never points at one.
    expect(container.textContent).toMatch(/Contact support\./);
    expect(container.textContent).not.toMatch(/reference below/);
    fireEvent.click(getByTestId("evidence-outputs-review"));
    expect(calls.open).toEqual(["recovery"]);
  });

  it("keyboard and names: one h2, every action a real button with a visible name", () => {
    for (const s of Object.values(STATES)) {
      const { container } = mountCard(derive(s)!);
      expect(container.querySelectorAll("h2")).toHaveLength(1);
      const card = container.querySelector("section")!;
      expect(card.getAttribute("aria-labelledby")).toBe(container.querySelector("h2")!.id);
      for (const b of container.querySelectorAll("button")) {
        expect(b.getAttribute("type")).toBe("button");
        expect((b.textContent ?? "").trim().length).toBeGreaterThan(0);
        expect(b.tabIndex).toBe(0);
      }
      // The card is not a live region: the banner (when any) is the one voice.
      expect(container.querySelector("[aria-live], [role='alert'], [role='status']")).toBeNull();
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. The Artifacts tab indicator, every state
// ---------------------------------------------------------------------------

describe("Artifacts tab indicator", () => {
  const EXPECTED: Record<string, string | undefined> = {
    CURRENT: undefined,
    UPDATE_AVAILABLE: "Artifacts — update available",
    IN_PROGRESS: "Artifacts — generation in progress",
    RECOVERY_AVAILABLE: "Artifacts — action required",
    BLOCKED: "Artifacts — action required",
  };
  for (const [name, s] of Object.entries(STATES)) {
    it(`${name}: the tab's accessible name and a non-colour indicator`, () => {
      const a = derive(s)!;
      const { container, getByRole } = render(
        <div role="tablist">
          <button type="button" role="tab" aria-selected={false} aria-label={outputAttentionTabName("Artifacts", a)}>
            Artifacts
            <OutputAttentionTabIndicator attention={a} />
          </button>
        </div>,
      );
      const tab = getByRole("tab");
      // Visible text stays the label; the name extends it (label-in-name).
      expect(tab.textContent).toBe("Artifacts");
      expect(tab.getAttribute("aria-label") ?? undefined).toBe(EXPECTED[name]);
      const indicator = container.querySelector("[data-testid='artifacts-tab-indicator']");
      if (EXPECTED[name] === undefined) {
        expect(indicator).toBeNull();
      } else {
        expect(indicator?.getAttribute("aria-hidden")).toBe("true");
        // Shape, not only colour: an icon is drawn.
        expect(indicator?.querySelector("svg")).not.toBeNull();
        expect(indicator?.getAttribute("data-output-attention")).toBe(name);
      }
      // No nested control inside the tab.
      expect(tab.querySelector("button, a, [role='button'], [tabindex]")).toBeNull();
    });
  }
  it("the indicator shape differs between update, progress and action required", () => {
    const shapes = ["UPDATE_AVAILABLE", "IN_PROGRESS", "RECOVERY_AVAILABLE", "BLOCKED"].map((k) => {
      const { container } = render(<OutputAttentionTabIndicator attention={derive(STATES[k])!} />);
      const svg = container.querySelector("svg")!.getAttribute("class");
      cleanup();
      return svg;
    });
    expect(new Set(shapes).size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 7. The banner: critical / action required only
// ---------------------------------------------------------------------------

describe("Page-level banner", () => {
  it("is absent for CURRENT, UPDATE_AVAILABLE and IN_PROGRESS", () => {
    for (const k of ["CURRENT", "UPDATE_AVAILABLE", "IN_PROGRESS"]) {
      const { container } = render(<EvidenceOutputAttentionBanner attention={derive(STATES[k])} onReview={() => {}} />);
      expect(container.innerHTML).toBe("");
      cleanup();
    }
  });

  it("states an incomplete package and lands on the recovery section", () => {
    const onReview = vi.fn();
    const { getByTestId } = render(<EvidenceOutputAttentionBanner attention={derive(STATES.RECOVERY_AVAILABLE)} onReview={onReview} />);
    const banner = getByTestId("output-attention-banner");
    expect(banner.textContent).toMatch(/Evidence output needs attention/);
    expect(banner.textContent).toMatch(/Verification package v1 could not be completed\./);
    expect(banner.getAttribute("role")).toBe("status");
    fireEvent.click(getByTestId("output-attention-banner-review"));
    expect(onReview).toHaveBeenCalledWith("recovery");
  });

  it("is danger-toned for a critical block, and silent where the record banner already speaks", () => {
    const { getByTestId } = render(<EvidenceOutputAttentionBanner attention={derive(STATES.BLOCKED)} onReview={() => {}} />);
    expect(getByTestId("output-attention-banner").getAttribute("data-banner-tone")).toBe("danger");
    cleanup();
    const integrity = derive(status({ report: out("NOT_APPLICABLE", "NONE", { notApplicableReason: "INTEGRITY_FAILED" }), latest: null }))!;
    expect(integrity).toMatchObject({ state: "BLOCKED", statedByRecordBanner: true });
    const { container } = render(<EvidenceOutputAttentionBanner attention={integrity} onReview={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("is not raised for a never-generated output (an offer, not an incident)", () => {
    const a = derive(status({ report: out("ELIGIBLE_NOT_GENERATED", "GENERATE", { version: null }), pkg: out("ELIGIBLE_NOT_GENERATED"), latest: null }))!;
    expect(a).toMatchObject({ state: "RECOVERY_AVAILABLE", action: "GENERATE" });
    expect(presentOutputAttention(a).banner).toBeNull();
    expect(presentOutputAttention(a).tab?.suffix).toBe("action required");
  });

  it("is raised when generation stalls (the page's stale stopwatch)", () => {
    const a = derive(STATES.IN_PROGRESS, { stalled: true })!;
    expect(a).toMatchObject({ state: "BLOCKED", code: "GENERATION_STALLED", focus: "progress" });
    expect(presentOutputAttention(a).banner?.focus).toBe("progress");
  });
});

// ---------------------------------------------------------------------------
// 8. Precedence and stale guard
// ---------------------------------------------------------------------------

describe("One deterministic answer", () => {
  it("BLOCKED > RECOVERY_AVAILABLE > IN_PROGRESS > UPDATE_AVAILABLE > CURRENT", () => {
    // Newer facts AND a live request: progress wins (no "update" badge mid-run).
    expect(derive(status({ freshness: NEWER, newVersion: OFFERED, activeRequest: active("PROCESSING", "RENDERING_REPORT") }))!.state).toBe("IN_PROGRESS");
    // A recoverable package AND newer facts: the recovery wins.
    expect(derive(status({ freshness: NEWER, newVersion: OFFERED, pkg: out("ELIGIBLE_NOT_GENERATED", "RECOVER"), latest: pair(1, false) }))!.state).toBe("RECOVERY_AVAILABLE");
    // A digest mismatch beats everything else on the record.
    const mismatch = { ...pair(1), digestMismatch: true };
    expect(derive(status({ freshness: NEWER, newVersion: OFFERED, latest: mismatch, pkg: out("ELIGIBLE_NOT_GENERATED", "RECOVER") }))).toMatchObject({ state: "BLOCKED", code: "PAIR_DIGEST_MISMATCH", focus: "history" });
    // A finished request does not read as a failure afterwards.
    expect(derive(status({ activeRequest: active("SUCCEEDED", "VERIFYING_PACKAGE") }))!.state).toBe("CURRENT");
  });

  it("a just-failed updated report offers the dialog again rather than a generic retry", () => {
    const a = derive(
      status({
        newVersion: OFFERED,
        activeRequest: active("FAILED_TERMINAL", "RENDERING_REPORT", { terminalReasonCode: "RENDER_TIMEOUT" }),
      }),
    )!;
    expect(a).toMatchObject({ state: "RECOVERY_AVAILABLE", target: "newVersion", action: "NEW_VERSION" });
    const { getByTestId } = mountCard(a);
    expect(getByTestId("evidence-outputs-recover").textContent).toBe("Try the updated report again");
  });

  it("13 — a status that belongs to another record is ignored (null), never painted", () => {
    expect(derive(STATES.RECOVERY_AVAILABLE, { statusEvidenceId: "ev-OTHER" })).toBeNull();
    expect(deriveEvidenceOutputAttention({ evidenceId: "ev-1", status: null })).toBeNull();
  });

  it("an older API (no freshness, no active request, no pairs) degrades without claims", () => {
    const s = status({ latest: null });
    s.outputs.freshness = undefined;
    s.outputs.activeRequest = undefined;
    s.versions = undefined;
    expect(derive(s)).toMatchObject({ state: "CURRENT", latestReportVersion: 1, factsCompared: false });
    const queued = status({ report: out("QUEUED", "NONE", { actionUnavailableReason: "IN_PROGRESS" }), latest: null });
    queued.outputs.activeRequest = undefined;
    expect(derive(queued)).toMatchObject({ state: "IN_PROGRESS", stage: "QUEUED", requestId: null });
  });
});

// ---------------------------------------------------------------------------
// 15. Mobile width, RTL, light-only: the stylesheet contract
// ---------------------------------------------------------------------------

describe("Layout contract", () => {
  const CSS = readFileSync(resolve(__dirname, "../../app/(app)/evidence/[id]/evidence-detail.css"), "utf8");
  const section = CSS.slice(CSS.indexOf("EVIDENCE OUTPUT ATTENTION (2026-10-06)"));

  it("uses logical properties only (RTL mirrors), wraps actions, and goes full-width at 320px", () => {
    expect(section).not.toMatch(/(?:^|[\s;{])(?:margin|padding|border)-(?:left|right)\s*:/m);
    expect(section).not.toMatch(/(?:^|[\s;{])(?:left|right)\s*:/m);
    expect(section).not.toMatch(/text-align:\s*(?:left|right)/);
    expect(section).toMatch(/\.rga-attention__actions \{ display: flex; flex-wrap: wrap;/);
    expect(section).toMatch(/@media \(max-width: 480px\)[\s\S]*\.rga-attention__actions > button \{ flex: 1 1 100%; \}/);
    expect(section).toMatch(/minmax\(min\(100%, 170px\), 1fr\)/);
    expect(section).not.toMatch(/animation|transition/);
  });

  it("reads the scoped light tokens, adds no colour literal, and has no theme branch", () => {
    expect(section).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(CSS).toMatch(/\.rga-history,\n\.rga-attention,\n\.rga-tab-indicator \{\n {2}--rga-ink:/);
    // The product is light-only: no theme attribute or OS colour-scheme
    // preference may switch these surfaces to a half-dark rendering.
    expect(CSS).not.toMatch(/\[data-theme=/);
    expect(CSS).not.toMatch(/prefers-color-scheme/);
  });
});
