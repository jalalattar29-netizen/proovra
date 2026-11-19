/**
 * PRO-NBC-03 (review gaps 1 and 2) / DEC-24 — WHO OWNS WHAT THE NATIVE RECORDERS
 * LEFT ON THIS DEVICE.
 *
 * Sign-out no longer deletes captured evidence, so the native side can hold a
 * signed-out person's material when the next account signs in on a shared
 * device: the single-frame ledger (recovered screen frames) and the continuous
 * recording (Android's one ledger, iOS's broadcast recordings). The JS stores
 * are keyed by their owner; the native ledgers were not gated on every read
 * path, so another account was offered the frames for review and was told to
 * discard the recording ("no capture session holds it").
 *
 * Every read path now asks this module first. Ownership comes from, in order:
 *
 *   1. the owner the NATIVE ledger recorded when it was written (Android, from
 *      the build that carries the owner field);
 *   2. the device-wide CLAIM this module records: when a capture starts, and at
 *      sign-out / session end for anything not yet claimed (a recording made by
 *      an earlier build, an iOS broadcast recording, an unbound recording);
 *   3. nothing at all: the residue is unclaimed. Only an account that has been
 *      signed in ever since the capture can meet it (a sign-out would have
 *      claimed it), so it is that account's, and is claimed for it on sight.
 *
 * "foreign" residue is never offered, never discarded and never overwritten by
 * the account that is looking at it; it waits for its owner.
 *
 * The claim map holds ids and account ids only (no evidence, no file paths);
 * it is device-wide on purpose — an owner-keyed store could not answer "does
 * this belong to somebody else".
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  clearScreenCaptureLedger,
  getContinuousLedger,
  getRecoveredScreenCapture,
  getRecoveredScreenCaptureOwner,
  listContinuousRecordings,
  type ScreenCaptureResult,
} from "../../modules/proovra-screen-capture";

const CLAIMS_KEY = "proovra.capture.native-residue-owners.v1";
/** Bounded: the oldest claims go first (a device holds a handful of recordings at most). */
const MAX_CLAIMS = 64;

export type ResidueOwnership = "own" | "foreign" | "unclaimed";

type Claim = { id: string; ownerUserId: string };

/** The claim id of a single-frame capture (the native ledger's start instant). */
export function frameResidueId(captureStartedAtUtc: string | null | undefined): string | null {
  return typeof captureStartedAtUtc === "string" && captureStartedAtUtc ? `frame:${captureStartedAtUtc}` : null;
}

/** The claim id of a continuous recording (the native recording id). */
export function continuousResidueId(recordingId: string | null | undefined): string | null {
  return typeof recordingId === "string" && recordingId ? `continuous:${recordingId}` : null;
}

/** PURE — the ownership verdict. The native ledger's own owner wins over a claim. */
export function residueOwnership(input: {
  nativeOwner?: string | null;
  claimedOwner?: string | null;
  userId: string | null | undefined;
}): ResidueOwnership {
  const owner = input.nativeOwner || input.claimedOwner || null;
  if (!owner) return "unclaimed";
  return input.userId && owner === input.userId ? "own" : "foreign";
}

function parseClaims(raw: string | null): Claim[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    const out: Claim[] = [];
    for (const c of v) {
      const o = c as { id?: unknown; ownerUserId?: unknown } | null;
      if (o && typeof o.id === "string" && o.id && typeof o.ownerUserId === "string" && o.ownerUserId) {
        out.push({ id: o.id, ownerUserId: o.ownerUserId });
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function readClaims(): Promise<Claim[]> {
  try {
    return parseClaims(await AsyncStorage.getItem(CLAIMS_KEY));
  } catch {
    return [];
  }
}

/** The account that claimed this residue, or null. */
export async function claimedResidueOwner(id: string | null): Promise<string | null> {
  if (!id) return null;
  return (await readClaims()).find((c) => c.id === id)?.ownerUserId ?? null;
}

/**
 * Record that `ownerUserId` owns this residue. The FIRST claim stands: a later
 * account can never re-claim what another account already owns.
 */
export async function claimResidue(id: string | null, ownerUserId: string | null | undefined): Promise<void> {
  if (!id || !ownerUserId) return;
  try {
    const claims = await readClaims();
    if (claims.some((c) => c.id === id)) return;
    claims.push({ id, ownerUserId });
    await AsyncStorage.setItem(CLAIMS_KEY, JSON.stringify(claims.slice(-MAX_CLAIMS)));
  } catch {
    // Best effort: an unrecorded claim leaves the residue "unclaimed", decided as before.
  }
}

/** The residue is gone (staged, or discarded by its owner): its claim goes too. */
export async function forgetResidueClaim(id: string | null): Promise<void> {
  if (!id) return;
  try {
    const claims = await readClaims();
    const next = claims.filter((c) => c.id !== id);
    if (next.length !== claims.length) await AsyncStorage.setItem(CLAIMS_KEY, JSON.stringify(next));
  } catch {
    // Harmless: a stale claim names an id nothing on the device carries any more.
  }
}

/**
 * The verdict for one piece of native residue as seen by `userId`. Unclaimed
 * residue is claimed for the account that meets it (rule 3 above) and is "own".
 */
export async function resolveResidueOwnership(input: {
  id: string | null;
  nativeOwner?: string | null;
  userId: string | null | undefined;
}): Promise<"own" | "foreign"> {
  const verdict = residueOwnership({
    nativeOwner: input.nativeOwner,
    claimedOwner: await claimedResidueOwner(input.id),
    userId: input.userId,
  });
  if (verdict === "foreign") return "foreign";
  if (verdict === "unclaimed") await claimResidue(input.id, input.userId);
  return "own";
}

// ---------------------------------------------------------------------------
// THE READ GATES. Every screen path that offers, discards or clears native
// residue goes through one of these.
// ---------------------------------------------------------------------------

export type RecoveredFrames =
  | { kind: "none" }
  | { kind: "own"; result: ScreenCaptureResult }
  | { kind: "foreign" };

/**
 * The recovered single-frame capture as `userId` may see it. Another account's
 * frames are never returned (review gap 1): the caller gets "foreign" and
 * nothing else.
 */
export async function ownedRecoveredScreenCapture(userId: string | null | undefined): Promise<RecoveredFrames> {
  if (!userId) return { kind: "none" };
  const recovered = getRecoveredScreenCapture();
  if (!recovered) return { kind: "none" };
  const verdict = await resolveResidueOwnership({
    id: frameResidueId(recovered.captureStartedAtUtc),
    nativeOwner: getRecoveredScreenCaptureOwner().ownerUserId,
    userId,
  });
  return verdict === "own" ? { kind: "own", result: recovered } : { kind: "foreign" };
}

/**
 * Clear the native frame ledger — unless it holds another account's capture.
 * Returns false (nothing cleared) for a foreign ledger.
 */
export async function clearOwnedScreenCaptureLedger(userId: string | null | undefined): Promise<boolean> {
  const recovered = getRecoveredScreenCapture();
  if (recovered) {
    const id = frameResidueId(recovered.captureStartedAtUtc);
    const verdict = residueOwnership({
      nativeOwner: getRecoveredScreenCaptureOwner().ownerUserId,
      claimedOwner: await claimedResidueOwner(id),
      userId,
    });
    if (verdict === "foreign") return false;
    await forgetResidueClaim(id);
  }
  await clearScreenCaptureLedger();
  return true;
}

export type ForeignContinuousResidue = {
  /** Android: the device's one durable ledger belongs to another account. */
  ledger: boolean;
  /** iOS: the broadcast recordings that belong to another account. */
  recordingIds: string[];
};

/**
 * Which continuous recordings on this device belong to ANOTHER account
 * (review gap 2). With `adopt`, unclaimed residue is claimed for `userId`
 * (rule 3); without it this is a pure read.
 */
export async function foreignContinuousResidue(
  userId: string | null | undefined,
  options: { adopt?: boolean } = {},
): Promise<ForeignContinuousResidue> {
  const decide = async (id: string | null, nativeOwner: string | null): Promise<boolean> => {
    if (options.adopt) return (await resolveResidueOwnership({ id, nativeOwner, userId })) === "foreign";
    return residueOwnership({ nativeOwner, claimedOwner: await claimedResidueOwner(id), userId }) === "foreign";
  };
  const ledger = getContinuousLedger();
  const out: ForeignContinuousResidue = { ledger: false, recordingIds: [] };
  if (ledger) out.ledger = await decide(continuousResidueId(ledger.recordingId), ledger.ownerUserId ?? null);
  for (const r of listContinuousRecordings()) {
    if (await decide(continuousResidueId(r.recordingId), null)) out.recordingIds.push(r.recordingId);
  }
  return out;
}

/**
 * May `userId` stop-and-discard the native recording `recordingId` (null: the
 * device's one recording on Android, every recording on iOS)? Never another
 * account's.
 */
export async function mayDiscardContinuousResidue(
  userId: string | null | undefined,
  recordingId: string | null | undefined,
): Promise<boolean> {
  const foreign = await foreignContinuousResidue(userId);
  if (foreign.ledger) return false;
  if (recordingId) return !foreign.recordingIds.includes(recordingId);
  return foreign.recordingIds.length === 0;
}

/** What the next account is told about residue it does not own. One wording for every surface. */

export const FOREIGN_RESIDUE_COPY = {
  frames: {
    title: "A screen capture from another account on this device is waiting for its owner.",
    body:
      "PROOVRA keeps it for them and does not show it to you. This device holds one unfinished screen capture at a time, so a new one cannot start here until that account signs in and finishes or discards it.",
  },
  recording: {
    title: "A recording from another account on this device is waiting for its owner.",
    body:
      "PROOVRA keeps it for them; you cannot open or discard it. This device holds one screen recording at a time, so a new one cannot start here until that account signs in and finishes or discards it.",
  },
  recordingRunning: {
    title: "A screen recording started by another account is still running.",
    body:
      "You can stop it. What it recorded stays on this device for that account; you cannot open or discard it, and a new recording cannot start here until they sign in and finish or discard it.",
  },
  recordingOtherIos: "A recording from another account on this device is kept for its owner. It is not shown here and is not affected by your recording.",
} as const;
