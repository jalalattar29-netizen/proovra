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
 *   - a resolved legacy workspace-wide row reads as HISTORY (never as a
 *     stall), keeps its conclusion, offers no repair, in en/de/ar;
 *   - remediation labels and guidance are localized, hrefs unchanged;
 *   - Arabic technical references stay LTR-isolated;
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

function mount(i: Incident, timeline: IncidentDetail["timeline"] = [], remediation: unknown = null) {
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
        remediation={remediation as never}
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

  it("a resolved legacy workspace-wide row reads as history: truthful label, its conclusion kept, no repair, the code only as a reference", () => {
    const LEGACY_GUIDANCE =
      "This is history recorded by an earlier version of Operations. There is nothing to repair here. Uploads are now checked one at a time, and a genuinely stalled upload appears as its own condition.";
    const conclusion = "Closed after review: the sessions belonged to records that had already finalized.";
    const { container } = mount(
      condition({
        status: "RESOLVED",
        resolvedAtUtc: new Date(NOW - 600_000).toISOString(),
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
      [{ id: "e2", eventType: "resolved", safeMessage: conclusion, occurredAtUtc: new Date(NOW - 600_000).toISOString() }],
      { disposition: "READ_ONLY_GUIDANCE", actions: [], deepLink: null, guidance: LEGACY_GUIDANCE, unsafeReason: null } as never,
    );
    // Never claims a stall happened.
    expect(container.querySelector("h2")!.textContent).toBe("Legacy upload-session signal");
    const text = sentences(container);
    expect(text).not.toContain("Upload appears stalled");
    expect(text).toMatch(/did not confirm that any upload was actually stalled/);
    // Resolved history, its conclusion preserved.
    expect(container.querySelector("[data-ops-status]")!.getAttribute("data-ops-status")).toBe("RESOLVED");
    expect(text).toContain(conclusion);
    // Nothing to repair and nowhere to go.
    expect(container.querySelector("[data-ops-remediation-link]")).toBeNull();
    expect(container.querySelectorAll(".opsw-remediation__action")).toHaveLength(0);
    expect(text).toContain("There is nothing to repair here.");
    // No internal language; the code only under Technical references.
    expect(text).toContain("Uploads in this workspace");
    expect(text).not.toMatch(/upload_stalled|Security signal|fields:|team 6488|Intake/);
    expect(container.querySelector("[data-ops-technical-references]")!.textContent).toContain("upload_stalled");
  });

  it("the legacy row and its guidance read in German and Arabic, Arabic right-to-left with LTR-isolated references", () => {
    const LEGACY_GUIDANCE =
      "This is history recorded by an earlier version of Operations. There is nothing to repair here. Uploads are now checked one at a time, and a genuinely stalled upload appears as its own condition.";
    const expected = {
      de: { title: "Älteres Upload-Sitzungssignal", guidance: "Hier ist nichts zu reparieren." },
      ar: { title: "إشارة قديمة لجلسة رفع", guidance: "لا يوجد ما يُصلح هنا." },
    } as const;
    for (const loc of ["de", "ar"] as const) {
      localeState.locale = loc;
      document.documentElement.setAttribute("dir", loc === "ar" ? "rtl" : "ltr");
      const { container, unmount } = mount(
        condition({
          status: "RESOLVED",
          message: { code: "ops.security.signal", params: { eventType: "upload_stalled", severity: "WARNING" }, titleSource: "CONDITION" },
          fingerprint: "upload:security_event:upload_stalled",
          relatedEvidenceId: null,
          subject: { kind: "UPLOADS", name: null, reference: null, version: null, state: "NOT_APPLICABLE" },
          technicalReferences: [{ key: "signalCode", value: "upload_stalled" }],
        }),
        [],
        { disposition: "READ_ONLY_GUIDANCE", actions: [], deepLink: null, guidance: LEGACY_GUIDANCE, unsafeReason: null } as never,
      );
      expect(container.querySelector("h2")!.textContent, loc).toBe(expected[loc].title);
      const text = sentences(container);
      expect(text, loc).toContain(expected[loc].guidance);
      expect(text, loc).not.toContain("There is nothing to repair here.");
      expect(text, loc).not.toMatch(/upload_stalled/);
      // A code inside an RTL page is isolated left-to-right so it is not
      // reordered or copied back-to-front.
      const code = container.querySelector("[data-ops-technical-references] code")!;
      expect(code.getAttribute("dir"), loc).toBe("ltr");
      expect(code.textContent, loc).toBe("upload_stalled");
      unmount();
    }
    document.documentElement.removeAttribute("dir");
  });

  it("an actionable condition's link label and guidance are localized; the href is unchanged", () => {
    const GUIDANCE =
      "No upload progress has been recorded for this record past the inactivity threshold. The person uploading can resume it; an upload that is not resumed is closed as abandoned. This closes on its own when the upload completes, is resumed or abandoned, or the record is finalized or deleted.";
    const rem = {
      disposition: "SAFE_DEEP_LINK",
      actions: [],
      deepLink: { href: `/evidence/${EVIDENCE}`, label: "Open the record", requiredPermission: "evidence.read", recordScoped: true },
      guidance: GUIDANCE,
      unsafeReason: null,
    } as never;
    const labels = { en: "Open the record", de: "Datensatz öffnen", ar: "فتح السجل" } as const;
    for (const loc of ["en", "de", "ar"] as const) {
      localeState.locale = loc;
      const { container, unmount } = mount(condition(), [], rem);
      const link = container.querySelector("[data-ops-remediation-link]") as HTMLAnchorElement;
      expect(link.textContent, loc).toBe(labels[loc]);
      expect(link.getAttribute("href"), loc).toBe(`/evidence/${EVIDENCE}`);
      if (loc !== "en") expect(sentences(container), loc).not.toContain(GUIDANCE);
      unmount();
    }
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
