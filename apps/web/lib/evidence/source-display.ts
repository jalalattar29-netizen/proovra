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
 * Capture vs. intake distinction:
 *   - Authenticated PROOVRA-secure-camera captures keep their original
 *     wording. The wording change only triggers for intake-link evidence
 *     (captureMethod === "EXTERNAL_INTAKE_UPLOAD") and for cases where
 *     the engineering label is actively misleading
 *     (MULTIPART_PACKAGE → "Folder upload" → "Folder upload (multiple
 *     files)", which still beats "Multipart package").
 *
 * Importance vs. visibility:
 *   - shouldShowContextSignal() returns false for "NOT_COLLECTED" and
 *     "UNAVAILABLE", which are the two states that previously rendered
 *     as ugly "Client signal not collected" cards. Use it as a guard
 *     before rendering signal rows.
 */

/** Raw values from the backend; treat as loose strings. */
export type RawSourceType =
  | "native_capture"
  | "imported_upload"
  | "folder_upload"
  | "external_intake"
  | "unknown"
  | (string & {});

export type RawCaptureMethod =
  | "SECURE_CAMERA"
  | "UPLOADED_FILE"
  | "IMPORTED_DOCUMENT"
  | "MULTIPART_PACKAGE"
  | "EXTERNAL_INTAKE_UPLOAD"
  | (string & {})
  | null
  | undefined;

export type RawSignalState =
  | "NOT_COLLECTED"
  | "COLLECTED_FALSE"
  | "DETECTED"
  | "UNAVAILABLE"
  | (string & {});

/**
 * Human-friendly source-type label. Prefer the captureMethod when
 * available because it's the canonical signal; sourceType is derived
 * (and historically conflates EXTERNAL_INTAKE_UPLOAD into "unknown",
 * which is why intake-link evidence currently displays "unknown" or
 * the misleading "folder_upload" raw enum).
 */
export function displaySourceType(
  sourceType: RawSourceType | null | undefined,
  captureMethod: RawCaptureMethod = null,
): string {
  const cm = String(captureMethod ?? "").toUpperCase();
  if (cm === "EXTERNAL_INTAKE_UPLOAD") return "External intake";
  switch (sourceType) {
    case "native_capture":
      return "PROOVRA secure capture";
    case "imported_upload":
      return "Uploaded file";
    case "folder_upload":
      return "Folder upload (multiple files)";
    case "external_intake":
      return "External intake";
    case "unknown":
    case undefined:
    case null:
    case "":
      return "Source not recorded";
    default:
      // Friendly-cased fallback so a future enum value doesn't render
      // a raw snake_case token to the reviewer.
      return prettyFromSnake(String(sourceType));
  }
}

/**
 * Human-friendly capture-method label. Replaces engineering enums
 * like "MULTIPART_PACKAGE" with reviewer copy.
 */
export function displayCaptureMethod(
  captureMethod: RawCaptureMethod,
): string {
  switch (String(captureMethod ?? "").toUpperCase()) {
    case "SECURE_CAMERA":
      return "Captured with PROOVRA secure camera";
    case "UPLOADED_FILE":
      return "Uploaded existing file";
    case "IMPORTED_DOCUMENT":
      return "Imported document";
    case "MULTIPART_PACKAGE":
      // The old label "Multipart package" is engineering shorthand
      // for "we received more than one file in the same submission".
      // Reviewers want to know what it MEANS, not the protocol name.
      return "Multi-file submission";
    case "EXTERNAL_INTAKE_UPLOAD":
      // The brief explicitly asks for this wording for intake-link
      // evidence; "Secure upload session" matches the contributor's
      // experience (a one-time secure link → consent → upload).
      return "Secure upload session";
    default:
      return "Capture method not recorded";
  }
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
