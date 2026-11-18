/**
 * B7A-F-006 (free-audit 0ea0) — A WITHDRAWN SIGNING KEY, ON ONE RECORD (native).
 *
 * Pure: no React, no fetch. The record screen reads `keyCompromise` from the
 * artifact status (`projectArtifactOutputs`), states it with the SHARED
 * sentences (`describeRecordKeyCompromise`, which the web renders too), and
 * offers the linked replacement only when the server says it is AVAILABLE to
 * this caller. Nothing here decides eligibility: the server already did, from
 * the same facts the replacement action decides on.
 *
 * The replacement uses the EXISTING regenerate route with
 * `{ intent: "KEY_COMPROMISE_REPLACEMENT" }` and nothing else — no reason and
 * no idempotency key; the server mints its own. Its refusals are FLAT
 * `{ code, message }` 409 bodies and read as the shared dictionary's copy.
 */

// From the package ROOT: Metro does not resolve package subpaths.
import {
  KEY_COMPROMISE_REPLACEMENT_INTENT,
  describeRecordKeyCompromise,
  keyCompromiseReplacementOffered,
  type RecordKeyCompromise,
  type RecordKeyCompromiseDescription,
} from "@proovra/shared";

import { toSafeUserError } from "../errors/safe-error";
import { buildRegeneratePath } from "./evidence-detail";

export type KeyCompromiseNoticeView = RecordKeyCompromiseDescription & {
  /** True only for replacement === "AVAILABLE" with callerMayRequest. */
  offered: boolean;
};

/** The notice for a record, or null when nothing of it used withdrawn key material. */
export function keyCompromiseNotice(k: RecordKeyCompromise | null | undefined): KeyCompromiseNoticeView | null {
  if (!k) return null;
  const offered = keyCompromiseReplacementOffered(k);
  const d = describeRecordKeyCompromise(k);
  return { ...d, actionLabel: offered ? d.actionLabel : null, offered };
}

/** The request the control sends. */
export function buildKeyCompromiseReplacementRequest(evidenceId: string): {
  path: string;
  init: { method: "POST"; body: string };
} {
  return {
    path: buildRegeneratePath(evidenceId),
    init: { method: "POST", body: JSON.stringify({ intent: KEY_COMPROMISE_REPLACEMENT_INTENT }) },
  };
}

/** The acknowledgement after a 202 (a repeat answers REPLAYED and reads the same). */
export const KEY_COMPROMISE_REPLACEMENT_REQUESTED =
  "Replacement requested. It will appear in this record's versions when it is issued.";

export function keyCompromiseReplacementRequested(): string {
  return KEY_COMPROMISE_REPLACEMENT_REQUESTED;
}

/**
 * A refusal, in the shared dictionary's words. The refusals are FLAT bodies:
 * the transport reads the top-level `code`, and when only the kept body
 * carries it (the transport's "API_ERROR" placeholder) that flat `code` is
 * what decides — never the raw server sentence, never a generic 409 bucket.
 */
export function keyCompromiseReplacementError(err: unknown): { title: string; message: string } {
  const e = err && typeof err === "object" ? (err as { code?: unknown; body?: unknown; statusCode?: unknown; requestId?: unknown; message?: unknown }) : null;
  const body = e?.body && typeof e.body === "object" ? (e.body as { code?: unknown }) : null;
  const bodyCode = typeof body?.code === "string" && body.code.length > 0 ? body.code : null;
  const ownCode = typeof e?.code === "string" && e.code.length > 0 && e.code !== "API_ERROR" ? e.code : null;
  const subject =
    !ownCode && bodyCode && e
      ? { statusCode: e.statusCode, requestId: e.requestId, message: e.message, body: e.body, code: bodyCode }
      : err;
  const safe = toSafeUserError(subject);
  return { title: safe.title, message: safe.message };
}
