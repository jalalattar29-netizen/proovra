/**
 * CANONICAL DURABLE CAPTURE-SESSION STORE (Master Program §11, M5) — the ONE
 * owner of capture-session durability. Persists just enough metadata to survive
 * app background / process death and RESUME an interrupted session, without ever
 * touching the protected direct-capture engine (src/direct-capture.ts is
 * read-only here). The engine's session handle is `{ captureSessionId,
 * expiresAtUtc }` — fully serializable — so a restored session can finish or be
 * discarded exactly like a live one.
 *
 * This is NOT the dead upload-queue.ts (which nothing enqueued): there is one
 * store, one key, keyed on the server-issued session, with per-item upload state
 * so resume never re-uploads an item already sealed at storage (no duplicates).
 *
 * The pure functions (serialize / staleness / resumability / pendingItems /
 * validatePersisted) carry all the policy and are unit-tested; the AsyncStorage
 * IO wrappers are thin and defensive (every read/write is try/caught).
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  isScreenAcquisitionMode,
  type ScreenAcquisitionMode,
} from "./screen-acquisition";

/**
 * UC-AND-006 — the store is SCOPED TO THE SIGNED-IN USER. The v1 key was one
 * constant for the whole device, so the next account to sign in on a shared
 * phone was offered the previous user's staged capture (session id, record id,
 * manifest). Records now live under the owner's key and carry the owner id; a
 * read for anyone else returns nothing. The unscoped v1 record cannot be
 * attributed to anyone, so it is removed on first read, never offered.
 */
const LEGACY_STORAGE_KEY = "proovra.capture.session.v1";
const STORAGE_KEY_PREFIX = "proovra.capture.session.v2:";

let captureSessionOwner: string | null = null;

/** Bound by the auth provider to the signed-in user (null when signed out). */
export function setCaptureSessionOwner(userId: string | null | undefined): void {
  captureSessionOwner = typeof userId === "string" && userId.length > 0 ? userId : null;
}

export function getCaptureSessionOwner(): string | null {
  return captureSessionOwner;
}

/** The storage key for one user's durable capture session. */
export function captureSessionStorageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}
/** A staged session older than this (by last update) is stale — resume refused. */
export const CAPTURE_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

export type PersistedCaptureType = "PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT";

export interface PersistedCapturedItem {
  id: string;
  uri: string;
  mimeType: string;
  partIndex: number;
  originalFilename?: string;
  source: string;
  sizeBytes?: number;
  durationMs?: number;
  /** True once the part was declared + PUT to storage (skip on resume). */
  uploaded: boolean;
}

/**
 * A screen acquisition carried on the session, when one produced it.
 *
 * The manifest is built by the acquiring surface at Stop — it is the record of
 * what the device actually captured, including frame order and whether the
 * session was interrupted — and is handed to the completion route at finalize.
 * Carrying it here is what lets the canonical Capture surface finish a
 * recording the user started on another screen.
 */
export interface PersistedScreenAcquisition {
  mode: ScreenAcquisitionMode;
  manifestJson: string;
}

export interface PersistedCaptureSession {
  captureSessionId: string;
  expiresAtUtc: string;
  evidenceId: string;
  type: PersistedCaptureType;
  items: PersistedCapturedItem[];
  /**
   * Absent for an ordinary phone capture (PROOVRA_MOBILE_APP), present when a
   * screen engine acquired the session. It decides which completion route
   * seals it; see `screenSealPath`.
   */
  acquisition?: PersistedScreenAcquisition | null;
  /**
   * The canonical `/v1/capture/sessions` DRAFT this session stages into.
   * Kept so a resumed session updates and closes THAT draft, rather than
   * leaving it behind as an unfinished draft nothing can reach.
   */
  draftId?: string | null;
  /** ISO timestamp of the last persist — drives the staleness policy. */
  updatedAtIso: string;
  /** UC-AND-006 — the user this record belongs to. */
  ownerUserId?: string | null;
}

export interface CaptureSessionInput {
  captureSessionId: string;
  expiresAtUtc: string;
  evidenceId: string;
  type: PersistedCaptureType;
  items: Array<Omit<PersistedCapturedItem, never>>;
  acquisition?: PersistedScreenAcquisition | null;
  draftId?: string | null;
  now?: number;
}

/** Build the persisted record (pure). Stamps updatedAt for the staleness policy. */
export function serializeSession(input: CaptureSessionInput): PersistedCaptureSession {
  const now = input.now ?? Date.now();
  return {
    captureSessionId: input.captureSessionId,
    expiresAtUtc: input.expiresAtUtc,
    evidenceId: input.evidenceId,
    type: input.type,
    items: input.items.map((it) => ({
      id: it.id,
      uri: it.uri,
      mimeType: it.mimeType,
      partIndex: it.partIndex,
      originalFilename: it.originalFilename,
      source: it.source,
      sizeBytes: it.sizeBytes,
      durationMs: it.durationMs,
      uploaded: !!it.uploaded,
    })),
    acquisition: input.acquisition ?? null,
    draftId: input.draftId ?? null,
    updatedAtIso: new Date(now).toISOString(),
  };
}

/**
 * Stale = the server session expired (expiresAtUtc in the past) OR the local
 * record hasn't been touched within the max age. A stale session can only be
 * discarded — it cannot be completed against an expired server session.
 */
export function isSessionStale(s: PersistedCaptureSession, nowMs: number = Date.now()): boolean {
  if (s.expiresAtUtc) {
    const exp = Date.parse(s.expiresAtUtc);
    if (Number.isFinite(exp) && exp <= nowMs) return true;
  }
  const updated = Date.parse(s.updatedAtIso);
  if (Number.isFinite(updated) && nowMs - updated > CAPTURE_SESSION_MAX_AGE_MS) return true;
  return false;
}

/** Resumable = a well-formed, non-stale session that still has staged items. */
export function isSessionResumable(s: PersistedCaptureSession | null, nowMs: number = Date.now()): boolean {
  if (!s) return false;
  if (!s.captureSessionId || !s.evidenceId) return false;
  if (s.items.length === 0) return false;
  return !isSessionStale(s, nowMs);
}

/** Items not yet uploaded — the only ones a resumed completion should PUT. */
export function pendingItems(items: PersistedCapturedItem[]): PersistedCapturedItem[] {
  return items.filter((it) => !it.uploaded);
}

/** Defensive parse of a stored blob → a valid record, or null. Never throws. */
export function validatePersisted(raw: unknown): PersistedCaptureSession | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const captureSessionId = typeof o.captureSessionId === "string" ? o.captureSessionId : null;
  const evidenceId = typeof o.evidenceId === "string" ? o.evidenceId : null;
  const type = o.type;
  if (!captureSessionId || !evidenceId) return null;
  if (type !== "PHOTO" && type !== "VIDEO" && type !== "AUDIO" && type !== "DOCUMENT") return null;
  if (!Array.isArray(o.items)) return null;
  const items: PersistedCapturedItem[] = [];
  for (const raw2 of o.items) {
    if (!raw2 || typeof raw2 !== "object") return null;
    const it = raw2 as Record<string, unknown>;
    if (typeof it.id !== "string" || typeof it.uri !== "string" || typeof it.mimeType !== "string") return null;
    if (typeof it.partIndex !== "number") return null;
    items.push({
      id: it.id,
      uri: it.uri,
      mimeType: it.mimeType,
      partIndex: it.partIndex,
      originalFilename: typeof it.originalFilename === "string" ? it.originalFilename : undefined,
      source: typeof it.source === "string" ? it.source : "CAMERA",
      sizeBytes: typeof it.sizeBytes === "number" ? it.sizeBytes : undefined,
      durationMs: typeof it.durationMs === "number" ? it.durationMs : undefined,
      uploaded: !!it.uploaded,
    });
  }
  // An acquisition that does not name a mode this build knows is dropped
  // rather than carried: sealing by a mode we cannot map would pick a
  // completion route by default, and the default is the wrong one for a
  // continuous recording. A dropped acquisition leaves an ordinary session,
  // which the surface then refuses to seal as a screen capture.
  let acquisition: PersistedScreenAcquisition | null = null;
  const rawAcq = o.acquisition;
  if (rawAcq && typeof rawAcq === "object") {
    const a = rawAcq as Record<string, unknown>;
    if (isScreenAcquisitionMode(a.mode) && typeof a.manifestJson === "string" && a.manifestJson) {
      acquisition = { mode: a.mode, manifestJson: a.manifestJson };
    }
  }

  return {
    captureSessionId,
    expiresAtUtc: typeof o.expiresAtUtc === "string" ? o.expiresAtUtc : "",
    evidenceId,
    type,
    items,
    acquisition,
    draftId: typeof o.draftId === "string" && o.draftId ? o.draftId : null,
    updatedAtIso: typeof o.updatedAtIso === "string" ? o.updatedAtIso : new Date(0).toISOString(),
    ownerUserId: typeof o.ownerUserId === "string" && o.ownerUserId ? o.ownerUserId : null,
  };
}

/** PURE — a stored record is readable only by the user it belongs to. */
export function isRecordOwnedBy(record: PersistedCaptureSession | null, userId: string | null): boolean {
  if (!record || !userId) return false;
  return record.ownerUserId === userId;
}

/* ----------------------------------------------------------- AsyncStorage IO */

export async function saveCaptureSession(input: CaptureSessionInput): Promise<void> {
  const owner = captureSessionOwner;
  if (!owner) return; // nobody signed in: nothing may be persisted for "the device"
  try {
    await AsyncStorage.setItem(
      captureSessionStorageKey(owner),
      JSON.stringify({ ...serializeSession(input), ownerUserId: owner }),
    );
  } catch {
    // Durability is best-effort; a failed persist must never break live capture.
  }
}

export async function loadCaptureSession(): Promise<PersistedCaptureSession | null> {
  try {
    await AsyncStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Best-effort purge of the unattributable v1 record.
  }
  const owner = captureSessionOwner;
  if (!owner) return null;
  try {
    const raw = await AsyncStorage.getItem(captureSessionStorageKey(owner));
    if (!raw) return null;
    const record = validatePersisted(JSON.parse(raw));
    return isRecordOwnedBy(record, owner) ? record : null;
  } catch {
    return null;
  }
}

export async function clearCaptureSession(): Promise<void> {
  const owner = captureSessionOwner;
  if (!owner) return;
  try {
    await AsyncStorage.removeItem(captureSessionStorageKey(owner));
  } catch {
    // A failed clear is harmless — the next resumable check re-validates.
  }
}
