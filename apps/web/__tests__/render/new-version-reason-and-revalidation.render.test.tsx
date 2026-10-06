/**
 * ARTIFACTS & VERSIONS — the updated-report dialog, durable progress, the truth
 * header and matched version history, rendered (jsdom). The real browser journey
 * against the real stack is `e2e/updated-report/updated-report-journey.spec.ts`;
 * these pin the component contracts that journey relies on.
 */
import React, { useState } from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { projectOutputProgress } from "@proovra/shared";

import { UpdatedReportDialog } from "../../components/evidence-outputs/UpdatedReportDialog";
import { OutputProgressCard } from "../../components/evidence-outputs/OutputProgressCard";
import { ArtifactTruthHeader } from "../../components/evidence-outputs/ArtifactTruthHeader";
import { MatchedVersionHistory } from "../../components/evidence-outputs/MatchedVersionHistory";
import type {
  ArtifactActiveRequest,
  MatchedHistory,
  NewVersionSubmitResult,
} from "../../components/evidence-outputs/artifact-status-types";

afterEach(() => cleanup());

const offerFor = (target: number, revision: string) => ({
  revision,
  createdAtUtc: "2026-10-06T10:00:00.000Z",
  expiresAtUtc: "2026-10-06T10:15:00.000Z",
  operation: "NEW_VERSION" as const,
  targetVersion: target,
  reasonRequired: true,
  creditEffect: { kind: "NONE" as const },
  storageEffect: { estimatedBytes: "2048", fitsStorage: true, storageBytesUsed: "4096", storageBytesLimit: "1073741824" },
});
const nv = (current: number, action = "CREATE_NEW_VERSION", reason: string | null = null) => ({
  action,
  reason,
  currentVersion: current,
  nextVersion: current + 1,
  estimate: null,
});
const freshness = {
  reportVersion: 1,
  reportGeneratedAtUtc: "2026-10-06T09:00:00.000Z",
  hasNewerFacts: true,
  changes: [
    { code: "TSA_VALIDATED_AFTER_REPORT" as const, atUtc: "2026-10-06T09:30:00.000Z" },
    { code: "OTS_ANCHORED_AFTER_REPORT" as const, atUtc: "2026-10-06T09:40:00.000Z" },
  ],
};

function Harness({
  statuses,
  submit,
}: {
  statuses: Array<unknown>;
  submit: (i: { clientRequestKey: string; reason: string; offerRevision: string | null }) => Promise<NewVersionSubmitResult>;
}) {
  const [open, setOpen] = useState(false);
  let i = 0;
  return (
    <>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
        Generate updated report
      </button>
      <UpdatedReportDialog
        open={open}
        onClose={() => setOpen(false)}
        initial={{ newVersion: nv(1), offer: offerFor(2, "ofr1.initial"), freshness }}
        loadStatus={async () => statuses[Math.min(i++, statuses.length - 1)] as never}
        submit={submit}
        onAccepted={() => {}}
      />
    </>
  );
}

async function openDialog(statuses: unknown[], submit: Parameters<typeof Harness>[0]["submit"]) {
  const view = render(<Harness statuses={statuses} submit={submit} />);
  const opener = view.getByTestId("opener");
  opener.focus();
  fireEvent.click(opener);
  const dialog = await waitFor(() => {
    const el = document.querySelector("[data-testid='updated-report-dialog']") as HTMLElement | null;
    expect(el).toBeTruthy();
    expect(el!.getAttribute("aria-busy")).toBeNull();
    return el!;
  });
  return { ...view, dialog, opener };
}
const q = (root: ParentNode, id: string) => root.querySelector(`[data-testid='${id}']`) as HTMLElement;
/** Wait until the element exists (waitFor only retries on a THROW). */
const present = (root: ParentNode, id: string) =>
  waitFor(() => {
    const el = q(root, id);
    expect(el).toBeTruthy();
    return el;
  });

describe("updated-report dialog — RGA-02 confirm-time revalidation, RGA-03 reason", () => {
  it("loads the current offer on open, lists the server's change summary and binds Confirm to the signed revision", async () => {
    const seen: string[] = [];
    const { dialog } = await openDialog(
      [{ outputs: { newVersion: nv(1), offer: offerFor(2, "ofr1.current"), freshness } }],
      async (i) => {
        seen.push(i.offerRevision ?? "");
        return { kind: "accepted", requestId: "req-1", message: "ok" };
      },
    );
    expect(dialog.textContent).toContain("Generate report v2");
    expect(q(dialog, "updated-report-changes").textContent).toContain("The trusted timestamp was validated after report v1 was generated.");
    expect(q(dialog, "updated-report-changes").textContent).toContain("The OpenTimestamps anchor was confirmed after report v1 was generated.");
    fireEvent.change(q(dialog, "updated-report-reason"), { target: { value: "Document the validated timestamp" } });
    fireEvent.click(q(dialog, "updated-report-confirm"));
    await waitFor(() => expect(seen).toEqual(["ofr1.current"]));
  });

  it("a STALE answer updates the dialog in place: says what changed, keeps the reason, re-reads the offer and needs a NEW confirmation with a NEW key", async () => {
    const keys: string[] = [];
    const revisions: string[] = [];
    let calls = 0;
    const { dialog } = await openDialog(
      [
        { outputs: { newVersion: nv(1), offer: offerFor(2, "ofr1.a"), freshness } },
        // After the refusal: a colleague issued v2; the offer is now v3.
        { outputs: { newVersion: nv(2), offer: offerFor(3, "ofr1.b"), freshness: { ...freshness, reportVersion: 2, hasNewerFacts: false, changes: [] } } },
      ],
      async (i) => {
        calls += 1;
        keys.push(i.clientRequestKey);
        revisions.push(i.offerRevision ?? "");
        return calls === 1
          ? { kind: "stale", changeMessages: ["A newer report version was completed."] }
          : { kind: "accepted", requestId: "req-2", message: "ok" };
      },
    );
    fireEvent.change(q(dialog, "updated-report-reason"), { target: { value: "Document the anchor" } });
    fireEvent.click(q(dialog, "updated-report-confirm"));
    const stale = await present(dialog, "updated-report-stale");
    expect(stale.getAttribute("role")).toBe("alert");
    expect(stale.textContent).toContain("A newer report version was completed.");
    expect(stale.textContent).toContain("Your reason has been kept.");
    await waitFor(() => expect(q(dialog, "updated-report-target").textContent).toBe("v3"));
    expect((q(dialog, "updated-report-reason") as HTMLTextAreaElement).value).toBe("Document the anchor");
    // Nothing was submitted a second time on its own.
    expect(calls).toBe(1);
    const confirm = q(dialog, "updated-report-confirm");
    expect(confirm.textContent).toBe("Confirm report v3");
    fireEvent.click(confirm);
    await waitFor(() => expect(calls).toBe(2));
    expect(revisions).toEqual(["ofr1.a", "ofr1.b"]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("an offer withdrawn while the dialog was open (permission removed) shows the typed reason and no Confirm", async () => {
    const { dialog } = await openDialog(
      [{ outputs: { newVersion: nv(1, "NONE", "PERMISSION_DENIED"), offer: null, freshness } }],
      async () => ({ kind: "accepted", requestId: null, message: "" }),
    );
    const w = q(dialog, "updated-report-withdrawn");
    expect(w.textContent).toContain("You don't have permission to do that");
    expect(q(dialog, "updated-report-confirm")).toBeNull();
  });

  it("whitespace / control-only reasons are refused with an accessible inline error; the counter is live", async () => {
    const { dialog } = await openDialog(
      [{ outputs: { newVersion: nv(1), offer: offerFor(2, "r"), freshness } }],
      async () => ({ kind: "accepted", requestId: null, message: "" }),
    );
    const reason = q(dialog, "updated-report-reason") as HTMLTextAreaElement;
    const confirm = q(dialog, "updated-report-confirm") as HTMLButtonElement;
    fireEvent.change(reason, { target: { value: "   \u0007​  " } });
    fireEvent.blur(reason);
    expect(confirm.disabled).toBe(true);
    expect(reason.getAttribute("aria-invalid")).toBe("true");
    const describedBy = reason.getAttribute("aria-describedby") ?? "";
    const errorId = describedBy.split(" ").find((id) => document.getElementById(id)?.getAttribute("role") === "alert");
    expect(errorId).toBeTruthy();
    expect(document.getElementById(errorId!)!.textContent).toBe("Say why an updated report is being issued.");
    fireEvent.change(reason, { target: { value: "  Valid   reason  " } });
    expect(q(dialog, "updated-report-count").textContent).toBe("12/120");
    expect(confirm.disabled).toBe(false);
    expect(reason.getAttribute("aria-invalid")).toBeNull();
  });

  it("a double-click submits once; an unanswered request keeps the key so a retry replays, an answered one clears it", async () => {
    const keys: string[] = [];
    let resolveFirst: (r: NewVersionSubmitResult) => void = () => {};
    let n = 0;
    const { dialog } = await openDialog(
      [{ outputs: { newVersion: nv(1), offer: offerFor(2, "r"), freshness } }],
      (i) => {
        keys.push(i.clientRequestKey);
        n += 1;
        if (n === 1) return new Promise((r) => (resolveFirst = r));
        if (n === 2) return Promise.resolve({ kind: "error", key: "RATE_LIMITED", title: "Too many requests", description: "Later.", answered: true });
        return Promise.resolve({ kind: "accepted", requestId: "x", message: "" });
      },
    );
    fireEvent.change(q(dialog, "updated-report-reason"), { target: { value: "Valid reason" } });
    const confirm = q(dialog, "updated-report-confirm") as HTMLButtonElement;
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(keys).toHaveLength(1);
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    await act(async () => resolveFirst({ kind: "error", key: "OFFER_LOAD_FAILED", title: "Network", description: "No answer.", answered: false }));
    await waitFor(() => expect(q(dialog, "updated-report-error").textContent).toContain("No answer."));
    expect((q(dialog, "updated-report-reason") as HTMLTextAreaElement).value).toBe("Valid reason");
    fireEvent.click(q(dialog, "updated-report-confirm"));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]); // unanswered → same key (server replays)
    await waitFor(() => expect(q(dialog, "updated-report-error").textContent).toContain("Later."));
    fireEvent.click(q(dialog, "updated-report-confirm"));
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(keys[2]).not.toBe(keys[1]); // answered → new key
  });

  it("focus: lands on the required reason, Tab is trapped, Escape closes and focus returns to the opener", async () => {
    const { dialog, opener } = await openDialog(
      [{ outputs: { newVersion: nv(1), offer: offerFor(2, "r"), freshness } }],
      async () => ({ kind: "accepted", requestId: null, message: "" }),
    );
    await waitFor(() => expect(document.activeElement).toBe(q(dialog, "updated-report-reason")));
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled]), textarea"));
    const last = focusables[focusables.length - 1]!;
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(focusables[0]);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.querySelector("[data-testid='updated-report-dialog']")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });
});

const activeRequest = (state: string, progressStage: string | null, stage: string | null, extra: Partial<ArtifactActiveRequest> = {}): ArtifactActiveRequest => ({
  requestId: "11111111-2222-4333-8444-555555555555",
  intent: "NEW_VERSION",
  artifactType: "REPORT",
  state,
  stage,
  progressStage,
  targetVersion: 2,
  terminalReasonCode: null,
  attemptCount: 1,
  createdAtUtc: "2026-10-06T10:00:00.000Z",
  updatedAtUtc: "2026-10-06T10:00:05.000Z",
  completedAtUtc: null,
  progress: projectOutputProgress({ state, stage, progressStage, artifactType: "REPORT" }),
  recent: true,
  ...extra,
});

describe("durable progress card", () => {
  it("renders the persisted step with an ARIA live region and aria-current", () => {
    const { getByTestId } = render(<OutputProgressCard request={activeRequest("PROCESSING", "VERIFYING_REPORT", "REPORT_RESERVED")} />);
    const card = getByTestId("output-progress");
    expect(card.getAttribute("data-output-progress-step")).toBe("VERIFYING_REPORT");
    expect(card.querySelector("[aria-current='step']")?.textContent).toContain("Verifying report");
    expect(card.querySelector("[role='status'][aria-live='polite']")?.textContent).toBe("Verifying report…");
    expect(card.textContent).toContain("Generating report v2");
    expect(card.querySelector("[data-testid='output-progress-error']")).toBeNull();
  });

  it("a failure names the step, the typed error, the server's action and the durable support reference", () => {
    const { getByTestId } = render(
      <OutputProgressCard
        request={activeRequest("FAILED_TERMINAL", "BUILDING_PACKAGE", "REPORT_COMMITTED", { terminalReasonCode: "ZIP_BUILD_FAILED" })}
        recoveryAction={<button type="button">Recover verification package</button>}
      />,
    );
    const card = getByTestId("output-progress");
    expect(card.getAttribute("data-output-progress-outcome")).toBe("FAILED");
    expect(getByTestId("output-progress-error").getAttribute("data-error-key")).toBe("PACKAGE_RENDER_FAILED");
    expect(getByTestId("output-progress-error").textContent).toContain("Recover verification package");
    expect(getByTestId("output-progress-ref").textContent).toBe("11111111-2222-4333-8444-555555555555");
    expect(card.textContent).not.toMatch(/stack|s3:|bucket/i);
  });

  it("complete only when the durable request SUCCEEDED", () => {
    const { getByTestId } = render(<OutputProgressCard request={activeRequest("SUCCEEDED", "VERIFYING_PACKAGE", "PACKAGE_PUBLISHED")} />);
    expect(getByTestId("output-progress").textContent).toContain("Report v2 and verification package v2 are ready");
  });
});

const history: MatchedHistory = {
  versions: [
    {
      reportVersion: 2, generatedAtUtc: "2026-10-06T11:00:00.000Z", sizeBytes: "200000", sha256: "b".repeat(64), immutableRecorded: false,
      issueKind: "UPDATED_REPORT", issueReason: "Document the validated timestamp", latest: true, digestMismatch: false,
      package: { version: 2, generatedAtUtc: "2026-10-06T11:00:10.000Z", sizeBytes: "900000", sha256: "d".repeat(64), embeddedReportSha256: "b".repeat(64), sealed: true, immutableRecorded: false, pairing: "REPORT_VERSION" },
    },
    {
      reportVersion: 1, generatedAtUtc: "2026-10-06T09:00:00.000Z", sizeBytes: "190000", sha256: "a".repeat(64), immutableRecorded: false,
      issueKind: "FIRST_ISSUE", issueReason: null, latest: false, digestMismatch: false,
      package: { version: 1, generatedAtUtc: "2026-10-06T09:00:10.000Z", sizeBytes: "880000", sha256: "c".repeat(64), embeddedReportSha256: "a".repeat(64), sealed: true, immutableRecorded: false, pairing: "REPORT_VERSION" },
    },
  ],
  unpairedPackages: [],
};
const fmt = (v: unknown) => String(v ?? "—");

describe("matched version history", () => {
  it("each row is ONE immutable pair; v2 is Latest, v1 stays independently downloadable", () => {
    const downloads: string[] = [];
    const { getByTestId } = render(
      <MatchedVersionHistory
        history={history}
        formatDateTime={fmt}
        formatBytes={fmt}
        onDownloadReportVersion={(v) => downloads.push(`report-v${v}`)}
        onDownloadPackageVersion={(v) => downloads.push(`package-v${v}`)}
      />,
    );
    expect(getByTestId("pair-2").getAttribute("data-pair-latest")).toBe("true");
    expect(getByTestId("pair-2").getAttribute("data-pair-package-version")).toBe("2");
    expect(getByTestId("pair-1").getAttribute("data-pair-latest")).toBe("false");
    expect(getByTestId("pair-1").getAttribute("data-pair-package-version")).toBe("1");
    expect(getByTestId("pair-2-package").textContent).toContain("Certifies report v2");
    expect(getByTestId("pair-1-package").textContent).toContain("Certifies report v1");
    expect(getByTestId("pair-2").textContent).toContain("Document the validated timestamp");
    for (const id of ["download-report-v1", "download-package-v1", "download-report-v2", "download-package-v2"]) {
      fireEvent.click(getByTestId(id));
    }
    expect(downloads).toEqual(["report-v1", "package-v1", "report-v2", "package-v2"]);
  });

  it("a version with no package says so and offers the server's recovery only on the latest — never a neighbour's package", () => {
    const missing: MatchedHistory = { versions: [{ ...history.versions[0]!, package: null }, history.versions[1]!], unpairedPackages: [] };
    const { getByTestId, queryByTestId } = render(
      <MatchedVersionHistory
        history={missing}
        formatDateTime={fmt}
        formatBytes={fmt}
        onDownloadReportVersion={() => {}}
        onDownloadPackageVersion={() => {}}
        latestPackageAction={<button type="button" data-testid="recover-latest">Recover verification package</button>}
      />,
    );
    expect(getByTestId("pair-2-package-missing").textContent).toContain("No verification package certifies report v2.");
    expect(getByTestId("recover-latest")).toBeTruthy();
    expect(queryByTestId("download-package-v2")).toBeNull();
    expect(getByTestId("pair-2").getAttribute("data-pair-package-version")).toBe("");
  });
});

describe("artifact truth header", () => {
  it("says 'New verification facts are available' only with server-derived changes", () => {
    const trust = {
      tsa: { status: "STAMPED", validated: true, validatedAtUtc: "2026-10-06T09:30:00.000Z", failureCode: null, genTimeUtc: null },
      ots: { status: "ANCHORED", anchorCheck: "PROOF_STRUCTURE", anchoredAtUtc: "2026-10-06T09:40:00.000Z" },
    };
    const { getByTestId, rerender, queryByTestId } = render(
      <ArtifactTruthHeader latest={history.versions[1]!} trust={trust} freshness={freshness} activeRequest={null} formatDateTime={fmt} formatBytes={fmt} actions={null} />,
    );
    expect(getByTestId("truth-freshness").textContent).toContain("New verification facts are available");
    expect(getByTestId("truth-tsa").textContent).toBe("Validated");
    expect(getByTestId("truth-ots").textContent).toBe("Anchored (chain not checked)");
    rerender(
      <ArtifactTruthHeader latest={history.versions[0]!} trust={trust} freshness={{ ...freshness, reportVersion: 2, hasNewerFacts: false, changes: [] }} activeRequest={null} formatDateTime={fmt} formatBytes={fmt} actions={null} />,
    );
    expect(queryByTestId("truth-freshness")).toBeNull();
    expect(getByTestId("truth-freshness-state").textContent).toBe("Current");
  });

  it("an unvalidated timestamp is never presented as validated", () => {
    const { getByTestId } = render(
      <ArtifactTruthHeader
        latest={history.versions[1]!}
        trust={{ tsa: { status: "FAILED", validated: false, validatedAtUtc: null, failureCode: "x", genTimeUtc: null }, ots: { status: "PENDING", anchorCheck: null, anchoredAtUtc: null } }}
        freshness={null}
        activeRequest={null}
        formatDateTime={fmt}
        formatBytes={fmt}
        actions={null}
      />,
    );
    expect(getByTestId("truth-tsa").textContent).toBe("Not validated");
    expect(getByTestId("truth-ots").textContent).toBe("Anchoring pending");
    expect(getByTestId("truth-freshness-state").textContent).toBe("Not available");
  });
});
