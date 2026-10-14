/**
 * THE CONDITION DRAWER NAMES WHAT A CONDITION IS ABOUT — AND KEEPS CODES OUT
 * OF ITS SENTENCES (2026-10-14).
 *
 * The production drawer read "Security signal: upload_stalled" as its title,
 * "Severity WARNING · team 6488cb98… · fields: …" as its summary, and named no
 * record at all. Proven here, on the real drawer and the real row model:
 *
 *   - the title and summary are the catalogue's sentences in the reader's
 *     language; the signal code appears ONLY under Technical references;
 *   - the affected-record line is the server's subject (a named record links
 *     to it; a record that is gone reads as unavailable and is never linked);
 *   - the legacy workspace-wide row reads as uploads in this workspace;
 *   - a timeline entry with no sentence renders no text.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

const localeState = vi.hoisted(() => ({ locale: "en" as string }));
vi.mock("../../app/providers", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOptionalLocale: () => localeState.locale,
}));
vi.mock("../../lib/sentry", () => ({ captureException: () => {} }));

import { ConfirmActionProvider } from "../../components/ui/ConfirmActionModal";
import { IncidentInspector } from "../../app/(app)/operations/_components/IncidentInspector";
import { buildRowModel } from "../../app/(app)/operations/_lib/rowModel";
import type { Incident, IncidentDetail, OperationsCapabilities } from "../../app/(app)/operations/_lib/types";

const EVIDENCE = "9f1d2c3b-0000-4000-8000-000000000002";
const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const CAPS: OperationsCapabilities = {
  canAcknowledge: true,
  canResolve: true,
  canSuppress: true,
  canAssign: false,
  canManageSharedViews: false,
  canActOnAnything: true,
};

function condition(over: Partial<Incident> = {}): Incident {
  return {
    id: "c0000000-0000-4000-8000-000000000001",
    category: "UPLOAD",
    severity: "WARNING",
    status: "OPEN",
    title: "Upload appears stalled",
    safeSummary: "stored",
    message: {
      code: "ops.capture.upload_stalled",
      params: { recordTitle: "Site survey.mp4", recordRef: "9f1d2c3b", minutes: 90 },
      titleSource: "CONDITION",
    },
    fingerprint: `upload_stalled:${EVIDENCE}`,
    occurrenceCount: 1,
    firstSeenAtUtc: new Date(NOW - 2 * 3600_000).toISOString(),
    lastSeenAtUtc: new Date(NOW - 3600_000).toISOString(),
    requestId: null,
    traceId: null,
    relatedEvidenceId: EVIDENCE,
    relatedJobId: null,
    relatedProvider: null,
    runbookSlug: "stuck-upload",
    acknowledgedByUserId: null,
    resolvedByUserId: null,
    assignedOperatorUserId: null,
    assignedAtUtc: null,
    acknowledgedAtUtc: null,
    resolvedAtUtc: null,
    lifecycle: {
      sourceId: "capture.upload_stalled",
      sourceMatch: "DECLARED",
      resolutionAuthority: "SOURCE_TRUTH",
      audience: "TENANT_ACTIONABLE",
      cardinality: "PER_RECORD",
      recoveryPolicy: "PROBE_AUTO_RESOLVE",
      manualResolution: false,
    } as never,
    subject: { kind: "UPLOAD", name: "Site survey.mp4", reference: "9f1d2c3b", version: null, state: "AVAILABLE" },
    technicalReferences: [
      { key: "signalCode", value: "upload_stalled" },
      { key: "messageCode", value: "ops.capture.upload_stalled" },
      { key: "evidenceId", value: EVIDENCE },
    ],
    ...over,
  };
}

function mount(i: Incident, timeline: IncidentDetail["timeline"] = []) {
  const row = buildRowModel(i, {
    capabilities: CAPS,
    viewerUserId: null,
    operatorLabels: new Map(),
    now: NOW,
    locale: localeState.locale,
  });
  const detail = { kind: "ready" as const, data: { ...i, timeline, timelineComplete: true } as IncidentDetail };
  return render(
    <ConfirmActionProvider>
      <IncidentInspector
        row={row}
        detail={detail as never}
        capabilities={CAPS}
        showOwnership={false}
        operators={[]}
        selfUserId={null}
        onClose={() => {}}
        onAcknowledge={() => {}}
        onResolve={() => {}}
        onSuppress={() => {}}
        onAssign={() => {}}
        pending={false}
        remediation={null}
        remediationBusy={null}
        remediationOutcome={null}
        onRemediate={() => {}}
      />
    </ConfirmActionProvider>,
  );
}

/** Text OUTSIDE the Technical references section. */
function sentences(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[data-ops-technical-references]").forEach((n) => n.remove());
  return clone.textContent ?? "";
}

afterEach(() => {
  cleanup();
  localeState.locale = "en";
});

describe("the condition drawer", () => {
  it("names the record, links it, and keeps the signal code under Technical references only", () => {
    const { container } = mount(condition());
    const head = container.querySelector("h2")!;
    expect(head.textContent).toBe("Upload appears stalled");
    const text = sentences(container);
    expect(text).toContain("Upload: Site survey.mp4");
    expect(text).not.toMatch(/upload_stalled|Security signal|fields:|ops\.capture/);
    const link = container.querySelector("[data-ops-affected-link]") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(`/evidence/${EVIDENCE}`);

    const refs = container.querySelector("[data-ops-technical-references]")!;
    expect(refs.textContent).toContain("Signal code");
    expect(refs.textContent).toContain("upload_stalled");
  });

  it("a record that is gone reads as unavailable and is never linked", () => {
    const { container } = mount(
      condition({ subject: { kind: "UPLOAD", name: null, reference: "9f1d2c3b", version: null, state: "UNAVAILABLE" } }),
    );
    expect(container.querySelector("[data-ops-affected-link]")).toBeNull();
    expect(sentences(container)).not.toContain("Site survey.mp4.");
  });

  it("the legacy workspace-wide row reads as uploads in this workspace, never its code", () => {
    const { container } = mount(
      condition({
        title: "Security signal: upload_stalled",
        safeSummary: "Severity WARNING · team 6488cb98… · fields: stalledThresholdMinutes, previousStatus",
        message: { code: "ops.security.signal", params: { eventType: "upload_stalled", severity: "WARNING" }, titleSource: "CONDITION" },
        fingerprint: "upload:security_event:upload_stalled",
        relatedEvidenceId: null,
        occurrenceCount: 4,
        lifecycle: {
          sourceId: "intake.delivery_failed",
          sourceMatch: "DECLARED",
          resolutionAuthority: "OPERATOR_DECISION",
          audience: "TENANT_ACTIONABLE",
          cardinality: "EVENT",
          recoveryPolicy: "OPERATOR_CLOSES",
          manualResolution: true,
        } as never,
        subject: { kind: "UPLOADS", name: null, reference: null, version: null, state: "NOT_APPLICABLE" },
        technicalReferences: [{ key: "signalCode", value: "upload_stalled" }],
      }),
    );
    expect(container.querySelector("h2")!.textContent).toBe("Upload appears stalled");
    const text = sentences(container);
    expect(text).toContain("Uploads in this workspace");
    expect(text).not.toMatch(/upload_stalled|Security signal|fields:|team 6488|Intake/);
    expect(text).toContain("Occurred 4 times");
  });

  it("German and Arabic readers get their own sentences, with the code still only a reference", () => {
    for (const loc of ["de", "ar"]) {
      localeState.locale = loc;
      const { container, unmount } = mount(condition());
      const text = sentences(container);
      expect(text, loc).not.toMatch(/upload_stalled|Upload appears stalled/);
      expect(container.querySelector("[data-ops-technical-references]")!.textContent, loc).toContain("upload_stalled");
      unmount();
    }
  });

  it("a timeline entry with no sentence renders no text", () => {
    const { container } = mount(condition(), [
      { id: "e1", eventType: "opened", safeMessage: null, occurredAtUtc: new Date(NOW - 3600_000).toISOString() },
    ]);
    const msg = container.querySelector(".opsw-timeline__message")!;
    expect(msg.textContent).toBe("");
    expect(sentences(container)).not.toMatch(/Severity WARNING/);
  });
});
