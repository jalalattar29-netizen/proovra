/**
 * AUD-005 — the DURABLE record of a screen capture that is being staged.
 *
 * Staging a single-frame capture used to be all-or-nothing in memory: one
 * network failure discarded the server session and deleted every PNG — the
 * only copy of what the user captured. The staging now persists its progress
 * (the native result with the frame files, the server session and reserved
 * record once they exist, each confirmed frame, the fixed manifest) the moment
 * it changes, so a Retry — or an app restart — resumes the SAME session
 * instead of starting over or losing the frames.
 *
 * Scoped to the signed-in user exactly like the capture-session store
 * (UC-AND-006): a per-user key, and a record carrying another owner is never
 * returned.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import { getCaptureSessionOwner } from "./capture-session-store";

const KEY_PREFIX = "proovra.screen.staging.v1:";

export type StagedFrameDeclaration = {
  partIndex: number;
  frameIndex: number;
  sha256Hex: string;
  sizeBytes: number;
  widthPx: number;
  heightPx: number;
  capturedAtOffsetMs: number;
};

export type PendingScreenFrame = {
  uri: string;
  frameIndex: number;
  widthPx: number;
  heightPx: number;
  capturedAtOffsetMs: number;
};

/** The native result, structurally (kept free of the native binding's types). */
export type PendingScreenResult = {
  osConsentGranted: boolean;
  captureStartedAtUtc: string;
  captureEndedAtUtc: string;
  device: unknown;
  frames: PendingScreenFrame[];
  stopReason: string;
  limitations: string[];
};

export type PendingScreenStaging = {
  result: PendingScreenResult;
  teamId: string | null;
  session: { captureSessionId: string; expiresAtUtc: string } | null;
  evidenceId: string | null;
  declared: StagedFrameDeclaration[];
  /** Fixed before its first upload: a retry uploads exactly these bytes. */
  manifest: { manifestJson: string; manifestPartIndex: number } | null;
  updatedAtIso: string;
};

export function screenStagingKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parseFrame(v: unknown): PendingScreenFrame | null {
  if (!v || typeof v !== "object") return null;
  const f = v as Record<string, unknown>;
  if (typeof f.uri !== "string" || !f.uri) return null;
  if (!isNum(f.frameIndex) || !isNum(f.widthPx) || !isNum(f.heightPx) || !isNum(f.capturedAtOffsetMs)) return null;
  return { uri: f.uri, frameIndex: f.frameIndex, widthPx: f.widthPx, heightPx: f.heightPx, capturedAtOffsetMs: f.capturedAtOffsetMs };
}

function parseDeclared(v: unknown): StagedFrameDeclaration | null {
  if (!v || typeof v !== "object") return null;
  const d = v as Record<string, unknown>;
  if (typeof d.sha256Hex !== "string" || !d.sha256Hex) return null;
  for (const k of ["partIndex", "frameIndex", "sizeBytes", "widthPx", "heightPx", "capturedAtOffsetMs"]) {
    if (!isNum(d[k])) return null;
  }
  return d as unknown as StagedFrameDeclaration;
}

/** PURE — defensive parse; a record for another user, or a malformed one, is null. */
export function parsePendingScreenStaging(raw: unknown, ownerUserId: string | null): PendingScreenStaging | null {
  if (!raw || typeof raw !== "object" || !ownerUserId) return null;
  const o = raw as Record<string, unknown>;
  if (o.ownerUserId !== ownerUserId) return null;
  const r = o.result as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object" || !Array.isArray(r.frames)) return null;
  const frames = r.frames.map(parseFrame);
  if (frames.some((f) => f === null) || frames.length === 0) return null;
  if (typeof r.captureStartedAtUtc !== "string" || typeof r.captureEndedAtUtc !== "string") return null;
  const s = o.session as Record<string, unknown> | null | undefined;
  const session =
    s && typeof s === "object" && typeof s.captureSessionId === "string" && s.captureSessionId
      ? { captureSessionId: s.captureSessionId, expiresAtUtc: typeof s.expiresAtUtc === "string" ? s.expiresAtUtc : "" }
      : null;
  const m = o.manifest as Record<string, unknown> | null | undefined;
  const manifest =
    m && typeof m === "object" && typeof m.manifestJson === "string" && isNum(m.manifestPartIndex)
      ? { manifestJson: m.manifestJson, manifestPartIndex: m.manifestPartIndex }
      : null;
  const declared = Array.isArray(o.declared) ? o.declared.map(parseDeclared).filter((d): d is StagedFrameDeclaration => d !== null) : [];
  return {
    result: {
      osConsentGranted: r.osConsentGranted === true,
      captureStartedAtUtc: r.captureStartedAtUtc,
      captureEndedAtUtc: r.captureEndedAtUtc,
      device: r.device,
      frames: frames as PendingScreenFrame[],
      stopReason: typeof r.stopReason === "string" ? r.stopReason : "UNKNOWN",
      limitations: Array.isArray(r.limitations) ? r.limitations.filter((l): l is string => typeof l === "string") : [],
    },
    teamId: typeof o.teamId === "string" && o.teamId ? o.teamId : null,
    session,
    evidenceId: session && typeof o.evidenceId === "string" && o.evidenceId ? o.evidenceId : null,
    declared: session ? declared : [],
    manifest: session ? manifest : null,
    updatedAtIso: typeof o.updatedAtIso === "string" ? o.updatedAtIso : new Date(0).toISOString(),
  };
}

export async function savePendingScreenStaging(record: PendingScreenStaging): Promise<void> {
  const owner = getCaptureSessionOwner();
  if (!owner) return;
  try {
    await AsyncStorage.setItem(screenStagingKey(owner), JSON.stringify({ ...record, ownerUserId: owner }));
  } catch {
    // Best-effort: the in-memory staging still proceeds; only a restart loses it.
  }
}

export async function loadPendingScreenStaging(): Promise<PendingScreenStaging | null> {
  const owner = getCaptureSessionOwner();
  if (!owner) return null;
  try {
    const raw = await AsyncStorage.getItem(screenStagingKey(owner));
    return raw ? parsePendingScreenStaging(JSON.parse(raw), owner) : null;
  } catch {
    return null;
  }
}

export async function clearPendingScreenStaging(): Promise<void> {
  const owner = getCaptureSessionOwner();
  if (!owner) return;
  try {
    await AsyncStorage.removeItem(screenStagingKey(owner));
  } catch {
    // Harmless: the next staging overwrites it.
  }
}
