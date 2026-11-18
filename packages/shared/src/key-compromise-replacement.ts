/**
 * B7A-F-006 (free-audit 0ea0) — WHAT A SIGNING-KEY COMPROMISE MEANS FOR ONE
 * RECORD, AS ITS OWNER'S CLIENTS READ IT.
 *
 * The API derives it (artifact status `keyCompromise`, additive; null = the
 * record has no output made by withdrawn key material) from the same facts the
 * replacement action decides on (`requestKeyCompromiseReplacement`), so the
 * control a client shows and the work it starts cannot disagree. Both clients
 * render the SAME sentences from `describeRecordKeyCompromise`.
 *
 * Rules the copy keeps:
 *   * Never a key id, fingerprint, operator reason or the word the operator
 *     console uses for the declaration.
 *   * Never implies a valid replacement exists for an output no replacement
 *     restores: the record's own signature (a re-issue does not re-sign the
 *     record — that would rewrite its history) and the custody-event
 *     attestations made with the withdrawn key (the replacement does not
 *     re-sign them). Each is stated plainly.
 *   * Earlier versions are kept unchanged and keep verifying as made by a
 *     withdrawn key.
 */

/** The `intent` the existing regenerate route takes for the linked replacement. */
export const KEY_COMPROMISE_REPLACEMENT_INTENT = "KEY_COMPROMISE_REPLACEMENT" as const;

/**
 * Where the linked replacement stands for this record.
 *
 *   AVAILABLE                         the latest package was sealed by withdrawn
 *                                     material and a replacement can be asked for
 *   IN_PROGRESS                       a replacement request is running
 *   FAILED                            the replacement request ended without a
 *                                     replacement (nothing was changed)
 *   LATEST_UNAFFECTED                 the latest report version's package is not
 *                                     sealed by withdrawn material (replaced, or a
 *                                     later version superseded it)
 *   RECORD_SIGNATURE_NOT_REPLACEABLE  the record's own signature used the material
 *   NO_TRUSTWORTHY_SIGNER             PROOVRA has no unaffected signer yet
 *   NOT_OFFERED                       only outputs no replacement restores are
 *                                     affected (custody-event attestations)
 */
export const KEY_COMPROMISE_REPLACEMENT_STATES = [
  "AVAILABLE",
  "IN_PROGRESS",
  "FAILED",
  "LATEST_UNAFFECTED",
  "RECORD_SIGNATURE_NOT_REPLACEABLE",
  "NO_TRUSTWORTHY_SIGNER",
  "NOT_OFFERED",
] as const;
export type KeyCompromiseReplacementState = (typeof KEY_COMPROMISE_REPLACEMENT_STATES)[number];

export type RecordKeyCompromise = {
  /** Which of this record's outputs were made by withdrawn key material. */
  outputs: {
    /** The record's own signature. Not restorable by a re-issue. */
    recordSignature: boolean;
    /** At least one PUBLISHED verification package seal (any version). */
    packageSeal: boolean;
    /** The package of the LATEST report version. */
    latestPackageSeal: boolean;
    /** Custody-event attestations. Not re-signed by the replacement. */
    custodyAttestations: boolean;
  };
  replacement: KeyCompromiseReplacementState;
  /** The report version a replacement replaces (AVAILABLE, IN_PROGRESS, FAILED). */
  replacesReportVersion: number | null;
  /** May the CALLER ask for it (the record's generate-outputs permission)? */
  callerMayRequest: boolean;
};

/** The bounded refusals of `intent: "KEY_COMPROMISE_REPLACEMENT"` (HTTP 409). */
export const KEY_COMPROMISE_REPLACEMENT_ERROR_CODES = [
  "KEY_COMPROMISE_REPLACEMENT_NOT_AFFECTED",
  "KEY_COMPROMISE_REPLACEMENT_RECORD_SIGNATURE_NOT_REPLACEABLE",
  "KEY_COMPROMISE_REPLACEMENT_NO_TRUSTWORTHY_SIGNER",
  "KEY_COMPROMISE_REPLACEMENT_NOT_REQUESTED",
  "KEY_COMPROMISE_REPLACEMENT_OTHER_REQUEST_ACTIVE",
  "KEY_COMPROMISE_REPLACEMENT_ATTEMPTS_EXHAUSTED",
] as const;
export type KeyCompromiseReplacementErrorCode = (typeof KEY_COMPROMISE_REPLACEMENT_ERROR_CODES)[number];

export const KEY_COMPROMISE_REPLACEMENT_ACTION_LABEL = "Request replacement";

/** Parse the artifact-status field defensively (an older API sends nothing). */
export function parseRecordKeyCompromise(raw: unknown): RecordKeyCompromise | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const o = (r.outputs && typeof r.outputs === "object" ? r.outputs : {}) as Record<string, unknown>;
  const state = r.replacement;
  if (typeof state !== "string" || !(KEY_COMPROMISE_REPLACEMENT_STATES as readonly string[]).includes(state)) return null;
  const v = r.replacesReportVersion;
  return {
    outputs: {
      recordSignature: o.recordSignature === true,
      packageSeal: o.packageSeal === true,
      latestPackageSeal: o.latestPackageSeal === true,
      custodyAttestations: o.custodyAttestations === true,
    },
    replacement: state as KeyCompromiseReplacementState,
    replacesReportVersion: typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null,
    callerMayRequest: r.callerMayRequest === true,
  };
}

/** Show the control only when the server says a replacement can be asked for, by this caller. */
export function keyCompromiseReplacementOffered(k: RecordKeyCompromise | null | undefined): boolean {
  return Boolean(k && k.replacement === "AVAILABLE" && k.callerMayRequest);
}

export type RecordKeyCompromiseDescription = {
  title: string;
  /** What happened and what stays true of the history. */
  message: string;
  /** Where the replacement stands (never implies one exists when it does not). */
  replacementLine: string;
  /** Outputs no replacement restores, one sentence each. */
  notReplaced: string[];
  /** The control's label, or null when no control is shown. */
  actionLabel: string | null;
};

const NOT_REPLACED_RECORD_SIGNATURE =
  "This record's own signature was made with the withdrawn key. A replacement cannot re-sign the record without changing its history, so none is issued for it; verification shows that signature as made by a withdrawn key.";
const NOT_REPLACED_CUSTODY =
  "Custody-event attestations made with the withdrawn key are not re-signed by a replacement; they stay in the record's history and verify as made by a withdrawn key.";

/** THE sentences both clients render for a record's key-compromise state. */
export function describeRecordKeyCompromise(k: RecordKeyCompromise): RecordKeyCompromiseDescription {
  const v = k.replacesReportVersion;
  const lines: Record<KeyCompromiseReplacementState, string> = {
    AVAILABLE: k.callerMayRequest
      ? `You can request a replacement of report version ${v ?? "—"} and its verification package, sealed with a current key. It is linked to this record, and it uses no credit or storage allowance.`
      : "A replacement of the latest report and verification package can be requested by someone with permission to generate this record's outputs.",
    IN_PROGRESS: "A replacement report and verification package are being issued with a current key.",
    FAILED: "The replacement could not be issued. Nothing was changed; the earlier versions remain as they were.",
    LATEST_UNAFFECTED:
      "The latest report version's verification package is sealed with a current key. Earlier versions are kept unchanged.",
    RECORD_SIGNATURE_NOT_REPLACEABLE: "No replacement can restore this record's signature.",
    NO_TRUSTWORTHY_SIGNER:
      "A replacement cannot be issued until PROOVRA has a signing key that is not affected. Check back later.",
    NOT_OFFERED: "No replacement is available for the affected items.",
  };
  const notReplaced: string[] = [];
  if (k.outputs.recordSignature) notReplaced.push(NOT_REPLACED_RECORD_SIGNATURE);
  if (k.outputs.custodyAttestations) notReplaced.push(NOT_REPLACED_CUSTODY);
  return {
    title: "Signed with a withdrawn key",
    message:
      "PROOVRA withdrew a signing key that was used for this record. Issued reports and verification packages are kept unchanged, and verification now shows anything made with that key as made by a withdrawn key.",
    replacementLine: lines[k.replacement],
    notReplaced,
    actionLabel: keyCompromiseReplacementOffered(k) ? KEY_COMPROMISE_REPLACEMENT_ACTION_LABEL : null,
  };
}
