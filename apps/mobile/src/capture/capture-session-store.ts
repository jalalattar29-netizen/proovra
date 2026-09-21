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

const STORAGE_KEY = "proovra.capture.session.v1";
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

export interface PersistedCaptureSession {
  captureSessionId: string;
  expiresAtUtc: string;
  evidenceId: string;
  type: PersistedCaptureType;
  items: PersistedCapturedItem[];
  /** ISO timestamp of the last persist — drives the staleness policy. */
  updatedAtIso: string;
}

export interface CaptureSessionInput {
  captureSessionId: string;
  expiresAtUtc: string;
  evidenceId: string;
  type: PersistedCaptureType;
  items: Array<Omit<PersistedCapturedItem, never>>;
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
  return {
    captureSessionId,
    expiresAtUtc: typeof o.expiresAtUtc === "string" ? o.expiresAtUtc : "",
    evidenceId,
    type,
    items,
    updatedAtIso: typeof o.updatedAtIso === "string" ? o.updatedAtIso : new Date(0).toISOString(),
  };
}

/* ----------------------------------------------------------- AsyncStorage IO */

export async function saveCaptureSession(input: CaptureSessionInput): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(serializeSession(input)));
  } catch {
    // Durability is best-effort; a failed persist must never break live capture.
  }
}

export async function loadCaptureSession(): Promise<PersistedCaptureSession | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return validatePersisted(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function clearCaptureSession(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // A failed clear is harmless — the next resumable check re-validates.
  }
}
