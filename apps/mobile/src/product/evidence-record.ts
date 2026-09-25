/**
 * EVIDENCE RECORD — the review-workspace facts the web Evidence Detail page
 * renders around its tabs, projected for native. Pure: no React, no fetch.
 *
 * Every field is read from GET /v1/evidence/:id/review-workspace
 * (services/api/src/routes/evidence.routes.ts:9558-9900) or from the record's
 * own GET /v1/evidence/:id. Nothing here is derived locally that the server
 * already decided; the copy is the web's, cited per block.
 */

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const n = (v: unknown): number | null => {
  const x = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof x === "number" && Number.isFinite(x) ? x : null;
};

const humanize = (v: string): string => v.replace(/_/g, " ");

/* ------------------------------------------------------------------ helpers */

/** `lib/short-id.ts` — the first 8 characters, the one authority on the web. */
export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "";
}

/** `_lib.tsx:192` formatBytes — "Not recorded" when absent. */
export function formatBytes(sizeBytes: string | number | null | undefined): string {
  const numeric = typeof sizeBytes === "number" ? sizeBytes : typeof sizeBytes === "string" ? Number(sizeBytes) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return "Not recorded";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = numeric;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

/* --------------------------------------------------------- integrity banner */

/** page.tsx:832 — the record's own status. */
export function isIntegrityFailed(status: string | null | undefined): boolean {
  return status === "FAILED_HASH_MISMATCH";
}

/** page.tsx:1035-1043, verbatim. */
export const INTEGRITY_FAILED_COPY = {
  title: "Integrity check failed",
  body:
    "The uploaded file’s SHA-256 does not match the recomputed server-side fingerprint. This evidence record cannot be used. Re-upload or recapture the source material as a new evidence record. The original record is preserved for forensic inspection.",
} as const;

/* ------------------------------------------------------------- record facts */

export interface RecordView {
  id: string | null;
  status: string | null;
  title: string | null;
  typeLabel: string | null;
  legalBoundary: string | null;
  itemCount: number;
  multipart: boolean;
  relationshipsNote: string | null;
  caseId: string | null;
  caseName: string | null;
  workspaceName: string | null;
  createdAt: string | null;
  capturedAtUtc: string | null;
  mimeType: string | null;
  sizeBytes: string | null;
  originalFileName: string | null;
  displayFileName: string | null;
  internalNotes: string | null;
  nextActions: string[];
  lockedAt: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
  deleteScheduledForUtc: string | null;
  retentionUntilUtc: string | null;
  storageObjectLockMode: string | null;
  storageObjectLockRetainUntilUtc: string | null;
  storageObjectLockLegalHoldStatus: string | null;
  workflow: {
    status: string | null;
    priority: string | null;
    dueAt: string | null;
    teamId: string | null;
  };
  /** `governance.*.label` (review-workspace), for the private-notes note. */
  governanceLabels: { reviewerComments: string; legalNotes: string; annotations: string } | null;
}

export function projectRecord(rw: unknown): RecordView {
  const root = o(rw);
  const ev = o(root["evidence"]);
  const rel = o(root["relationships"]);
  const cls = o(root["classification"]);
  const caps = o(root["workspaceCapabilitySnapshot"]);
  const wf = o(root["reviewWorkflow"]);
  const decision = o(root["reviewDecision"]);
  const gov = root["governance"] && typeof root["governance"] === "object" ? o(root["governance"]) : null;
  const govLabel = (k: string) => s(o(gov?.[k])["label"]);
  const itemCount = n(rel["itemCount"]) ?? n(ev["itemCount"]) ?? 1;
  return {
    id: s(ev["id"]),
    status: s(ev["status"]),
    title: s(ev["displayTitle"]) ?? s(ev["title"]),
    typeLabel: s(cls["evidenceTypeLabel"]),
    legalBoundary: s(root["legalBoundary"]),
    itemCount,
    multipart: rel["multipart"] === true,
    relationshipsNote: s(rel["note"]),
    caseId: s(rel["caseId"]),
    caseName: s(rel["caseName"]),
    workspaceName: s(caps["workspaceName"]),
    createdAt: s(ev["createdAt"]),
    capturedAtUtc: s(ev["capturedAtUtc"]),
    mimeType: s(ev["mimeType"]),
    sizeBytes: typeof ev["sizeBytes"] === "number" ? String(ev["sizeBytes"]) : s(ev["sizeBytes"]),
    originalFileName: s(ev["originalFileName"]),
    displayFileName: s(ev["displayFileName"]),
    internalNotes: s(ev["internalNotes"]),
    nextActions: arr(decision["nextActions"]).filter((x): x is string => typeof x === "string" && x.length > 0),
    lockedAt: s(ev["lockedAt"]),
    archivedAt: s(ev["archivedAt"]),
    deletedAt: s(ev["deletedAt"]),
    deleteScheduledForUtc: s(ev["deleteScheduledForUtc"]),
    retentionUntilUtc: s(ev["retentionUntilUtc"]),
    storageObjectLockMode: s(ev["storageObjectLockMode"]),
    storageObjectLockRetainUntilUtc: s(ev["storageObjectLockRetainUntilUtc"]),
    storageObjectLockLegalHoldStatus: s(ev["storageObjectLockLegalHoldStatus"]),
    workflow: {
      status: s(wf["status"]),
      priority: s(wf["priority"]),
      dueAt: s(wf["dueAt"]),
      teamId: s(wf["teamId"]),
    },
    governanceLabels:
      gov && govLabel("reviewerComments") && govLabel("legalNotes") && govLabel("annotations")
        ? {
            reviewerComments: govLabel("reviewerComments") as string,
            legalNotes: govLabel("legalNotes") as string,
            annotations: govLabel("annotations") as string,
          }
        : null,
  };
}

/** page.tsx:1178-1180 — the identity line's item count. */
export function itemCountLabel(r: Pick<RecordView, "multipart" | "itemCount">): string {
  return r.multipart ? `${r.itemCount} items` : "Single item";
}

/** page.tsx:387-413 — the Overview "Record Summary" items, in the web's order. */
export function recordSummaryItems(r: RecordView, fmt: (iso: string) => string): Array<{ label: string; value: string }> {
  return [
    { label: "Created", value: r.createdAt ? fmt(r.createdAt) : "Not recorded" },
    { label: "Captured", value: r.capturedAtUtc ? fmt(r.capturedAtUtc) : "Not recorded" },
    { label: "MIME type", value: r.mimeType || "Not recorded" },
    { label: "File size", value: formatBytes(r.sizeBytes) },
    { label: "Workspace", value: r.workspaceName || "Not recorded" },
    { label: "Case", value: r.caseName || "Unassigned" },
    { label: "Review workflow", value: r.workflow.status ? humanize(r.workflow.status) : "Not started" },
    { label: "Original filename", value: r.originalFileName || r.displayFileName || "Not recorded" },
  ];
}

/* ---------------------------------------------------- public verification */

export interface PublicVerificationView {
  state: string | null;
  sharePath: string | null;
  disabledReason: string | null;
  analyticsAvailable: boolean;
  publicViewCount: number;
  reportDownloadCount: number;
  verificationPackageDownloadCount: number;
  lastPublicViewAt: string | null;
}

export function projectPublicVerification(rw: unknown): PublicVerificationView | null {
  const pv = o(o(rw)["publicVerificationSummary"]);
  if (Object.keys(pv).length === 0) return null;
  return {
    state: s(pv["state"]),
    sharePath: s(pv["sharePath"]),
    disabledReason: s(pv["disabledReason"]),
    analyticsAvailable: pv["analyticsAvailable"] === true,
    publicViewCount: n(pv["publicViewCount"]) ?? 0,
    reportDownloadCount: n(pv["reportDownloadCount"]) ?? 0,
    verificationPackageDownloadCount: n(pv["verificationPackageDownloadCount"]) ?? 0,
    lastPublicViewAt: s(pv["lastPublicViewAt"]),
  };
}

/** `_lib.tsx:334` describePublicVerificationState, verbatim. */
export function describePublicVerificationState(pv: PublicVerificationView | null): { label: string; detail: string } {
  const reason = pv?.disabledReason ?? null;
  switch (pv?.state) {
    case "NOT_INCLUDED":
      return { label: "Not included on plan", detail: reason || "Public verification is not included in the current workspace capability set." };
    case "NOT_CONFIGURED":
      return {
        label: "Not configured",
        detail:
          reason ||
          "Public verification is supported for this workspace, but this evidence record does not have a publishable verification surface configured.",
      };
    case "CONFIGURED_NOT_PUBLISHED":
      return { label: "Configured but not published", detail: reason || "Public verification is configured for this evidence record, but it has not been published yet." };
    case "PUBLISHED":
      return { label: "Published", detail: "Public verification is published and the public route should resolve." };
    case "SUSPENDED":
      return { label: "Suspended", detail: reason || "Public verification was suspended and the public route is intentionally unavailable." };
    case "UNPUBLISHED":
      return { label: "Unpublished", detail: reason || "Public verification was unpublished and no public verification link is currently active." };
    default:
      return { label: "State unavailable", detail: reason || "The publication state could not be resolved from the current evidence record." };
  }
}

/**
 * `_lib.tsx:327` buildPublishedVerificationUrl — ONLY a PUBLISHED summary has
 * a link, and it is the server's `sharePath` on the public web origin. Never
 * synthesised: no origin configured, or no path, means no link.
 */
export function buildPublishedVerificationUrl(pv: PublicVerificationView | null, origin: string | null): string | null {
  if (!pv || pv.state !== "PUBLISHED" || !pv.sharePath || !origin) return null;
  const base = origin.replace(/\/+$/, "");
  return `${base}${pv.sharePath.startsWith("/") ? pv.sharePath : `/${pv.sharePath}`}`;
}

/** EvidenceArtifactsTab.tsx:503 — a counter is a number only when analytics exist. */
export function publicVerificationCounter(pv: PublicVerificationView, value: number): string {
  return pv.analyticsAvailable ? String(value) : "Not available";
}

/** `_lib.tsx:1444` getPublicVerificationTone → native tones. */
export function publicVerificationTone(state: string | null): "verified" | "risk" | "pending" | "neutral" {
  switch (state) {
    case "PUBLISHED":
      return "verified";
    case "SUSPENDED":
      return "risk";
    case "CONFIGURED_NOT_PUBLISHED":
    case "UNPUBLISHED":
      return "pending";
    default:
      return "neutral";
  }
}

/* ---------------------------------------------------------------- workflow */

/** `lib/reviewer-status.ts:23` REVIEWER_STATUS_LABEL, verbatim. */
export const REVIEWER_STATUS_LABEL: Readonly<Record<string, string>> = {
  NOT_STARTED: "Needs review",
  IN_REVIEW: "In review",
  NEEDS_INFO: "Needs additional context",
  READY_FOR_EXTERNAL_REVIEW: "Ready for external review",
  APPROVED_INTERNAL: "Accepted for internal review",
  REJECTED_INSUFFICIENT: "Rejected as insufficient",
  ESCALATED: "Escalated for further review",
  CLOSED: "Not accepted",
};

export function formatReviewerStatusLabel(status: string | null | undefined): string {
  if (!status) return REVIEWER_STATUS_LABEL.NOT_STARTED as string;
  return REVIEWER_STATUS_LABEL[status] ?? (REVIEWER_STATUS_LABEL.NOT_STARTED as string);
}

/** `lib/reviewer-status.ts:111`, verbatim. */
export const REVIEWER_STATUS_DISCLAIMER =
  "Reviewer status is an internal workflow marker. It does not change integrity results, public verification, authenticity, legal admissibility, or factual truth.";

/** `_lib.tsx:1410` getWorkflowStatusTone → native tones. */
export function workflowStatusTone(status: string | null | undefined): "verified" | "risk" | "info" | "pending" | "neutral" {
  switch ((status ?? "").toUpperCase()) {
    case "APPROVED":
    case "COMPLETED":
      return "verified";
    case "REJECTED":
      return "risk";
    case "IN_REVIEW":
    case "ASSIGNED":
      return "info";
    case "CHANGES_REQUESTED":
      return "pending";
    default:
      return "neutral";
  }
}

/** `_lib.tsx:1427` getPriorityTone → native tones. */
export function priorityTone(priority: string | null | undefined): "risk" | "pending" | "info" | "neutral" {
  switch ((priority ?? "").toUpperCase()) {
    case "URGENT":
    case "CRITICAL":
      return "risk";
    case "HIGH":
      return "pending";
    case "NORMAL":
    case "MEDIUM":
      return "info";
    default:
      return "neutral";
  }
}

/* ------------------------------------------------------ lifecycle dialogs */

/** page.tsx:1658-1851 — the web's four lifecycle confirmations, verbatim. */
export const LIFECYCLE_DIALOG_COPY = {
  lock: {
    title: "Lock evidence record",
    body: "Locking preserves the current record state and prevents further mutable updates to this evidence record.",
    confirm: "Confirm lock",
  },
  unlock: {
    title: "Unlock evidence record",
    body: "Unlocking allows permitted workspace users to make mutable updates again. The unlock action is recorded in the audit trail.",
    note: "Unlocking does not change retention, legal hold, Object Lock, generated reports, verification packages, or the custody chain.",
    reasonLabel: "Reason for unlocking (optional)",
    reasonPlaceholder: "e.g. correcting label after upload",
    confirm: "Confirm unlock",
  },
  archive: {
    title: "Archive evidence record",
    body: "Archive removes this record from Active evidence while preserving it under retention and keeping verification materials available.",
    confirm: "Archive evidence",
  },
  restore: {
    title: "Restore archived evidence",
    body: "Restoring returns this record to Active evidence. Retention and verification history remain unchanged.",
    confirm: "Restore evidence",
  },
} as const;

/** The unlock route's body (`z.object({ reason: z.string().trim().max(500).optional() })`, evidence.routes.ts:6510). */
export const UNLOCK_REASON_MAX = 500;
export function buildUnlockBody(reason: string): { reason?: string } {
  const r = reason.trim().slice(0, UNLOCK_REASON_MAX);
  return r.length > 0 ? { reason: r } : {};
}

/* --------------------------------------------------------- output states */

export type OutputState =
  | "READY"
  | "NOT_INCLUDED"
  | "NOT_APPLICABLE"
  | "ELIGIBLE_NOT_GENERATED"
  | "QUEUED"
  | "GENERATING"
  | "RETRYABLE_FAILURE"
  | "TERMINAL_FAILURE"
  | "BLOCKED";

const OUTPUT_STATES: readonly OutputState[] = [
  "READY",
  "NOT_INCLUDED",
  "NOT_APPLICABLE",
  "ELIGIBLE_NOT_GENERATED",
  "QUEUED",
  "GENERATING",
  "RETRYABLE_FAILURE",
  "TERMINAL_FAILURE",
  "BLOCKED",
];

export interface OutputView {
  state: OutputState | null;
  /** The server's verb: GENERATE | RETRY | REGENERATE | NONE. Absent reads as NONE. */
  action: string;
  terminalReasonClass: string | null;
  notApplicableReason: string | null;
  actionUnavailableReason: string | null;
  attemptCount: number | null;
}

export interface ArtifactOutputs {
  report: OutputView;
  package: OutputView;
  reportAvailable: boolean;
  packageAvailable: boolean;
  packageBlocked: boolean;
  packageBlockedReason: string | null;
}

function outputView(raw: unknown): OutputView {
  const x = o(raw);
  const st = s(x["state"]);
  return {
    state: st && (OUTPUT_STATES as readonly string[]).includes(st) ? (st as OutputState) : null,
    action: s(x["action"]) ?? "NONE",
    terminalReasonClass: s(x["terminalReasonClass"]),
    notApplicableReason: s(x["notApplicableReason"]),
    actionUnavailableReason: s(x["actionUnavailableReason"]),
    attemptCount: n(x["attemptCount"]),
  };
}

/**
 * The canonical artifact status — GET /v1/evidence/:id/artifacts/status
 * (evidence.routes.ts:10628, `buildEvidenceArtifactStatus`) and the identical
 * `artifactStatus` block on the review workspace. `outputs.*` decides state
 * and verb; the legacy `available` booleans decide whether a download exists.
 */
export function projectArtifactOutputs(payload: unknown): ArtifactOutputs {
  const st = o(payload);
  const outputs = o(st["outputs"]);
  const report = outputView(outputs["report"]);
  const pkg = outputView(outputs["verificationPackage"]);
  const legacyPkg = o(st["verificationPackage"]);
  return {
    report,
    package: pkg,
    // A READY state IS an existing artifact; the legacy boolean agrees with it
    // server-side and is read first when present.
    reportAvailable: o(st["report"])["available"] === true || report.state === "READY",
    packageAvailable: legacyPkg["available"] === true || pkg.state === "READY",
    packageBlocked: legacyPkg["blocked"] === true,
    packageBlockedReason: s(legacyPkg["blockedReason"]),
  };
}

/** `_lib.tsx:433` OUTPUT_STATE_COPY — why a download is unavailable, by state. */
export function outputStateReason(state: OutputState | null, noun: string): string {
  switch (state) {
    case "READY":
      return "";
    case "NOT_INCLUDED":
      return `A ${noun} is not included for this evidence record.`;
    case "NOT_APPLICABLE":
      return `A ${noun} is not available for this record in its current state.`;
    case "ELIGIBLE_NOT_GENERATED":
      return `No ${noun} has been generated for this record yet. Generate one to download it.`;
    case "QUEUED":
      return `The ${noun} is queued for generation. Re-check shortly.`;
    case "GENERATING":
      return `The ${noun} is being generated. Re-check status once it completes.`;
    case "RETRYABLE_FAILURE":
      return `The last attempt to build the ${noun} failed.`;
    case "TERMINAL_FAILURE":
      return `The ${noun} could not be produced for this record.`;
    case "BLOCKED":
      return `${noun} generation is blocked by a policy decision.`;
    default:
      return `The ${noun} status is unavailable right now.`;
  }
}

/** `_lib.tsx:476` OUTPUT_STATE_LABEL. */
export function outputStateLabel(state: OutputState | null): string {
  switch (state) {
    case "READY":
      return "Available";
    case "QUEUED":
      return "Queued";
    case "GENERATING":
      return "Generating";
    case "ELIGIBLE_NOT_GENERATED":
      return "Not generated yet";
    case "RETRYABLE_FAILURE":
      return "Generation failed";
    case "TERMINAL_FAILURE":
      return "Generation stopped";
    case "BLOCKED":
      return "Blocked";
    case "NOT_INCLUDED":
      return "Not included for this record";
    case "NOT_APPLICABLE":
      return "Not available for this record";
    default:
      return "State unavailable";
  }
}

/** EvidenceArtifactsTab.tsx:55 terminalFailureCopy, verbatim. */
export function terminalFailureCopy(reasonClass: string | null): string {
  switch (reasonClass) {
    case "COMMERCIAL":
      return "The attempt ran while this record was not entitled to the output. Your current plan includes it, so it can be generated now.";
    case "INTEGRITY":
      return "This record cannot produce a truthful artifact — its recorded integrity state does not permit it. The record itself is preserved; re-capture the source material as a new record if a fixed artifact is required.";
    case "POLICY":
      return "A governance policy refused the generation. It becomes possible again when that policy decision changes.";
    default:
      return "The pipeline could not produce it and has stopped retrying. Support can investigate; the evidence record and its integrity state are unaffected.";
  }
}

export const WORKSPACE_UNRESOLVED_NOTE =
  "This older record needs a workspace association before a new report or verification package can be requested. Everything already generated for it stays available.";

/**
 * EvidenceArtifactsTab.tsx:228-450 — the lifecycle panel's title and body for
 * each state, verbatim. `null` for READY (a downloadable artifact is not a
 * status message) and for an unreadable state.
 */
export function outputPanelCopy(out: OutputView): { title: string; body: string; tone: "warn" | "info" } | null {
  switch (out.state) {
    case "NOT_APPLICABLE":
      return out.notApplicableReason === "INTEGRITY_FAILED"
        ? {
            title: "Outputs cannot be produced for this record",
            body:
              "This record did not pass its integrity check: the fingerprint recomputed from the stored bytes did not match the value recorded when it was completed. A report and verification package can only be produced from a record whose integrity is intact, so none will be generated for this one. The record itself is preserved exactly as received, for inspection. To capture this material as evidence, re-upload or re-capture it as a new record.",
            tone: "warn",
          }
        : {
            title: "Outputs become available once this record is finalized",
            body:
              "A report and verification package are produced from a finalized record — its fingerprint, signature and chain of custody. This record has not reached that point yet, so there is nothing to generate from and no action to take.",
            tone: "info",
          };
    case "NOT_INCLUDED":
      return {
        title: "Reports are not included for this record",
        body:
          "Report PDFs and verification packages are included with Pay-per-evidence credits and with the Pro, Team and Enterprise plans. Your evidence record itself is signed and preserved — the chain of custody is intact, and public verification still works — but no downloadable report artifact is produced for it.",
        tone: "warn",
      };
    case "ELIGIBLE_NOT_GENERATED":
      return {
        title: "Your current plan includes a report and verification package for this record",
        body:
          "Nothing has been generated for it yet — records captured before this entitlement applied are not produced automatically. Generating uses no evidence credit; it does use workspace storage.",
        tone: "info",
      };
    case "QUEUED":
      return {
        title: "Report and verification package are queued for generation",
        body: "Work has been accepted and is waiting for a worker. This page checks for completion on its own; nothing further is needed from you.",
        tone: "info",
      };
    case "GENERATING":
      return {
        title: "Generating report and verification package…",
        body: "Both artifacts are produced by one job. They will appear below when it completes.",
        tone: "info",
      };
    case "RETRYABLE_FAILURE":
      return {
        title: "Report generation failed",
        body: `The last attempt did not complete${out.attemptCount ? ` (attempt ${out.attemptCount})` : ""}. The evidence record and its integrity state are unaffected.`,
        tone: "warn",
      };
    case "TERMINAL_FAILURE":
      return { title: "Report generation stopped", body: terminalFailureCopy(out.terminalReasonClass), tone: "warn" };
    case "BLOCKED":
      return {
        title: "Report generation is blocked",
        body:
          "A governance or lifecycle decision is currently preventing generation for this record. It becomes possible again when that decision changes; the evidence record and its integrity state are unaffected.",
        tone: "warn",
      };
    default:
      return null;
  }
}

/** Which states carry the action inside their panel (EvidenceArtifactsTab.tsx). */
export function outputPanelShowsAction(state: OutputState | null): boolean {
  return (
    state === "ELIGIBLE_NOT_GENERATED" ||
    state === "RETRYABLE_FAILURE" ||
    state === "TERMINAL_FAILURE" ||
    state === "BLOCKED" ||
    state === "READY"
  );
}

/* ------------------------------------------- Verification & Preservation */

export type IntegrityState = "verified" | "recorded" | "available" | "pending" | "unavailable" | "failed" | "not-applicable";

/** EvidenceIntegrityTab.tsx:88 STATE_PRESENTATION, with native tones. */
export const INTEGRITY_STATE_PRESENTATION: Readonly<
  Record<IntegrityState, { label: string; tone: "verified" | "info" | "governance" | "pending" | "neutral" | "risk" }>
> = {
  verified: { label: "Verified", tone: "verified" },
  recorded: { label: "Recorded", tone: "info" },
  available: { label: "Available", tone: "governance" },
  pending: { label: "Pending", tone: "pending" },
  unavailable: { label: "Unavailable", tone: "neutral" },
  failed: { label: "Failed", tone: "risk" },
  "not-applicable": { label: "Not applicable", tone: "neutral" },
};

export interface MatrixRow {
  label: string;
  value: string;
  state?: IntegrityState;
  wide?: boolean;
}

/** `_lib.tsx:544` describeOtsStatus, verbatim. */
export function describeOtsStatus(ots: { effectiveStatus: string | null; failureReason: string | null; pendingReason: string | null }): { label: string; detail: string } {
  switch (ots.effectiveStatus) {
    case "ANCHORED":
      return { label: "Anchored", detail: "OpenTimestamps anchoring is recorded for this evidence item." };
    case "FAILED":
      return { label: "Failed", detail: ots.failureReason || "OpenTimestamps anchoring failed for this evidence item." };
    case "DISABLED":
      return { label: "Disabled", detail: "OpenTimestamps anchoring is disabled for this evidence item." };
    case "PENDING":
      return {
        label: "Pending public anchoring",
        detail: ots.pendingReason || "OpenTimestamps proof is recorded, but public anchoring has not finalized yet.",
      };
    default:
      return {
        label: "Not yet anchored",
        detail:
          "OpenTimestamps anchoring has not started for this evidence item yet. It is part of the integrity layer on every plan and does not depend on reports or verification packages.",
      };
  }
}

/** `_lib.tsx:600` isOtsTerminal — the manual re-check is offered while the anchor can move. */
export function isOtsTerminal(status: string | null | undefined): boolean {
  return status === null || status === undefined || status === "ANCHORED" || status === "FAILED" || status === "DISABLED";
}

export function projectOtsEffectiveStatus(rw: unknown): string | null {
  return s(o(o(o(rw)["preservationMatrix"])["ots"])["effectiveStatus"]);
}

/** EvidenceIntegrityTab.tsx:237-628 — the matrix, every row from the field its value is read from. */
export function buildPreservationMatrix(rw: unknown, fmt: (iso: string) => string): MatrixRow[] {
  const root = o(rw);
  const pm = o(root["preservationMatrix"]);
  if (Object.keys(pm).length === 0) return [];
  const ev = o(root["evidence"]);
  const caps = o(root["workspaceCapabilitySnapshot"]);
  const packageIncluded = caps["verificationPackageIncluded"] === true;
  const art = o(root["artifactStatus"]);
  const aReport = o(art["report"]);
  const aPkg = o(art["verificationPackage"]);
  const outputs = projectArtifactOutputs(art);
  const pmReport = o(pm["report"]);
  const pmPkg = o(pm["verificationPackage"]);
  const sig = o(pm["signature"]);
  const tsa = o(pm["tsa"]);
  const ots = o(pm["ots"]);
  const storage = o(pm["storage"]);
  const vs = s(pm["verificationStatus"]);

  const verificationState: IntegrityState =
    vs === "RECORDED_INTEGRITY_VERIFIED" ? "verified" : vs === "MATERIALS_AVAILABLE" ? "available" : vs === "REVIEW_REQUIRED" ? "pending" : vs === "FAILED" ? "failed" : "unavailable";
  const fpRecorded = pm["fingerprintHashRecorded"] === true;
  const fpMatch = pm["fingerprintCanonicalHashMatches"];
  const fingerprintState: IntegrityState = !fpRecorded ? "unavailable" : fpMatch === true ? "verified" : fpMatch === false ? "failed" : "recorded";
  const sigRecorded = sig["recorded"] === true;
  const signatureState: IntegrityState = !sigRecorded ? "unavailable" : sig["valid"] === true ? "verified" : "recorded";
  const tsaAvailable = tsa["timestampAvailable"] === true;
  const tsaStatus = s(tsa["status"]);
  const tsaState: IntegrityState = tsaAvailable ? "recorded" : tsaStatus === "FAILED" ? "failed" : tsaStatus ? "pending" : "unavailable";
  const eff = s(ots["effectiveStatus"]);
  const otsState: IntegrityState =
    eff === "ANCHORED" ? "recorded" : eff === "FAILED" ? "failed" : eff === "DISABLED" ? "not-applicable" : eff === "PENDING" ? "pending" : "unavailable";
  const otsDesc = describeOtsStatus({ effectiveStatus: eff, failureReason: s(ots["failureReason"]), pendingReason: s(ots["pendingReason"]) });
  const rAvail = aReport["available"] === true;
  const rPending = aReport["pending"] === true;
  const reportState: IntegrityState = rAvail ? "available" : rPending ? "pending" : "unavailable";
  const pdfSig = aReport["pdfSignature"] && typeof aReport["pdfSignature"] === "object" ? o(aReport["pdfSignature"]) : null;
  const pdfSigStatus = s(pdfSig?.["status"]);
  const reportSignatureState: IntegrityState =
    !rAvail || !pdfSig
      ? rPending
        ? "pending"
        : "unavailable"
      : pdfSigStatus === "SIGNED"
        ? "recorded"
        : pdfSigStatus === "SIGNING_FAILED"
          ? "failed"
          : pdfSigStatus === "NOT_APPLICABLE"
            ? "not-applicable"
            : "unavailable";
  const pAvail = aPkg["available"] === true;
  const pPending = aPkg["pending"] === true;
  const packageState: IntegrityState = pAvail ? "available" : pPending ? "pending" : !packageIncluded ? "not-applicable" : "unavailable";
  const manifestSigned = o(aPkg["manifestSignature"])["status"] === "SIGNED";
  const manifestState: IntegrityState = pAvail
    ? manifestSigned
      ? "recorded"
      : "unavailable"
    : pPending
      ? "pending"
      : !packageIncluded
        ? "not-applicable"
        : "unavailable";

  // `_lib.tsx:495` describeReportPdfSignature / :530 describePackageManifestStatus.
  const pdfSigLabel = (() => {
    if (!rAvail || !pdfSig) return rPending ? "Pending" : "Unknown";
    switch (pdfSigStatus) {
      case "SIGNED":
        return "Signed";
      case "UNSIGNED_OPT_OUT":
        return "Unsigned";
      case "SIGNING_UNAVAILABLE":
        return "Signing unavailable";
      case "SIGNING_FAILED":
        return "Signing failed";
      case "NOT_APPLICABLE":
        return "Not applicable";
      default:
        return "Unknown";
    }
  })();
  const manifestLabel = pAvail
    ? manifestSigned
      ? "Signed manifest present"
      : "Unknown"
    : aPkg["blocked"] === true
      ? "Blocked"
      : pPending
        ? "Pending"
        : packageIncluded
          ? "Unknown"
          : "Not included on plan";
  const dateOr = (iso: string | null, fallback: string) => (iso ? fmt(iso) : fallback);
  const legalHold = s(ev["storageObjectLockLegalHoldStatus"]);
  const retentionUntil = s(ev["retentionUntilUtc"]);
  const olMode = s(ev["storageObjectLockMode"]);
  const olUntil = s(ev["storageObjectLockRetainUntilUtc"]);
  const otsUpdated = s(ots["lastUpdatedAtUtc"]);

  return [
    { label: "Verification status", value: s(pm["verificationStatusLabel"]) ?? "Not recorded", state: verificationState },
    { label: "SHA-256 recorded", value: pm["sha256Recorded"] === true ? "Recorded" : "Not recorded", state: pm["sha256Recorded"] === true ? "recorded" : "unavailable" },
    {
      label: "Fingerprint hash",
      value: fpRecorded
        ? fpMatch === true
          ? "Recorded and matches the canonical fingerprint"
          : fpMatch === false
            ? "Recorded but does not match the canonical fingerprint"
            : "Recorded"
        : "Not recorded",
      state: fingerprintState,
    },
    { label: "Signature", value: sigRecorded ? (sig["valid"] === true ? "Recorded and validated" : "Recorded") : "Not recorded", state: signatureState },
    { label: "Timestamp proof (TSA)", value: tsaAvailable ? "Timestamp recorded" : tsaStatus ? `Status: ${tsaStatus}` : "Timestamp unavailable", state: tsaState },
    { label: "Bitcoin anchoring (OTS)", value: otsDesc.label, state: otsState },
    { label: "Bitcoin anchoring last updated", value: dateOr(otsUpdated, "Not recorded"), state: otsUpdated ? "recorded" : "unavailable" },
    {
      label: "Storage protection",
      value: storage["verified"] === true ? "Recorded" : "Not exposed in current API response",
      state: storage["verified"] === true ? "recorded" : "unavailable",
    },
    {
      label: "Report artifact",
      value: `${outputStateLabel(outputs.report.state)}${pmReport["available"] === true ? ` · Version ${n(pmReport["version"]) ?? "latest"}` : ""}`,
      state: reportState,
    },
    { label: "Report PDF signature", value: pdfSigLabel, state: reportSignatureState },
    {
      label: "Verification package",
      value: `${outputStateLabel(outputs.package.state)}${pmPkg["available"] === true ? ` · Version ${n(pmPkg["version"]) ?? "latest"}` : ""}`,
      state: packageState,
    },
    { label: "Package manifest", value: manifestLabel, state: manifestState },
    {
      label: "Retention until",
      value: retentionUntil ? `Recorded — ${fmt(retentionUntil)}` : "No record-level retention deadline recorded",
      state: retentionUntil ? "recorded" : "unavailable",
    },
    {
      label: "Object Lock retention mode",
      value: olMode ?? "Not asserted (storage immutability not confirmed for this record)",
      state: olMode ? "recorded" : "unavailable",
    },
    { label: "Object Lock retention until", value: olUntil ? fmt(olUntil) : "Not asserted", state: olUntil ? "recorded" : "unavailable" },
    {
      label: "Legal hold",
      value: legalHold === "ON" ? "Legal hold active" : legalHold === "OFF" ? "Legal hold off" : "No legal hold metadata recorded",
      state: legalHold === "ON" ? "recorded" : legalHold === "OFF" ? "not-applicable" : "unavailable",
    },
    { label: "Bitcoin anchoring detail", value: otsDesc.detail, wide: true },
  ];
}

/* ------------------------------------------------- Source & Capture Context */

/** `lib/evidence/source-display.ts` displaySourceType. */
export function displaySourceType(sourceType: string | null): string {
  switch (sourceType) {
    case "imported_upload":
      return "Uploaded file";
    case "folder_upload":
      return "Folder upload (multiple files)";
    case "external_intake":
      return "Secure intake submission";
    case "mobile_app":
      return "PROOVRA mobile app submission";
    case "not_recorded":
    case "unknown":
    case null:
    case "":
      return "Not recorded";
    default:
      return sourceType
        .split(/[_\s]+/)
        .filter(Boolean)
        .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
        .join(" ");
  }
}

/** `_lib.tsx:388` describeClientSignalState. */
function describeClientSignalState(status: string): string {
  switch (status) {
    case "NOT_COLLECTED":
      return "Client signal not collected";
    case "COLLECTED_FALSE":
      return "Collected: no signal detected";
    case "DETECTED":
      return "Signal detected";
    case "UNAVAILABLE":
      return "Unavailable for this evidence type";
    default:
      return "Not recorded";
  }
}

const showSignal = (v: unknown): boolean => {
  const x = String(v ?? "").toUpperCase();
  return x === "DETECTED" || x === "COLLECTED_FALSE";
};

/**
 * EvidenceIntegrityTab.tsx:346-425 — a context fact renders ONLY when PROOVRA
 * has a real collected value. Acquisition is always shown ("Not recorded" is a
 * real answer for a legacy record).
 */
export function buildSourceContextFacts(rw: unknown, fmt: (iso: string) => string): Array<{ label: string; value: string }> {
  const sc = o(o(rw)["sourceContext"]);
  if (Object.keys(sc).length === 0) return [];
  const acq = sc["acquisition"] && typeof sc["acquisition"] === "object" ? o(sc["acquisition"]) : null;
  const acqLabel = s(acq?.["label"]);
  const items: Array<{ label: string; value: string }> = [
    {
      label: "Acquisition",
      value: !acqLabel
        ? "Not recorded"
        : acq?.["recordedBy"] === "BACKFILL_INTAKE_SESSION_LINK"
          ? `${acqLabel} (recorded later from the intake session)`
          : acqLabel,
    },
  ];
  const sourceTypeLabel = displaySourceType(s(sc["sourceType"]));
  if (sourceTypeLabel !== "Not recorded") items.push({ label: "Source type", value: sourceTypeLabel });
  const cap = s(sc["capturedAtUtc"]);
  if (cap) items.push({ label: "Captured at", value: fmt(cap) });
  const up = s(sc["uploadedAtUtc"]);
  if (up) items.push({ label: "Uploaded at", value: fmt(up) });
  const dev = s(sc["deviceTimeIso"]);
  if (dev) items.push({ label: "Device time", value: dev });
  if (sc["locationIncluded"] === true) items.push({ label: "Location included", value: "Included" });
  const cs = o(sc["clientSignalsSummary"]);
  if (showSignal(cs["screenshotLikeStatus"])) items.push({ label: "Screenshot indicators", value: describeClientSignalState(String(cs["screenshotLikeStatus"]).toUpperCase()) });
  if (showSignal(cs["folderPathStatus"])) items.push({ label: "Folder path indicators", value: describeClientSignalState(String(cs["folderPathStatus"]).toUpperCase()) });
  return items;
}

/* ------------------------------------------------------- Snapshot timing */

export interface SnapshotTiming {
  facts: Array<{ label: string; value: string }>;
  fixedArtifactNote: string | null;
  /** EvidenceIntegrityTab.tsx:688-706 — the divergence callout, or null. */
  divergence: { tone: "danger" | "access-only" | "warn"; body: string } | null;
}

export function buildSnapshotTiming(rw: unknown, fmt: (iso: string) => string): SnapshotTiming | null {
  const root = o(rw);
  const snap = o(root["snapshot"]);
  if (Object.keys(snap).length === 0) return null;
  const chain = o(o(root["preservationMatrix"])["custodyChain"]);
  const rep = s(snap["reportGeneratedAtUtc"]);
  const pkg = s(snap["verificationPackageGeneratedAtUtc"]);
  const cur = s(snap["currentStatus"]);
  const cons = o(o(root["artifactVersions"])["trustDecisionConsistency"]);
  let divergence: SnapshotTiming["divergence"] = null;
  if (cons["consistentWithSnapshot"] === false) {
    divergence =
      cons["accessOnly"] === true
        ? {
            tone: "access-only",
            body: "No integrity mismatch detected. Live access activity now differs from the fixed report snapshot, and this is informational activity drift only.",
          }
        : cons["tone"] === "danger"
          ? {
              tone: "danger",
              body: "A live integrity-relevant divergence was detected between the current state and the fixed report snapshot. Open the Technical Appendix tab for the full reason list.",
            }
          : { tone: "warn", body: "Live verification now differs from the fixed report snapshot. Open the Technical Appendix tab for the full reason list." };
  }
  return {
    facts: [
      { label: "Report generated at", value: rep ? fmt(rep) : "Not recorded" },
      { label: "Verification package generated at", value: pkg ? fmt(pkg) : "Not recorded" },
      { label: "Current status", value: cur ? humanize(cur) : "Not recorded" },
      { label: "Custody chain", value: custodyChainLabel(chain) },
    ],
    fixedArtifactNote: s(snap["fixedArtifactNote"]),
    divergence,
  };
}

/** "Continuous (mode)" / "Review required (reason)" — EvidenceIntegrityTab.tsx:677. */
export function custodyChainLabel(chain: Obj): string {
  return chain["valid"] === true ? `Continuous (${s(chain["mode"]) ?? "unknown"})` : `Review required (${s(chain["reason"]) ?? "unknown"})`;
}

/* ------------------------------------------------------ custody grouping */

export interface CustodyTimelineEvent {
  sequence: number;
  atUtc: string | null;
  eventType: string;
  payloadSummary: string | null;
  eventHash: string | null;
}

export function projectCustodyTimelines(rw: unknown): { forensic: CustodyTimelineEvent[]; access: CustodyTimelineEvent[] } {
  const cl = o(o(rw)["custodyLifecycle"]);
  const map = (list: unknown): CustodyTimelineEvent[] =>
    arr(list)
      .map((raw) => {
        const e = o(raw);
        const eventType = s(e["eventType"]);
        if (!eventType) return null;
        return {
          sequence: n(e["sequence"]) ?? 0,
          atUtc: s(e["atUtc"]),
          eventType,
          payloadSummary: s(e["payloadSummary"]),
          eventHash: s(e["eventHash"]),
        };
      })
      .filter((x): x is CustodyTimelineEvent => x !== null);
  return { forensic: map(cl["forensicEvents"]), access: map(cl["accessEvents"]) };
}

export interface CustodyDayGroup {
  day: string;
  total: number;
  rows: Array<{ type: string; count: number; lastAtUtc: string }>;
}

/** EvidenceCustodyTab.tsx:42 groupByDay — one row per event TYPE per day, newest day first. */
export function groupCustodyByDay(events: CustodyTimelineEvent[]): CustodyDayGroup[] {
  const buckets = new Map<string, Map<string, { count: number; lastAtUtc: string }>>();
  for (const ev of events) {
    const day = ev.atUtc?.slice(0, 10) || "Undated";
    const byType = buckets.get(day) ?? new Map<string, { count: number; lastAtUtc: string }>();
    const prev = byType.get(ev.eventType);
    byType.set(ev.eventType, {
      count: (prev?.count ?? 0) + 1,
      lastAtUtc: prev?.lastAtUtc && prev.lastAtUtc > (ev.atUtc ?? "") ? prev.lastAtUtc : (ev.atUtc ?? ""),
    });
    buckets.set(day, byType);
  }
  return Array.from(buckets.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, byType]) => ({
      day,
      total: Array.from(byType.values()).reduce((sum, x) => sum + x.count, 0),
      rows: Array.from(byType.entries()).map(([type, x]) => ({ type, count: x.count, lastAtUtc: x.lastAtUtc })),
    }));
}

export const CUSTODY_TIMELINE_COPY = {
  forensic: {
    title: "Forensic Custody",
    description: "Integrity-relevant lifecycle chronology — grouped by day",
    empty: "No forensic custody events are recorded in the current response.",
  },
  access: {
    title: "Access Activity",
    description: "Viewing, download, and verification access — grouped by day",
    empty: "No access activity is recorded in the current response.",
  },
} as const;

/* --------------------------------------------------- lifecycle management */

export interface LifecycleProjection {
  productState: string;
  canArchive: boolean;
  canUnarchive: boolean;
  canTrash: boolean;
  canRestoreFromTrash: boolean;
  trashBlockReason: string | null;
  archiveBlockReason: string | null;
  legalHold: boolean;
  effectiveRetentionUntilIso: string | null;
  objectLockCompliance?: boolean;
}

/** `lib/evidence-delete-eligibility.ts:108` mapReasonMessage, verbatim. */
export function trashUnavailableMessage(trashBlockReason: string | null): string {
  switch (trashBlockReason) {
    case "LEGAL_HOLD_ACTIVE":
      return "This record is under an active legal hold. It cannot be archived or moved to trash while the hold stands.";
    case "EVIDENCE_LOCKED":
      return "This record is permanently locked and cannot be moved to trash.";
    case "TERMINAL_DESTROYED":
      return "This record has been destroyed. Only its tombstone remains.";
    case "ALREADY_IN_STATE":
      return "This record is already in the trash.";
    default:
      return "This record cannot be moved to trash right now.";
  }
}

export const ARCHIVE_AS_ALTERNATIVE_COPY = "Archive removes the record from Active evidence and keeps it fully available.";

/** `lib/evidence-delete-eligibility.ts:152` formatLifecycleDate — `Jun 14, 2034`. */
export function formatLifecycleDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** `getRetentionPosture` — retention as a FACT, independent of what the buttons offer. */
export function retentionPosture(
  l: LifecycleProjection | null,
  nowMs: number = Date.now(),
): { retainedUntilLabel: string | null; objectLockLabel: string | null; destructionNote: string | null; legalHold: boolean } {
  if (!l) return { retainedUntilLabel: null, objectLockLabel: null, destructionNote: null, legalHold: false };
  const until = formatLifecycleDate(l.effectiveRetentionUntilIso);
  const retained = until !== null && new Date(l.effectiveRetentionUntilIso as string).getTime() > nowMs;
  return {
    retainedUntilLabel: retained ? `Retained until ${until}` : null,
    objectLockLabel: l.objectLockCompliance ? "Object Lock: Compliance" : null,
    destructionNote: retained ? `Physical destruction unavailable until ${until}` : null,
    legalHold: l.legalHold,
  };
}

export function productStateLabel(state: string | null | undefined): string {
  return state === "TRASHED" ? "In trash" : state === "ARCHIVED" ? "Archived" : state === "DESTROYED" ? "Destroyed" : "Active";
}

/** EvidenceReviewTab.tsx:382-395 — the lifecycle facts. */
export function lifecycleFacts(l: LifecycleProjection | null, r: RecordView, fmt: (iso: string) => string): Array<{ label: string; value: string }> {
  const d = (iso: string | null) => (iso ? fmt(iso) : "Not recorded");
  return [
    { label: "State", value: productStateLabel(l?.productState) },
    { label: "Locked at", value: d(r.lockedAt) },
    { label: "Archived at", value: d(r.archivedAt) },
    { label: "Moved to trash", value: d(r.deletedAt) },
    { label: "Recoverable until", value: d(r.deleteScheduledForUtc) },
  ];
}

export const DESTROYED_COPY = {
  title: "This record has been destroyed",
  body: "Its content was permanently removed from storage and the removal was verified. The record is retained as a tombstone so the destruction remains auditable.",
} as const;

/* ------------------------------------------------------- preview items */

export interface PreviewItem {
  id: string;
  label: string;
  kind: string;
  originalFileName: string | null;
  sizeLabel: string;
  role: string;
  privateRole: string | null;
  sourceLabel: string | null;
  privateNote: string | null;
  viewUrl: string | null;
}

/** `_lib.tsx:220` describeContentItemRole (the server's label first). */
function contentItemRole(it: Obj): string {
  const artifactRole = s(it["artifactRole"]);
  const roleLabel =
    s(it["artifactRoleLabel"]) ??
    (artifactRole === "primary_evidence"
      ? "Primary evidence"
      : artifactRole === "supporting_evidence"
        ? "Supporting evidence"
        : artifactRole === "attachment"
          ? "Attachment"
          : null) ??
    (it["isPrimary"] === true ? "Primary evidence" : "Supporting evidence");
  const checklist = s(it["checklistStepLabel"])?.trim() || null;
  return checklist ? `${roleLabel} • ${checklist}` : roleLabel;
}

/**
 * `_lib.tsx:780` PreviewWorkspace — the record's content items (review
 * workspace `evidence.contentItems`), each part's PRIVATE note joined from
 * `parts[].privateNote` by id, and the default selection the web resolves.
 */
export function projectPreview(rw: unknown): { items: PreviewItem[]; defaultId: string | null } {
  const root = o(rw);
  const ev = o(root["evidence"]);
  const notes = new Map<string, string | null>();
  for (const raw of arr(root["parts"])) {
    const p = o(raw);
    const id = s(p["id"]);
    if (id) notes.set(id, s(p["privateNote"]));
  }
  const items: PreviewItem[] = arr(ev["contentItems"])
    .map((raw) => {
      const it = o(raw);
      const id = s(it["id"]);
      if (!id) return null;
      return {
        id,
        label: s(it["label"]) ?? s(it["originalFileName"]) ?? "Untitled file",
        kind: s(it["kind"]) ?? "other",
        originalFileName: s(it["originalFileName"]),
        sizeLabel: s(it["displaySizeLabel"]) ?? formatBytes(typeof it["sizeBytes"] === "number" ? (it["sizeBytes"] as number) : s(it["sizeBytes"])),
        role: contentItemRole(it),
        privateRole: s(it["privateRole"]),
        sourceLabel: s(it["sourceLabel"]),
        privateNote: notes.get(id) ?? s(it["privateNote"]),
        viewUrl: s(it["viewUrl"]),
      };
    })
    .filter((x): x is PreviewItem => x !== null);
  const defaultId =
    items.find((i) => i.id === s(ev["defaultPreviewItemId"]))?.id ??
    items.find((i) => {
      const raw = arr(ev["contentItems"]).map(o).find((x) => x["id"] === i.id);
      return raw?.["previewable"] === true && !!i.viewUrl;
    })?.id ??
    s(o(ev["primaryContentItem"])["id"]) ??
    items[0]?.id ??
    null;
  return { items, defaultId };
}

export const PREVIEW_COPY = {
  title: "Evidence Preview",
  noPreviewTitle: "Open the original evidence record to review preserved content.",
  noPreviewBody: "Reviewer-facing preview is not available for this selection in the current response.",
  unsupportedTitle: "Preview is not available for this file type.",
  unsupportedBody: "Use the original access actions to review the preserved material directly.",
} as const;

/* ---------------------------------------------------- capture template */

export interface CaptureTemplateView {
  items: Array<{ label: string; value: string; ok?: boolean }>;
  missing: string[];
}

/** `_lib.tsx:1102` CaptureTemplateCard — null when no template was recorded. */
export function projectCaptureTemplate(rw: unknown): CaptureTemplateView | null {
  const ev = o(o(rw)["evidence"]);
  const planRaw = ev["intakePlanJson"];
  if (!planRaw || typeof planRaw !== "object") return null;
  const plan = o(planRaw);
  const templateName = s(plan["templateName"]);
  const templateId = s(plan["templateId"]);
  const mode = s(plan["mode"]);
  const loc = s(plan["locationRequirement"]);
  const required = arr(plan["requiredSteps"]).map(o);
  const optional = arr(plan["optionalSteps"]).map(o);
  if (!templateName && !templateId && required.length === 0 && optional.length === 0) return null;
  const mapped = new Set<string>();
  for (const raw of arr(ev["contentItems"])) {
    const id = s(o(raw)["checklistStepId"]);
    if (id) mapped.add(id);
  }
  const requiredMapped = required.filter((st) => s(st["id"]) && mapped.has(s(st["id"]) as string)).length;
  const missing = required.filter((st) => s(st["id"]) && !mapped.has(s(st["id"]) as string)).map((st) => s(st["title"]) ?? s(st["id"]) ?? "Untitled");
  return {
    items: [
      { label: "Template", value: templateName || templateId || "Not recorded" },
      { label: "Mode", value: mode === "CHECKLIST_REQUIRED" ? "Checklist required" : mode === "FLEXIBLE" ? "Flexible" : (mode ?? "Not recorded") },
      {
        label: "Required steps",
        value: required.length === 0 ? "None declared" : `${requiredMapped} of ${required.length}`,
        ok: required.length > 0 && requiredMapped === required.length,
      },
      { label: "Optional steps", value: optional.length === 0 ? "None" : String(optional.length) },
      {
        label: "Location",
        value: loc === "required" ? "Required" : loc === "recommended" ? "Recommended" : loc === "optional" ? "Optional" : "Not recorded",
      },
    ],
    missing,
  };
}

/* ---------------------------------------------- relationships (web copy) */

/** EvidenceRelationshipsSection.tsx:167 — direction as the web states it. */
export function relationshipDirectionLabel(direction: string): string {
  return direction === "outbound" ? "Links from this record" : "Links to this record";
}

/* --------------------------------------------------- download reasons */

/**
 * page.tsx:915-936 — why each header download is refused. Integrity first,
 * then the governance verdict, then the canonical output state. `null` means
 * the control is enabled. The PLAN is not an input: a READY artifact stays
 * downloadable after a downgrade.
 */
export function downloadBlockedReason(input: {
  integrityFailed: boolean;
  governanceBlockedReason: string | null;
  available: boolean;
  state: OutputState | null;
  noun: "report" | "verification package";
  blockedReason?: string | null;
}): string | null {
  if (input.integrityFailed) return "Downloads are unavailable while recorded integrity is failed.";
  if (input.governanceBlockedReason) return input.governanceBlockedReason;
  if (!input.available) return input.blockedReason ?? outputStateReason(input.state, input.noun);
  return null;
}
