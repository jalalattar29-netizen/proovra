/**
 * THE ONE EVIDENCE RECORD-STATUS PRESENTATION (ET-SM-08, 2026-09-29).
 *
 * The web library's label/tone functions had no FAILED_HASH_MISMATCH case, so a
 * record whose stored bytes no longer match its signed digest rendered as a
 * neutral "Status not recorded" in the library row and the selection preview;
 * the mobile library copied that gap while another mobile module called it
 * "Integrity failed". Every surface reads this map; a structural test fails
 * when an EvidenceStatus value has no entry.
 *
 * UPLOADED is a legacy value nothing writes any more. It is labelled for the
 * rows that still carry it and is never presented as work to do.
 */
export type EvidenceRecordStatusTone = "neutral" | "processing" | "success" | "warning" | "danger";

const PRESENTATION: Readonly<Record<string, { label: string; tone: EvidenceRecordStatusTone }>> = {
  CREATED: { label: "Created", tone: "processing" },
  UPLOADING: { label: "Uploading", tone: "processing" },
  UPLOADED: { label: "Uploaded (legacy)", tone: "neutral" },
  SIGNED: { label: "Signed", tone: "success" },
  REPORTED: { label: "Reported", tone: "success" },
  FAILED_HASH_MISMATCH: { label: "Integrity check failed", tone: "danger" },
};

/** Every status this module presents (the structural test compares it with the enum). */
export const EVIDENCE_RECORD_STATUSES_PRESENTED: ReadonlyArray<string> = Object.keys(PRESENTATION);

function norm(status: string | null | undefined): string {
  return String(status ?? "").trim().toUpperCase();
}

export function evidenceRecordStatusLabel(status: string | null | undefined): string {
  return PRESENTATION[norm(status)]?.label ?? "Status not recorded";
}

export function evidenceRecordStatusTone(status: string | null | undefined): EvidenceRecordStatusTone {
  return PRESENTATION[norm(status)]?.tone ?? "neutral";
}
