/**
 * UC-1 — PROOVRA Direct Web Capture manifest (the ONE bounded, server-validated
 * schema describing what PROOVRA's browser extension captured).
 *
 * The manifest is NOT an authority on trust. It records the FACTS of a capture:
 * the mode, the session binding, the source domain, the browser context, the
 * artifacts and their expected digests, and any completeness limitations. It
 * cannot declare itself verified/authentic/genuine/admissible — the server
 * recomputes every artifact's digest and decides, and integrity is established
 * by the existing completion pipeline, not by this document.
 *
 * The manifest is persisted as the `CAPTURE_MANIFEST` EvidencePart of the one
 * Evidence record the capture creates. It is validated on ingest against the
 * bounds below; a malformed or oversized manifest is refused before anything is
 * sealed.
 *
 * This module is transport-neutral and dependency-free so the extension, the
 * API and the worker share ONE schema and ONE URL-privacy projection.
 */

export const WEB_CAPTURE_MANIFEST_SCHEMA_VERSION = "PROOVRA_WEB_CAPTURE_MANIFEST_V1" as const;

export const WEB_CAPTURE_MODES = ["VIEWPORT", "FULL_PAGE"] as const;
export type WebCaptureMode = (typeof WEB_CAPTURE_MODES)[number];

export const WEB_CAPTURE_COMPLETENESS = [
  "CAPTURED",
  "PARTIAL",
  "OMITTED",
  "BLOCKED",
  "NOT_SUPPORTED",
  "FAILED",
] as const;
export type WebCaptureCompleteness = (typeof WEB_CAPTURE_COMPLETENESS)[number];

/**
 * The role of a captured artifact. `viewport_screenshot` and `dom_snapshot` are
 * DIRECT acquisition outputs (ORIGINAL parts). `page_tile` is a direct viewport
 * tile of a FULL_PAGE capture (also ORIGINAL). The manifest itself is the
 * CAPTURE_MANIFEST part and is not listed as an artifact of itself.
 */
export const WEB_CAPTURE_ARTIFACT_ROLES = [
  "viewport_screenshot",
  "page_tile",
  "dom_snapshot",
] as const;
export type WebCaptureArtifactRole = (typeof WEB_CAPTURE_ARTIFACT_ROLES)[number];

export const WEB_CAPTURE_LIMITATION_CODES = [
  "CROSS_ORIGIN_IFRAME_NOT_CAPTURED",
  "PROTECTED_MEDIA_NOT_CAPTURED",
  "DYNAMIC_CONTENT_MAY_BE_INCOMPLETE",
  "PAGE_MUTATED_DURING_CAPTURE",
  "PAGE_EXCEEDED_CAPTURE_BOUNDS",
  "SHADOW_DOM_NOT_FULLY_REPRESENTED",
  "CAPTURE_INTERRUPTED",
] as const;
export type WebCaptureLimitationCode = (typeof WEB_CAPTURE_LIMITATION_CODES)[number];

/** Bounds. Enforced by the validator; the extension must not exceed them. */
export const WEB_CAPTURE_MANIFEST_BOUNDS = {
  maxArtifacts: 300,
  maxDomainLen: 253,
  maxUrlLen: 4096,
  maxTitleLen: 400,
  maxStringLen: 256,
  maxNotes: 32,
  maxNoteLen: 300,
  maxLimitations: 32,
  maxSizeBytes: 256 * 1024, // serialized manifest ceiling
} as const;

export type WebCaptureArtifactDescriptor = {
  role: WebCaptureArtifactRole;
  /** 0-based index within this capture (ties the manifest to the uploaded part). */
  partIndex: number;
  /** SHA-256 (lowercase hex) the client computed; the server recomputes it. */
  expectedSha256: string;
  sizeBytes: number;
  mediaType: string;
  completeness: WebCaptureCompleteness;
  /** For FULL_PAGE tiles: the ordered scroll offset this tile was taken at. */
  tileIndex?: number | null;
  scrollOffsetY?: number | null;
};

export type WebCaptureManifest = {
  schemaVersion: typeof WEB_CAPTURE_MANIFEST_SCHEMA_VERSION;
  captureMode: WebCaptureMode;
  /** The server-issued capture session id this capture is bound to. */
  captureSessionId: string;
  captureStartedAtUtc: string;
  captureEndedAtUtc: string;
  page: {
    /** Origin/domain only — never a full URL in the public projection. */
    domain: string;
    /**
     * The full source URL. PRIVATE: retained for authorized private surfaces
     * and the package (per policy); never emitted on public Verify.
     */
    sourceUrlPrivate: string;
    title: string | null;
  };
  browser: {
    name: string;
    versionBucket: string;
    os: string;
    viewportW: number;
    viewportH: number;
    devicePixelRatio: number;
  };
  extensionVersion: string;
  artifacts: WebCaptureArtifactDescriptor[];
  completeness: WebCaptureCompleteness;
  pageMutatedDuringCapture: boolean;
  limitations: WebCaptureLimitationCode[];
  notes: string[];
};

export type WebCaptureManifestValidation =
  | { ok: true; manifest: WebCaptureManifest }
  | { ok: false; error: string };

const HEX64 = /^[0-9a-f]{64}$/;

function isBoundedString(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

/**
 * THE server-side validator. Strict and bounded: it never trusts the client's
 * shape. A caller passes untrusted JSON; a rejection names the first problem.
 */
export function validateWebCaptureManifest(
  input: unknown,
  opts: { expectedSessionId?: string } = {},
): WebCaptureManifestValidation {
  const B = WEB_CAPTURE_MANIFEST_BOUNDS;
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return { ok: false, error: "manifest is not serializable" };
  }
  if (serialized.length > B.maxSizeBytes) {
    return { ok: false, error: "manifest exceeds the size ceiling" };
  }
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "manifest must be an object" };
  }
  const m = input as Record<string, unknown>;
  if (m.schemaVersion !== WEB_CAPTURE_MANIFEST_SCHEMA_VERSION) {
    return { ok: false, error: "unknown manifest schemaVersion" };
  }
  if (!(WEB_CAPTURE_MODES as ReadonlyArray<unknown>).includes(m.captureMode)) {
    return { ok: false, error: "invalid captureMode" };
  }
  if (!isBoundedString(m.captureSessionId, 64)) {
    return { ok: false, error: "invalid captureSessionId" };
  }
  if (opts.expectedSessionId && m.captureSessionId !== opts.expectedSessionId) {
    return { ok: false, error: "manifest captureSessionId does not match the session" };
  }
  if (!isBoundedString(m.captureStartedAtUtc, 40) || Number.isNaN(Date.parse(m.captureStartedAtUtc))) {
    return { ok: false, error: "invalid captureStartedAtUtc" };
  }
  if (!isBoundedString(m.captureEndedAtUtc, 40) || Number.isNaN(Date.parse(m.captureEndedAtUtc))) {
    return { ok: false, error: "invalid captureEndedAtUtc" };
  }
  const page = m.page as Record<string, unknown> | undefined;
  if (!page || typeof page !== "object") return { ok: false, error: "missing page" };
  if (!isBoundedString(page.domain, B.maxDomainLen)) {
    return { ok: false, error: "invalid page.domain" };
  }
  if (!isBoundedString(page.sourceUrlPrivate, B.maxUrlLen)) {
    return { ok: false, error: "invalid page.sourceUrlPrivate" };
  }
  if (page.title !== null && !isBoundedString(page.title, B.maxTitleLen)) {
    return { ok: false, error: "invalid page.title" };
  }
  const browser = m.browser as Record<string, unknown> | undefined;
  if (!browser || typeof browser !== "object") return { ok: false, error: "missing browser" };
  for (const k of ["name", "versionBucket", "os"] as const) {
    if (!isBoundedString(browser[k], B.maxStringLen)) {
      return { ok: false, error: `invalid browser.${k}` };
    }
  }
  for (const k of ["viewportW", "viewportH", "devicePixelRatio"] as const) {
    if (typeof browser[k] !== "number" || !Number.isFinite(browser[k]) || (browser[k] as number) < 0) {
      return { ok: false, error: `invalid browser.${k}` };
    }
  }
  if (!isBoundedString(m.extensionVersion, B.maxStringLen)) {
    return { ok: false, error: "invalid extensionVersion" };
  }
  if (!(WEB_CAPTURE_COMPLETENESS as ReadonlyArray<unknown>).includes(m.completeness)) {
    return { ok: false, error: "invalid completeness" };
  }
  if (typeof m.pageMutatedDuringCapture !== "boolean") {
    return { ok: false, error: "invalid pageMutatedDuringCapture" };
  }
  if (!Array.isArray(m.limitations) || m.limitations.length > B.maxLimitations) {
    return { ok: false, error: "invalid limitations" };
  }
  for (const l of m.limitations) {
    if (!(WEB_CAPTURE_LIMITATION_CODES as ReadonlyArray<unknown>).includes(l)) {
      return { ok: false, error: `unknown limitation code: ${String(l).slice(0, 40)}` };
    }
  }
  if (!Array.isArray(m.notes) || m.notes.length > B.maxNotes) {
    return { ok: false, error: "invalid notes" };
  }
  for (const n of m.notes) {
    if (typeof n !== "string" || n.length > B.maxNoteLen) {
      return { ok: false, error: "a note is not a bounded string" };
    }
  }
  if (!Array.isArray(m.artifacts) || m.artifacts.length === 0 || m.artifacts.length > B.maxArtifacts) {
    return { ok: false, error: "invalid artifacts array" };
  }
  const seenParts = new Set<number>();
  for (const a of m.artifacts as unknown[]) {
    if (typeof a !== "object" || a === null) return { ok: false, error: "an artifact is not an object" };
    const art = a as Record<string, unknown>;
    if (!(WEB_CAPTURE_ARTIFACT_ROLES as ReadonlyArray<unknown>).includes(art.role)) {
      return { ok: false, error: "invalid artifact.role" };
    }
    if (typeof art.partIndex !== "number" || !Number.isInteger(art.partIndex) || art.partIndex < 0) {
      return { ok: false, error: "invalid artifact.partIndex" };
    }
    if (seenParts.has(art.partIndex)) {
      return { ok: false, error: "duplicate artifact.partIndex" };
    }
    seenParts.add(art.partIndex);
    if (typeof art.expectedSha256 !== "string" || !HEX64.test(art.expectedSha256)) {
      return { ok: false, error: "invalid artifact.expectedSha256" };
    }
    if (typeof art.sizeBytes !== "number" || !Number.isInteger(art.sizeBytes) || art.sizeBytes < 0) {
      return { ok: false, error: "invalid artifact.sizeBytes" };
    }
    if (!isBoundedString(art.mediaType, 80)) {
      return { ok: false, error: "invalid artifact.mediaType" };
    }
    if (!(WEB_CAPTURE_COMPLETENESS as ReadonlyArray<unknown>).includes(art.completeness)) {
      return { ok: false, error: "invalid artifact.completeness" };
    }
  }
  return { ok: true, manifest: input as WebCaptureManifest };
}

// =============================================================================
// URL privacy — the ONE canonical projection.
// =============================================================================

/**
 * The public, domain-only projection of a source URL. Public Verify, search
 * and any unauthenticated surface use THIS — never `new URL(x).hostname`
 * inline, which leaks a malformed value or throws on a bad input.
 *
 * Returns the registrable host in lowercase, or null when the input cannot be
 * parsed. Never returns a path, query, fragment, credential or port.
 */
export function publicDomainFromUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.length === 0 || url.length > WEB_CAPTURE_MANIFEST_BOUNDS.maxUrlLen) {
    return null;
  }
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase();
    return host.length > 0 && host.length <= WEB_CAPTURE_MANIFEST_BOUNDS.maxDomainLen ? host : null;
  } catch {
    return null;
  }
}

/**
 * A log/telemetry-safe rendering of a URL: domain only, or "(unparseable-url)".
 * Never the path, query or fragment — those can carry tokens and personal data.
 */
export function redactUrlForLog(url: string | null | undefined): string {
  return publicDomainFromUrl(url) ?? "(unparseable-url)";
}
