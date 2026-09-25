/**
 * EVIDENCE COMPARISON (T-14 ComparisonPanel + StructuredSnapshot) — the
 * record's original, its reviewer preview, the latest report artifact and the
 * latest verification package side by side, from
 * `GET /v1/evidence/:id/comparison` (evidence.routes.ts:7879, ungated beyond
 * read access). The web mounts it on the Review tab for every plan.
 *
 * The snapshot model mirrors the web StructuredSnapshot: labelled facts for
 * scalars, sections for nested objects and arrays, and — for the package card
 * only — field-level change marks against the report's recorded trust
 * decision. Only keys the counterpart carries are compared, so a field with
 * no equivalent is never reported as a difference.
 *
 * Pure: no React, no fetch.
 */

export type Obj = Record<string, unknown>;
export type ChangeKind = "added" | "removed" | "changed" | "unchanged";

export const isPlainObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function buildComparisonPath(evidenceId: string): string {
  return `/v1/evidence/${encodeURIComponent(evidenceId)}/comparison`;
}

export const COMPARISON_COPY = {
  title: "Comparison mode",
  boundary:
    "Comparison uses recorded metadata and export references only. It does not establish factual truth, authorship, or legal outcome.",
  loading: "Loading comparison data...",
  unavailable: "Comparison unavailable",
  notAvailable: "Comparison not available.",
  technical: "Technical details",
  raw: "View raw snapshot",
} as const;

export function humaniseKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!spaced) return key;
  const ACRONYM = /^(utc|id|ids|url|uri|sha|sha256|tsa|ots|ai|pdf|json|mime|api)$/i;
  return spaced
    .split(/\s+/)
    .map((word, i) => (ACRONYM.test(word) ? word.toUpperCase() : i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word.toLowerCase()))
    .join(" ");
}

export function compareValues(a: unknown, b: unknown): ChangeKind {
  if (a !== undefined && b === undefined) return "added";
  if (a === undefined && b !== undefined) return "removed";
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (compareValues(a[k], b[k]) !== "unchanged") return "changed";
    return "unchanged";
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return "changed";
    for (let i = 0; i < a.length; i += 1) if (compareValues(a[i], b[i]) !== "unchanged") return "changed";
    return "unchanged";
  }
  return Object.is(a, b) ? "unchanged" : "changed";
}

export const CHANGE_LABEL: Record<Exclude<ChangeKind, "unchanged">, string> = { added: "Added", removed: "Removed", changed: "Changed" };

export function formatScalar(v: unknown): string {
  if (v === null || v === undefined || v === "") return "Not recorded";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

/** The one-line summary shown before the technical details. */
export function summariseGroup(group: Obj | null | undefined): string {
  if (!group) return "Comparison not available";
  const sha = typeof group.sha256 === "string" ? group.sha256 : typeof group.fileSha256 === "string" ? group.fileSha256 : null;
  const size =
    typeof group.sizeBytes === "number" || typeof group.sizeBytes === "string"
      ? group.sizeBytes
      : typeof group.bytes === "number" || typeof group.bytes === "string"
        ? group.bytes
        : null;
  const mime = typeof group.mimeType === "string" ? group.mimeType : typeof group.contentType === "string" ? group.contentType : null;
  const parts: string[] = [];
  if (mime) parts.push(mime);
  if (size) parts.push(`${size} B`);
  if (sha) parts.push(`SHA-256 ${String(sha).slice(0, 8)}…`);
  if (parts.length === 0) {
    const n = Object.keys(group).length;
    return n > 0 ? `${n} recorded field${n === 1 ? "" : "s"}` : "Recorded";
  }
  return parts.join(" · ");
}

/* ------------------------------------------------ the snapshot render model */

export type SnapNode =
  | { kind: "fact"; key: string; label: string; value: string; change: ChangeKind | null }
  | { kind: "section"; key: string; label: string; count: number | null; change: ChangeKind | null; items: SnapNode[][] | null; body: SnapNode[] | null; scalarItems: string[] | null };

function node(name: string, value: unknown, other: unknown, change: ChangeKind | null): SnapNode {
  if (Array.isArray(value)) {
    const counterpart = Array.isArray(other) ? other : undefined;
    const objects = value.every(isPlainObject);
    return {
      kind: "section",
      key: name,
      label: humaniseKey(name),
      count: value.length,
      change,
      items: objects
        ? value.map((item, i) => body(item as Obj, counterpart && isPlainObject(counterpart[i]) ? (counterpart[i] as Obj) : undefined, Boolean(counterpart)))
        : null,
      body: null,
      scalarItems: objects ? null : value.map((v) => (isPlainObject(v) || Array.isArray(v) ? JSON.stringify(v) : formatScalar(v))),
    };
  }
  if (isPlainObject(value)) {
    return { kind: "section", key: name, label: humaniseKey(name), count: null, change, items: null, body: body(value, isPlainObject(other) ? other : undefined, isPlainObject(other)), scalarItems: null };
  }
  return { kind: "fact", key: name, label: humaniseKey(name), value: formatScalar(value), change };
}

/** One level of a snapshot, scalars first, then nested; counterpart-only keys marked Removed. */
export function body(data: Obj, other: Obj | undefined, strict: boolean): SnapNode[] {
  const entries = Object.entries(data);
  const nested = (v: unknown) => isPlainObject(v) || Array.isArray(v);
  const comparable = (k: string) => Boolean(other && (strict || k in other));
  const absent = other ? Object.keys(other).filter((k) => !(k in data)) : [];
  const mark = (k: string, v: unknown) => (comparable(k) ? compareValues(v, other?.[k]) : null);
  return [
    ...entries.filter(([, v]) => !nested(v)).map(([k, v]) => node(k, v, other?.[k], mark(k, v))),
    ...absent.filter((k) => !nested(other?.[k])).map((k) => node(k, other?.[k], undefined, "removed")),
    ...entries.filter(([, v]) => nested(v)).map(([k, v]) => node(k, v, other?.[k], mark(k, v))),
    ...absent.filter((k) => nested(other?.[k])).map((k) => node(k, other?.[k], undefined, "removed")),
  ];
}

/* ------------------------------------------------------------ the payload */

export interface ComparisonGroup {
  title: string;
  data: Obj | null;
  /** The report's recorded trust decision, for the package card only. */
  compare: { fields: Obj; label: string } | null;
}

function hasAnyMismatchFlag(group: unknown): boolean {
  return isPlainObject(group) && Object.values(group).some((v) => v !== null && v !== undefined);
}

export function projectComparison(raw: unknown): ComparisonGroup[] {
  const d = isPlainObject(raw) ? raw : {};
  const g = (v: unknown): Obj | null => (isPlainObject(v) ? v : null);
  const report = g(d.reportArtifact);
  const snapshot = report?.trustDecisionSnapshot;
  const groups: ComparisonGroup[] = [
    { title: "Original record", data: g(d.original), compare: null },
    { title: "Reviewer preview", data: g(d.previewRepresentation), compare: null },
    { title: "Report artifact", data: report, compare: null },
    {
      title: "Verification package",
      data: g(d.verificationPackage),
      compare: snapshot === null || snapshot === undefined ? null : { fields: { trustDecisionSnapshot: snapshot }, label: "the report artifact" },
    },
  ];
  // The server hard-codes every mismatch flag to null today; an all-null card
  // would only leak scaffolding field names (web EVIDENCE-MISMATCH-HIDE).
  if (hasAnyMismatchFlag(d.mismatchFlags)) groups.push({ title: "Mismatch flags", data: g(d.mismatchFlags), compare: null });
  return groups;
}

export function compareLegend(label: string): string {
  return `Marked fields differ from ${label}. Unmarked fields match, or have no equivalent to compare.`;
}
