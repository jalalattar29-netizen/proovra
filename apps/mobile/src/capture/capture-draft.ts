/**
 * CANONICAL CAPTURE DRAFT — the native client for `/v1/capture/sessions`.
 *
 * This is NOT a new product layer. It is the native client for the capture
 * lifecycle the product already has, which native was not using.
 *
 * WHAT THE CANONICAL LIFECYCLE IS (capture.routes.ts, verbatim from its header:
 * "Finalization is initiated by the existing Evidence routes; this module just
 * records that the draft has been finalized"):
 *
 *   POST   /v1/capture/sessions        open a DRAFT — no bytes, NO Evidence
 *   PATCH  /v1/capture/sessions/:id    stage items into itemsSnapshot
 *   DELETE /v1/capture/sessions/:id    discard — nothing was ever committed
 *   …then Evidence is created ONCE, at finalize, with captureSessionId set.
 *
 * Evidence is created AT FINALIZE. That is §8's law, and the canonical model
 * already satisfied it.
 *
 * WHAT UC-0 GOT WRONG, AND WHAT IT IS FOR
 *
 * `/v1/capture/direct-sessions` reserved the Evidence record on the FIRST
 * staged item, which is why Discard left an orphan and why a session was locked
 * to one media type. But UC-0 is not redundant: `POST /v1/evidence` hardcodes
 * `acquisitionMode: "PROOVRA_WEB_UPLOAD"` — "the acquisition is this route's
 * constant, never a body field" — so a native capture submitted through it
 * would carry a FALSE provenance claim. UC-0 is the native ingress that stamps
 * PROOVRA_MOBILE_APP honestly, plus the server nonce and per-part digest
 * declaration.
 *
 * So the two are not competing lifecycles once each is put in its place:
 *
 *   product lifecycle   →  /v1/capture/sessions     (draft, staging, discard)
 *   acquisition/sealing →  /v1/capture/direct-sessions (invoked AT finalize)
 *
 * No third model, no staging-plan layer, no backend change.
 *
 * Pure except for `apiFetch`; the shaping functions are exported for tests.
 */
import { apiFetch } from "../api";

/** Evidence types, as the canonical schema defines them. */
export type CaptureItemKind = "PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT";

/** One staged item, in the canonical `CaptureSessionItemSchema` shape. */
export interface DraftItemInput {
  clientItemId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  durationMs?: number | null;
  /** Where the app took it from — client-reported, recorded as such. */
  sourceLabel?: string | null;
  uploadState?: "pending" | "uploading" | "uploaded" | "failed";
  /*
   * THE PLAN FIELDS, which `CaptureSessionItemSchema` has always accepted.
   *
   * The native draft was not sending them, so an item captured on a phone
   * reached the session with no role and no context note — and the readiness
   * the web computes from exactly those fields had nothing to read. They are
   * the operator's words about what an item IS and why it was taken; dropping
   * them on the way to the server loses them permanently.
   */
  role?: string | null;
  privateNote?: string | null;
  checklistStepId?: string | null;
}

export interface CaptureDraft {
  id: string;
  status: string;
}

/**
 * The Evidence type for a finalized session.
 *
 * Mirrors the canonical `deriveBatchEvidenceType`: a session whose items are
 * all one kind keeps that kind; a MIXED session is DOCUMENT. That rule is what
 * makes mixed media expressible at all — the record is one Evidence with many
 * parts, exactly as the web produces, so nothing about the evidence shape
 * changes just because the items were captured on a phone.
 */
export function deriveBatchEvidenceType(
  mimeTypes: readonly string[],
): CaptureItemKind {
  const kinds = new Set(mimeTypes.map(inferKindFromMimeType));
  if (kinds.size === 1) return [...kinds][0] ?? "DOCUMENT";
  return "DOCUMENT";
}

/** Canonical MIME → Evidence type, matching `inferEvidenceTypeFromMimeType`. */
export function inferKindFromMimeType(mimeType: string): CaptureItemKind {
  const m = (mimeType || "").toLowerCase();
  if (m.startsWith("image/")) return "PHOTO";
  if (m.startsWith("video/")) return "VIDEO";
  if (m.startsWith("audio/")) return "AUDIO";
  return "DOCUMENT";
}

/** The primary item — the one whose filename and MIME the Evidence carries. */
export function primaryItem<T extends { mimeType: string }>(items: readonly T[]): T | null {
  return items[0] ?? null;
}

/** Shape staged items for the canonical `itemsSnapshot`. */
export function toDraftItems(items: readonly DraftItemInput[]) {
  return items.map((it) => ({
    clientItemId: it.clientItemId,
    fileName: it.fileName,
    mimeType: it.mimeType,
    sizeBytes: Math.max(0, Math.trunc(it.sizeBytes || 0)),
    durationMs: it.durationMs ?? null,
    sourceLabel: it.sourceLabel ?? null,
    role: it.role ?? null,
    privateNote: it.privateNote ?? null,
    checklistStepId: it.checklistStepId ?? null,
    uploadState: it.uploadState ?? "pending",
  }));
}

/* ------------------------------------------------------------------- calls */

/** Open a DRAFT. No bytes, no Evidence — nothing is committed by this call. */
export async function openCaptureDraft(input: {
  teamId?: string | null;
  useLocation?: boolean;
  items?: readonly DraftItemInput[];
  /** The collection plan the operator chose, snapshotted by the server. */
  templateId?: string | null;
  /** The web Intake structure: Guided (CHECKLIST_REQUIRED) or Flexible. */
  planMode?: "FLEXIBLE" | "CHECKLIST_REQUIRED";
}): Promise<CaptureDraft> {
  const res = await apiFetch("/v1/capture/sessions", {
    method: "POST",
    body: JSON.stringify({
      // Omitted teamId means PERSONAL scope, which the server resolves and
      // gates itself (a managed identity with no personal space is refused
      // before any row is written).
      ...(input.teamId ? { teamId: input.teamId } : {}),
      // Absent, not null: the create body takes `templateId?` and sending an
      // empty one would record a plan that was not chosen.
      ...(input.templateId ? { templateId: input.templateId } : {}),
      ...(input.planMode ? { planMode: input.planMode } : {}),
      useLocation: !!input.useLocation,
      items: toDraftItems(input.items ?? []),
    }),
  });
  const s = res?.session as { id?: string; status?: string } | undefined;
  if (!s?.id) throw new Error("Could not start the capture session.");
  return { id: s.id, status: s.status ?? "DRAFT" };
}

/** Persist the staged items. The draft is the durable record of the session. */
export async function updateCaptureDraft(
  draftId: string,
  input: {
    items: readonly DraftItemInput[];
    useLocation?: boolean;
    /**
     * The chosen plan, or `null` to clear one.
     *
     * The PATCH body takes `templateId?: string | null`, so null is
     * meaningful here — it is how an operator un-chooses a plan — and
     * `undefined` leaves whatever the session already records.
     */
    templateId?: string | null;
    planMode?: "FLEXIBLE" | "CHECKLIST_REQUIRED";
  },
): Promise<void> {
  await apiFetch(`/v1/capture/sessions/${draftId}`, {
    method: "PATCH",
    body: JSON.stringify({
      items: toDraftItems(input.items),
      ...(input.useLocation === undefined ? {} : { useLocation: input.useLocation }),
      ...(input.templateId === undefined ? {} : { templateId: input.templateId }),
      ...(input.planMode === undefined ? {} : { planMode: input.planMode }),
    }),
  });
}

/**
 * Discard the draft.
 *
 * Correct by construction: a DRAFT holds no Evidence, so there is nothing to
 * release and nothing to tombstone. This is why moving staging onto the
 * canonical session fixes the discard defect at its root rather than patching
 * the consequence.
 */
export async function discardCaptureDraft(draftId: string): Promise<void> {
  await apiFetch(`/v1/capture/sessions/${draftId}`, { method: "DELETE" });
}

/**
 * One staged item as the server returns it in `session.items`
 * (capture.routes.ts `toApiSession`: `items: s.itemsSnapshot ?? []`).
 */
export interface DraftSnapshotItem {
  clientItemId: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  role: string | null;
  privateNote: string | null;
  checklistStepId: string | null;
  sourceLabel: string | null;
}

/** A DRAFT session as `toApiSession` (capture.routes.ts:127) sends it. */
export interface CaptureDraftDetail {
  id: string;
  status: string;
  templateId: string | null;
  templateName: string | null;
  planMode: "FLEXIBLE" | "CHECKLIST_REQUIRED" | null;
  internalNotes: string | null;
  useLocation: boolean;
  expiresAtUtc: string | null;
  updatedAt: string | null;
  items: DraftSnapshotItem[];
}

const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function toSnapshotItem(raw: unknown): DraftSnapshotItem {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    clientItemId: text(r.clientItemId),
    fileName: text(r.fileName),
    mimeType: text(r.mimeType),
    sizeBytes: typeof r.sizeBytes === "number" ? r.sizeBytes : null,
    role: text(r.role),
    privateNote: text(r.privateNote),
    checklistStepId: text(r.checklistStepId),
    sourceLabel: text(r.sourceLabel),
  };
}

/**
 * Parse one `toApiSession` row. The staged items travel under `items` — the
 * column is `itemsSnapshot`, but the reply never uses that name, so a reader
 * looking for it found nothing on every real response.
 */
export function parseCaptureDraft(raw: unknown): CaptureDraftDetail | null {
  const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const id = text(s?.id);
  if (!s || !id) return null;
  const planMode = s.planMode === "FLEXIBLE" || s.planMode === "CHECKLIST_REQUIRED" ? s.planMode : null;
  return {
    id,
    status: text(s.status) ?? "DRAFT",
    templateId: text(s.templateId),
    templateName: text(s.templateName),
    planMode,
    internalNotes: text(s.internalNotes),
    useLocation: s.useLocation === true,
    expiresAtUtc: text(s.expiresAtUtc),
    updatedAt: text(s.updatedAt),
    items: Array.isArray(s.items) ? s.items.map(toSnapshotItem) : [],
  };
}

/** Read a draft back (`GET /v1/capture/sessions/:id` → `{ session }`). */
export async function readCaptureDraft(draftId: string): Promise<CaptureDraftDetail | null> {
  try {
    const res = await apiFetch(`/v1/capture/sessions/${draftId}`);
    return parseCaptureDraft(res?.session);
  } catch {
    return null;
  }
}

/**
 * The operator's unfinished drafts — the web `useCaptureDraftList`
 * (`GET /v1/capture/sessions?status=DRAFT` → `{ sessions }`, capture.routes.ts:216).
 */
export async function listCaptureDrafts(): Promise<CaptureDraftDetail[]> {
  const res = await apiFetch("/v1/capture/sessions?status=DRAFT");
  const rows = Array.isArray(res?.sessions) ? (res.sessions as unknown[]) : [];
  return rows.map(parseCaptureDraft).filter((d): d is CaptureDraftDetail => d !== null && d.status === "DRAFT");
}

/** A draft is resumable only while it is still a DRAFT. */
export function isDraftResumable(status: string | null | undefined): boolean {
  return status === "DRAFT";
}
