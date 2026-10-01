/**
 * UC-AND-004 / UC-IOS-010 — the DURABLE record of a LIVE continuous recording.
 *
 * The continuous screen kept its server session, reserved record and declared
 * segments only in React refs, so a recreated JS context (the UI swiped away,
 * an OOM kill of the activity, an iOS relaunch while the broadcast extension
 * kept recording) lost them: the recording was orphaned, its segments never
 * uploaded, and the next Start opened a second session. This record is written
 * the moment the server session opens and after every declared segment, and
 * cleared only when the recording is staged (the capture-session store then
 * owns it) or explicitly discarded.
 *
 * It is scoped to the signed-in user exactly like the capture-session store
 * (UC-AND-006): same owner binding, a per-user key, and a record carrying its
 * owner is never returned to anyone else.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import type { DeclaredSegment } from "../continuous-manifest";
import { getCaptureSessionOwner } from "./capture-session-store";

const KEY_PREFIX = "proovra.continuous.live.v1:";

export type LiveContinuousSession = {
  captureSessionId: string;
  evidenceId: string;
  expiresAtUtc: string;
  platform: "android" | "ios";
  declared: DeclaredSegment[];
  clientLimitations: string[];
  openedAtIso: string;
  ownerUserId: string;
};

export function liveContinuousSessionKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

function isDeclaredSegment(v: unknown): v is DeclaredSegment {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.partIndex === "number" &&
    typeof d.sequence === "number" &&
    typeof d.sha256Hex === "string" &&
    typeof d.sizeBytes === "number" &&
    typeof d.startedAtOffsetMs === "number" &&
    typeof d.durationMs === "number" &&
    typeof d.widthPx === "number" &&
    typeof d.heightPx === "number" &&
    (d.orientation === "portrait" || d.orientation === "landscape")
  );
}

/** PURE — defensive parse; a record for another user is `null`. */
export function parseLiveContinuousSession(raw: unknown, ownerUserId: string | null): LiveContinuousSession | null {
  if (!raw || typeof raw !== "object" || !ownerUserId) return null;
  const o = raw as Record<string, unknown>;
  if (o.ownerUserId !== ownerUserId) return null;
  if (typeof o.captureSessionId !== "string" || !o.captureSessionId) return null;
  if (typeof o.evidenceId !== "string" || !o.evidenceId) return null;
  if (o.platform !== "android" && o.platform !== "ios") return null;
  const declared = Array.isArray(o.declared) ? o.declared.filter(isDeclaredSegment) : [];
  return {
    captureSessionId: o.captureSessionId,
    evidenceId: o.evidenceId,
    expiresAtUtc: typeof o.expiresAtUtc === "string" ? o.expiresAtUtc : "",
    platform: o.platform,
    declared,
    clientLimitations: Array.isArray(o.clientLimitations)
      ? o.clientLimitations.filter((l): l is string => typeof l === "string")
      : [],
    openedAtIso: typeof o.openedAtIso === "string" ? o.openedAtIso : new Date(0).toISOString(),
    ownerUserId,
  };
}

export async function saveLiveContinuousSession(
  record: Omit<LiveContinuousSession, "ownerUserId">,
): Promise<void> {
  const owner = getCaptureSessionOwner();
  if (!owner) return;
  try {
    await AsyncStorage.setItem(liveContinuousSessionKey(owner), JSON.stringify({ ...record, ownerUserId: owner }));
  } catch {
    // Best-effort: a failed persist must never break a live recording.
  }
}

export async function loadLiveContinuousSession(): Promise<LiveContinuousSession | null> {
  const owner = getCaptureSessionOwner();
  if (!owner) return null;
  try {
    const raw = await AsyncStorage.getItem(liveContinuousSessionKey(owner));
    return raw ? parseLiveContinuousSession(JSON.parse(raw), owner) : null;
  } catch {
    return null;
  }
}

export async function clearLiveContinuousSession(): Promise<void> {
  const owner = getCaptureSessionOwner();
  if (!owner) return;
  try {
    await AsyncStorage.removeItem(liveContinuousSessionKey(owner));
  } catch {
    // Harmless: the next open overwrites it.
  }
}
