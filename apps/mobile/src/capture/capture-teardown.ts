/**
 * UC-AND-006 — capture ends with the account session.
 *
 * Signing out used to leave a MediaProjection foreground service recording the
 * screen (up to the session bound). Sign-out stops native capture first, so
 * nothing more is recorded under the ending session.
 *
 * What was captured is NOT destroyed (PRO-NBC-03 / DEC-24, below): the staged
 * and live capture records are keyed by their owner, so the next account on the
 * device cannot read them, and the person who signs back in can still finish
 * them or discard them explicitly.
 */
import {
  getContinuousSegments,
  getScreenCaptureState,
  getScreenContinuousState,
  stopContinuousCapture,
  stopScreenCapture,
} from "../../modules/proovra-screen-capture";

async function quietly(step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch {
    // Isolated: the next step still runs.
  }
}

/** Stops the recorders, adding whatever they hold to `localFiles`. */
async function stopNativeCapture(localFiles: Set<string>): Promise<void> {
  await quietly(async () => {
    // AUD-006 — iOS names the recording (the focused one, else the live broadcast).
    const native = getScreenContinuousState();
    if (native.active) {
      const recordingId = native.recordingId ?? null;
      for (const s of getContinuousSegments(recordingId)) localFiles.add(s.uri);
      const stopped = (await stopContinuousCapture(recordingId)) as { recordingUri?: unknown } | null | undefined;
      // A SINGLE_FILE build hands back its one recording file instead of segments.
      if (typeof stopped?.recordingUri === "string" && stopped.recordingUri) localFiles.add(stopped.recordingUri);
    }
  });
  await quietly(async () => {
    if (getScreenCaptureState().active) {
      const r = await stopScreenCapture();
      for (const f of r?.frames ?? []) localFiles.add(f.uri);
    }
  });
}

/**
 * A session the SERVER ended (MOBILE-008) is not a sign-out. Nothing more should
 * be recorded under it, but the token is already dead, so no server session can
 * be released, and the person may sign straight back in: the staged records and
 * files stay, under their owner, for Capture to offer.
 */
export async function stopCaptureOnSessionEnd(): Promise<void> {
  await stopNativeCapture(new Set());
}

/**
 * PRO-NBC-03 / PRO-NA-13 / DEC-24 — SIGNING OUT IS NOT CONSENT TO DELETE EVIDENCE.
 *
 * Sign-out (and an account switch) used to discard every open server capture
 * session, delete the staged files and clear the records — BEFORE the server
 * sign-out was even known to succeed, so a failed sign-out kept the person
 * signed in with their staged captures already gone, and a successful one
 * destroyed screen captures whose device copies had been deleted once their
 * parts were staged.
 *
 * Now sign-out only STOPS capture (nothing more is recorded under the ending
 * session; a recorder's output is kept). Every record, its files and its server
 * session stay where they are: the records are keyed by their owner, so no
 * other account on this device can read them (UC-AND-006 holds by the owner
 * key, not by destruction), the server keeps a staged session for its 24 h
 * lifetime, and the same person signing back in is offered them to finish or
 * to discard explicitly. Unfinished evidence is removed only by an explicit,
 * informed discard.
 */
export async function teardownCaptureOnSignOut(): Promise<void> {
  await stopNativeCapture(new Set());
}
