/**
 * Evidence-detail source/capture display helpers.
 *
 * Goal: translate the engineering-shaped values on
 * `workspace.sourceContext` into copy that an SMB reviewer (or an
 * outside lawyer reading the workspace) can actually parse.
 *
 * Inputs to these helpers come from the API view-model, so we accept
 * loose strings (the backend's enum can drift independently). Every
 * helper returns a stable display string — never an undefined that
 * would render as "undefined" in the JSX.
 *
 * UC-0 — acquisition vs. structure:
 *   - HOW a record entered PROOVRA comes ONLY from the API's acquisition
 *     projection (`sourceContext.acquisition`, resolved server-side from
 *     `Evidence.acquisitionMode`). These helpers never infer it from
 *     `captureMethod` — a STRUCTURE field that completion overwrites — nor
 *     from MIME types, file names or client signals.
 *   - A record whose acquisition was never recorded reads "Not recorded".
 *     That is a fact about the record, not a failure, and it is shown.
 *
 * Importance vs. visibility:
 *   - shouldShowContextSignal() returns false for "NOT_COLLECTED" and
 *     "UNAVAILABLE", which are the two states that previously rendered
 *     as ugly "Client signal not collected" cards. Use it as a guard
 *     before rendering signal rows.
 */

/** Raw values from the backend; treat as loose strings. */
export type RawSourceType =
  | "imported_upload"
  | "folder_upload"
  | "external_intake"
  | "mobile_app"
  | "not_recorded"
  | (string & {});

export type RawSignalState =
  | "NOT_COLLECTED"
  | "COLLECTED_FALSE"
  | "DETECTED"
  | "UNAVAILABLE"
  | (string & {});

/** The subset of the API's acquisition projection this module reads. */
export type AcquisitionView = {
  mode: string;
  recorded: boolean;
  recordedBy?: string | null;
  label: string;
  statement?: string;
};

/**
 * Human-friendly source-type label, from the server's acquisition-derived
 * source type. "Not recorded" is returned for a legacy record.
 */
export function displaySourceType(
  sourceType: RawSourceType | null | undefined,
): string {
  switch (sourceType) {
    case "imported_upload":
      return "Uploaded file";
    case "folder_upload":
      return "Folder upload (multiple files)";
    case "external_intake":
      return "Secure intake submission";
    case "mobile_app":
      return "PROOVRA mobile app submission";
    case "not_recorded":
    case "unknown":
    case undefined:
    case null:
    case "":
      return "Not recorded";
    default:
      // Friendly-cased fallback so a future value doesn't render a raw
      // snake_case token to the reviewer.
      return prettyFromSnake(String(sourceType));
  }
}

/**
 * The acquisition label exactly as the server resolved it. A missing
 * projection (older API) reads "Not recorded" — never a guess.
 */
export function displayAcquisition(
  acquisition: AcquisitionView | null | undefined,
): string {
  if (!acquisition || typeof acquisition.label !== "string" || !acquisition.label) {
    return "Not recorded";
  }
  return acquisition.recordedBy === "BACKFILL_INTAKE_SESSION_LINK"
    ? `${acquisition.label} (recorded later from the intake session)`
    : acquisition.label;
}

/**
 * Should this client-signal card render at all?
 *
 * Returns false for the two "no value" states — NOT_COLLECTED and
 * UNAVAILABLE — so an empty signal doesn't take up grid real estate
 * with a useless "Client signal not collected" message. The empty
 * states can be summarised in a small secondary row via
 * `displayUnavailableSignal()` if context is genuinely useful.
 */
export function shouldShowContextSignal(state: RawSignalState | null | undefined): boolean {
  const s = String(state ?? "").toUpperCase();
  return s === "DETECTED" || s === "COLLECTED_FALSE";
}

/**
 * Friendly "this context isn't available for this record" copy for the
 * secondary Unavailable Context row. Used only when the unavailability
 * itself is informative (e.g. an intake-link contributor's device clock
 * was never sent over the wire).
 */
export function displayUnavailableSignal(
  kind: "deviceTime" | "folderPath" | "screenshot",
): string {
  switch (kind) {
    case "deviceTime":
      return "Device timestamp unavailable";
    case "folderPath":
      return "Original folder context unavailable";
    case "screenshot":
      return "Screenshot indicators unavailable";
    default:
      return "Context not available";
  }
}

function prettyFromSnake(value: string): string {
  if (!value) return "";
  const cleaned = value.trim().toLowerCase().replace(/[_-]+/g, " ");
  return cleaned.replace(/(^|\s)\S/g, (m) => m.toUpperCase());
}
