/**
 * UC-AND-006 — capture ends with the account session.
 *
 * Signing out used to leave a MediaProjection foreground service recording the
 * screen (up to the session bound) and left the staged / live capture records
 * on the device for the next account. Sign-out now runs this BEFORE the token
 * is revoked, so the server sessions can still be discarded:
 *
 *   1. stop any native capture (continuous recording, frame session);
 *   2. discard every open direct-capture session this device holds for the
 *      user (the live continuous one and the staged one) — their reserved
 *      records are released instead of waiting for the reaper;
 *   3. delete the local spool (segment/frame files the records name);
 *   4. clear both durable records and unbind the store owner.
 *
 * Every step is best-effort and isolated: a failure in one never stops the
 * others, and never blocks the sign-out itself.
 */
import * as FileSystem from "expo-file-system";

import {
  discardContinuousSpool,
  getContinuousSegments,
  getScreenCaptureState,
  getScreenContinuousState,
  stopContinuousCapture,
  stopScreenCapture,
} from "../../modules/proovra-screen-capture";
import { discardDirectCaptureSession } from "../direct-capture";
import { clearCaptureSession, loadCaptureSession, setCaptureSessionOwner } from "./capture-session-store";
import { clearLiveContinuousSession, loadLiveContinuousSession } from "./continuous-session-store";

async function quietly(step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch {
    // Isolated: the next step still runs.
  }
}

async function deleteQuietly(uri: string | null | undefined): Promise<void> {
  if (!uri) return;
  await quietly(() => FileSystem.deleteAsync(uri, { idempotent: true }));
}

export async function teardownCaptureOnSignOut(): Promise<void> {
  // 1. Native capture stops first: nothing more is recorded after sign-out.
  const localFiles = new Set<string>();
  await quietly(async () => {
    if (getScreenContinuousState().active) {
      for (const s of getContinuousSegments()) localFiles.add(s.uri);
      await stopContinuousCapture();
    }
  });
  await quietly(async () => {
    if (getScreenCaptureState().active) {
      const r = await stopScreenCapture();
      for (const f of r?.frames ?? []) localFiles.add(f.uri);
    }
  });

  // 2. Release the open server sessions while the token is still valid.
  const live = await loadLiveContinuousSession();
  const staged = await loadCaptureSession();
  const sessions = new Map<string, string>();
  if (live) sessions.set(live.captureSessionId, live.expiresAtUtc);
  if (staged) {
    sessions.set(staged.captureSessionId, staged.expiresAtUtc);
    for (const it of staged.items) if (it.uri) localFiles.add(it.uri);
  }
  for (const [captureSessionId, expiresAtUtc] of sessions) {
    await quietly(() => discardDirectCaptureSession({ captureSessionId, expiresAtUtc }));
  }

  // 3. The local spool (files named by the records, then the recorder's own).
  for (const uri of localFiles) await deleteQuietly(uri);
  await quietly(() => discardContinuousSpool());

  // 4. The durable records, then the owner binding.
  await quietly(() => clearLiveContinuousSession());
  await quietly(() => clearCaptureSession());
  setCaptureSessionOwner(null);
}
