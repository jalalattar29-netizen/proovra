/**
 * CASE DETAIL — the pure projections behind the native port of the web
 * `SimpleCaseDetail` (apps/web/components/cases-experience/simple-case-detail/
 * SimpleCaseDetail.tsx). Import-free so it can be transpiled and tested alone.
 *
 * Every value here is read from a documented server reply:
 *   GET  /v1/cases/:id/matter-workspace   → sections.evidence.items[] (matter-workspace.service.ts:153)
 *   GET  /v1/cases/:id/available-evidence → { items[] } (cases.routes.ts:1706-1735)
 *   POST /v1/cases/:id/evidence { evidenceId } — one record per call (no batch route)
 * Nothing is derived that the server did not send.
 */

export type CaseTab = "overview" | "evidence" | "reports" | "notes" | "settings";

/** SimpleCaseDetail.tsx:124 — the five sections, in the web's order and words. */
export const CASE_TABS: ReadonlyArray<{ id: CaseTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "evidence", label: "Evidence" },
  { id: "reports", label: "Reports & Packages" },
  { id: "notes", label: "Notes" },
  { id: "settings", label: "Settings" },
];

export function parseCaseTab(v: unknown): CaseTab {
  return CASE_TABS.some((t) => t.id === v) ? (v as CaseTab) : "overview";
}

const o = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const s = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);

/** The web getDisplayTitle cascade: title → display file name → original file name. */
export function caseEvidenceTitle(row: unknown): string {
  const r = o(row);
  return s(r.title) ?? s(r.displayFileName) ?? s(r.originalFileName) ?? "Untitled evidence";
}

/** The web caseOutputLabel, with the readiness-boolean fallback the web applies when no state was sent. */
export function outputLabel(state: string | null, ready: boolean, noun: "Report" | "Package"): string {
  switch (state) {
    case "READY":
      return `${noun} ready`;
    case "NOT_INCLUDED":
      return `${noun} not included`;
    case "NOT_APPLICABLE":
      return `${noun} not applicable`;
    case "QUEUED":
    case "GENERATING":
      return `${noun} generating`;
    case "ELIGIBLE_NOT_GENERATED":
      return `${noun} not generated`;
    case "RETRYABLE_FAILURE":
    case "TERMINAL_FAILURE":
      return `${noun} generation failed`;
    case "BLOCKED":
      return `${noun} blocked`;
    default:
      return ready ? `${noun} ready` : `${noun} not available`;
  }
}

export interface CaseEvidenceRow {
  id: string;
  title: string;
  type: string;
  status: string;
  verificationStatus: string | null;
  reportReady: boolean;
  packageReady: boolean;
  reportLabel: string;
  packageLabel: string;
}

function toRow(raw: unknown): CaseEvidenceRow | null {
  const r = o(raw);
  const id = s(r.id);
  if (!id) return null;
  const reportReady = r.reportReady === true;
  const packageReady = r.packageReady === true;
  return {
    id,
    title: caseEvidenceTitle(r),
    type: s(r.type) ?? "",
    status: s(r.status) ?? "",
    verificationStatus: s(r.verificationStatus),
    reportReady,
    packageReady,
    reportLabel: outputLabel(s(o(o(r.outputs).report).state), reportReady, "Report"),
    packageLabel: outputLabel(s(o(o(r.outputs).verificationPackage).state), packageReady, "Package"),
  };
}

/** sections.evidence.items[] — the case's linked records, as the web Evidence tab reads them. */
export function parseCaseEvidenceRows(envelope: unknown): CaseEvidenceRow[] {
  const items = o(o(o(envelope).sections).evidence).items;
  return (Array.isArray(items) ? items : []).map(toRow).filter((x): x is CaseEvidenceRow => x !== null);
}

/** GET /v1/cases/:id/available-evidence → { items[] }; already-linked ids are dropped defensively. */
export function parseAttachCandidates(payload: unknown, linkedIds: ReadonlySet<string>): CaseEvidenceRow[] {
  const items = o(payload).items;
  return (Array.isArray(items) ? items : [])
    .map(toRow)
    .filter((x): x is CaseEvidenceRow => x !== null && !linkedIds.has(x.id));
}

/** "RECORDED_VERIFIED" → "recorded verified": the web prints a verification state in lower case. */
export function verificationText(status: string): string {
  return status.replace(/_/g, " ").toLowerCase();
}

/** SimpleCaseDetail.tsx:1080 / :1442 — a client filter over name, type, status and id (full or 8-char). */
export function matchesCaseEvidence(row: CaseEvidenceRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.title, row.type, row.status, row.id, row.id.slice(0, 8)].join("\n").toLowerCase().includes(q);
}

/** The Evidence tab's meta line: short id • type • status • verification • report • package. */
export function caseEvidenceMeta(row: CaseEvidenceRow): string {
  return [
    row.id.slice(0, 8),
    row.type,
    row.status,
    row.verificationStatus ? verificationText(row.verificationStatus) : null,
    row.reportLabel,
    row.packageLabel,
  ]
    .filter(Boolean)
    .join(" • ");
}

/** The integrity state as a tone (SimpleCaseDetail.tsx:1332): FAILED is red, not amber. */
export function attachIntegrityTone(status: string | null): "risk" | "pending" | "verified" | "neutral" {
  if (!status) return "neutral";
  if (status === "FAILED") return "risk";
  if (status === "REVIEW_REQUIRED") return "pending";
  if (status.startsWith("RECORDED")) return "verified";
  return "neutral";
}

export function attachCountMessage(n: number): string {
  if (n === 0) return "Select one or more evidence records";
  return n === 1 ? "1 evidence record selected" : `${n} evidence records selected`;
}

export function attachConfirmLabel(n: number, busy: boolean): string {
  if (busy) return "Linking…";
  return n <= 1 ? "Link selected evidence" : `Link ${n} selected evidence records`;
}

/** The dialog's own message for rows that failed — they stay selected for the retry. */
export function attachSubmitError(failed: number): string | null {
  if (failed === 0) return null;
  return failed === 1
    ? "One evidence record could not be linked. It is still selected — try again."
    : `${failed} evidence records could not be linked. They are still selected — try again.`;
}

/** The page's outcome message for an attach batch (SimpleCaseDetail.tsx:487-516). */
export function attachOutcomeMessage(succeeded: number, failed: number): { tone: "success" | "error"; text: string } {
  if (succeeded === 0 && failed > 0) {
    return {
      tone: "error",
      text: failed === 1 ? "Could not link the selected evidence record." : `Could not link the ${failed} selected evidence records.`,
    };
  }
  if (failed === 0) {
    return { tone: "success", text: succeeded === 1 ? "Evidence linked to case." : `${succeeded} evidence records linked to case.` };
  }
  return { tone: "error", text: `${succeeded} evidence record${succeeded === 1 ? "" : "s"} linked. ${failed} could not be linked.` };
}

export const ATTACH_COPY = {
  title: "Link evidence to case",
  description: "Choose an existing evidence record from this workspace to link to this case.",
  lede: "Choose an existing evidence record from this workspace.",
  searchPlaceholder: "Search evidence by name, type, or record ID",
  searchLabel: "Search attachable evidence",
  loading: "Loading available evidence…",
  restricted: "You do not have access to this workspace's evidence. Ask a workspace administrator for access.",
  error: "Could not load available evidence. Close this dialog and try again.",
  empty: "No available evidence to link. Upload or capture evidence first, then return to this case.",
  noMatch: "No matching evidence found. Try a different name or record ID.",
} as const;

/* ------------------------------------------------------------------ header */

export function evidenceCountText(n: number): string {
  return n === 1 ? "1 evidence record" : `${n} evidence records`;
}

export function priorityLabel(priority: string | null): string {
  return priority ? priority.charAt(0) + priority.slice(1).toLowerCase() : "—";
}

/* ---------------------------------------------------------------- overview */

/** SimpleCaseDetail.tsx:783 — the four Overview metrics, derived from the envelope only. */
export function overviewKpis(evidenceCount: number, reportsReady: number, packagesReady: number) {
  return [
    { key: "evidence", label: "Evidence records", value: String(evidenceCount), caption: "Linked to this case", tone: "neutral" as const },
    {
      key: "ready",
      label: "End-to-end ready",
      value: `${reportsReady + packagesReady === 0 ? 0 : Math.min(reportsReady, packagesReady)} of ${evidenceCount}`,
      caption: "Report + package present",
      tone: "verified" as const,
    },
    { key: "reports", label: "Reports", value: `${reportsReady} of ${evidenceCount}`, caption: "Records with a report", tone: "governance" as const },
    { key: "links", label: "Verification links", value: `${packagesReady} of ${evidenceCount}`, caption: "Records with a package", tone: "info" as const },
  ];
}

/* ---------------------------------------------------------------- settings */

/** The status options, in the web's CASE_STATUS_OPTIONS order. */
export const CASE_STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "OPEN", label: "Open" },
  { value: "INVESTIGATING", label: "Investigating" },
  { value: "ON_HOLD", label: "On hold" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "CLOSED", label: "Closed" },
  { value: "ARCHIVED", label: "Archived" },
];

export function caseStatusLabel(status: string | null | undefined): string {
  if (!status) return "Unknown";
  return CASE_STATUS_OPTIONS.find((x) => x.value === status)?.label ?? status;
}

/** SimpleCaseDetail.tsx:2324 — the confirmation says the change is organisational only. */
export function statusChangeConsequence(from: string, to: string): string {
  return `Change this case from ${caseStatusLabel(from)} to ${caseStatusLabel(to)}? This only updates case organization. Linked evidence, reports, verification packages, notes, and audit history remain unchanged.`;
}

/** SimpleCaseDetail.tsx:2531 — the danger-zone sentence, plus how many records will be unlinked. */
export function deleteCaseDangerText(evidenceCount: number): string {
  const base =
    "Deleting this case will not delete preserved evidence records. Evidence remains available in the Evidence Library unless separately archived or restricted.";
  return evidenceCount > 0
    ? `${base} ${evidenceCount} evidence record${evidenceCount === 1 ? "" : "s"} will be unlinked from this case but kept in the library.`
    : base;
}

/** The web's "Save" is disabled unless the name actually changed (SimpleCaseDetail.tsx:2424). */
export function renameSaveDisabled(draft: string, current: string): boolean {
  const n = draft.trim();
  return n.length === 0 || n === current;
}

/* ------------------------------------------------------------------- notes */

/** POST /v1/cases/:id/comments — the web writes a PRIVATE note (visibility INTERNAL). */
export function buildCaseNoteBody(body: string) {
  return { body: body.trim(), visibility: "INTERNAL" as const };
}

export const NOTE_DELETE_CONSEQUENCE =
  "Notes are private workspace notes. Deleting removes it from the case. Linked evidence, reports, and verification packages are not affected.";
