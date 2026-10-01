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
  /**
   * UC-EXT-004 — the DOM snapshot could not be produced or was dropped, so the
   * capture holds the visual artifacts only.
   */
  "DOM_SNAPSHOT_MISSING",
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
  // UC-EXT-004 — completeness and limitations must agree: a capture that
  // records ANY limitation is not CAPTURED (it is PARTIAL, or worse). A
  // manifest claiming a complete capture while naming a known gap is refused.
  if (m.completeness === "CAPTURED" && (m.limitations as unknown[]).length > 0) {
    return { ok: false, error: "a capture with limitations cannot be CAPTURED (use PARTIAL)" };
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

// =============================================================================
// UC-PROV-003 — CAPTURE MANIFEST FACTS: the ONE persisted projection of a
// validated capture manifest (web, screen frames, continuous screen).
//
// The manifest used to be validated at seal and then dropped: only the raw
// CAPTURE_MANIFEST part carried the source URL, title, browser/app version,
// the client's capture window, completeness, the page-mutated flag and the
// limitations the client detected — so no report, Verify page or detail view
// could state them. At seal the API now records these facts, taken ONLY from a
// manifest that passed its validator and whose digest is a declared part, as a
// `CAPTURE_ARTIFACT_RECEIVED` trust event with `stage: "manifest_facts"`.
// It is written BEFORE the bind, so the CAPTURE_SESSION_BOUND event's
// `trustChainHeadHash` covers it; it carries no evidence id, so the private
// source URL is never mirrored into the custody chain.
//
// Everything here is REPORTED BY THE CAPTURE CLIENT. A surface rendering it must
// say so; none of it is a server observation.
// =============================================================================

export const CAPTURE_MANIFEST_FACTS_SCHEMA = "PROOVRA_CAPTURE_MANIFEST_FACTS_V1" as const;
/** The trust-event stage that carries the facts (code CAPTURE_ARTIFACT_RECEIVED). */
export const CAPTURE_MANIFEST_FACTS_STAGE = "manifest_facts" as const;

export type CaptureManifestFactsKind = "WEB" | "SCREEN_FRAMES" | "SCREEN_CONTINUOUS";

export type CaptureManifestFacts = {
  schema: typeof CAPTURE_MANIFEST_FACTS_SCHEMA;
  kind: CaptureManifestFactsKind;
  /** Always the client: the server validated the shape, not the statements. */
  reportedBy: "CAPTURE_CLIENT";
  manifestSchemaVersion: string;
  /** SHA-256 of the exact manifest bytes (= the CAPTURE_MANIFEST part digest). */
  manifestSha256: string;
  manifestPartIndex: number;
  clientCaptureWindow: { startedAtUtc: string; endedAtUtc: string };
  /** The manifest's own completeness value (CAPTURED / PARTIAL / COMPLETE_SESSION …). */
  completeness: string;
  /** True only when the client reported a complete capture with no known gap. */
  reportedComplete: boolean;
  /** Limitation codes the client detected, verbatim from the validated enum. */
  limitations: string[];
  client: {
    kind: "BROWSER_EXTENSION" | "MOBILE_APP";
    appVersion: string;
    platform: string | null;
    osVersion: string | null;
    model: string | null;
    browserName: string | null;
    browserVersion: string | null;
  };
  web: {
    /** Public-safe (publicDomainFromUrl of the source URL, or the manifest domain). */
    domain: string;
    /** PRIVATE — authorized private surfaces and the package only. */
    sourceUrlPrivate: string;
    /** PRIVATE — a page title can carry personal data. */
    titlePrivate: string | null;
    captureMode: string;
    pageMutatedDuringCapture: boolean;
  } | null;
  screen: {
    /** stopReason (frames) or terminationReason (continuous). */
    endReason: string;
    /** Frames or segments listed in the manifest. */
    artifactCount: number;
    /** Continuous only: segments the recorder produced. */
    recordedSegmentCount: number | null;
    /** Continuous only: the client's total recorded duration. */
    totalDurationMs: number | null;
  } | null;
};

/** The facts with every PRIVATE value removed (public Verify, search). */
export type PublicCaptureManifestFacts = Omit<CaptureManifestFacts, "web"> & {
  web: { domain: string; captureMode: string; pageMutatedDuringCapture: boolean } | null;
};

/** Facts of a VALIDATED web capture manifest. */
export function webCaptureManifestFacts(
  m: WebCaptureManifest,
  ref: { manifestSha256: string; manifestPartIndex: number },
): CaptureManifestFacts {
  return {
    schema: CAPTURE_MANIFEST_FACTS_SCHEMA,
    kind: "WEB",
    reportedBy: "CAPTURE_CLIENT",
    manifestSchemaVersion: m.schemaVersion,
    manifestSha256: ref.manifestSha256,
    manifestPartIndex: ref.manifestPartIndex,
    clientCaptureWindow: { startedAtUtc: m.captureStartedAtUtc, endedAtUtc: m.captureEndedAtUtc },
    completeness: m.completeness,
    reportedComplete: m.completeness === "CAPTURED" && !m.pageMutatedDuringCapture && m.limitations.length === 0,
    limitations: [...m.limitations],
    client: {
      kind: "BROWSER_EXTENSION",
      appVersion: m.extensionVersion,
      platform: null,
      osVersion: m.browser.os,
      model: null,
      browserName: m.browser.name,
      browserVersion: m.browser.versionBucket,
    },
    web: {
      domain: publicDomainFromUrl(m.page.sourceUrlPrivate) ?? m.page.domain.toLowerCase(),
      sourceUrlPrivate: m.page.sourceUrlPrivate,
      titlePrivate: m.page.title,
      captureMode: m.captureMode,
      pageMutatedDuringCapture: m.pageMutatedDuringCapture,
    },
    screen: null,
  };
}

function factStr(v: unknown, max = 256): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}
function factInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * Read persisted facts back (a trust-event payload, or the facts object
 * itself). Tolerant and bounded: an unknown or malformed payload is `null`,
 * never a partially trusted object.
 */
export function readCaptureManifestFacts(payload: unknown): CaptureManifestFacts | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const f = (p["stage"] === CAPTURE_MANIFEST_FACTS_STAGE ? p["facts"] : p) as Record<string, unknown> | undefined;
  if (!f || typeof f !== "object" || f["schema"] !== CAPTURE_MANIFEST_FACTS_SCHEMA) return null;
  const kind = f["kind"];
  if (kind !== "WEB" && kind !== "SCREEN_FRAMES" && kind !== "SCREEN_CONTINUOUS") return null;
  const manifestSha256 = factStr(f["manifestSha256"], 64);
  const manifestPartIndex = factInt(f["manifestPartIndex"]);
  const win = f["clientCaptureWindow"] as Record<string, unknown> | undefined;
  const startedAtUtc = factStr(win?.["startedAtUtc"], 40);
  const endedAtUtc = factStr(win?.["endedAtUtc"], 40);
  const completeness = factStr(f["completeness"], 40);
  const manifestSchemaVersion = factStr(f["manifestSchemaVersion"], 80);
  const c = f["client"] as Record<string, unknown> | undefined;
  if (!manifestSha256 || !/^[0-9a-f]{64}$/.test(manifestSha256) || manifestPartIndex === null) return null;
  if (!startedAtUtc || !endedAtUtc || !completeness || !manifestSchemaVersion || !c) return null;
  const clientKind = c["kind"];
  if (clientKind !== "BROWSER_EXTENSION" && clientKind !== "MOBILE_APP") return null;
  const appVersion = factStr(c["appVersion"]);
  if (!appVersion) return null;
  const limitations = Array.isArray(f["limitations"])
    ? (f["limitations"] as unknown[]).map((l) => factStr(l, 64)).filter((l): l is string => l !== null).slice(0, 64)
    : [];
  let web: CaptureManifestFacts["web"] = null;
  if (kind === "WEB") {
    const w = f["web"] as Record<string, unknown> | undefined;
    const domain = factStr(w?.["domain"], WEB_CAPTURE_MANIFEST_BOUNDS.maxDomainLen);
    const sourceUrlPrivate = factStr(w?.["sourceUrlPrivate"], WEB_CAPTURE_MANIFEST_BOUNDS.maxUrlLen);
    const captureMode = factStr(w?.["captureMode"], 40);
    if (!w || !domain || !sourceUrlPrivate || !captureMode || typeof w["pageMutatedDuringCapture"] !== "boolean") {
      return null;
    }
    web = {
      domain,
      sourceUrlPrivate,
      titlePrivate: factStr(w["titlePrivate"], WEB_CAPTURE_MANIFEST_BOUNDS.maxTitleLen),
      captureMode,
      pageMutatedDuringCapture: w["pageMutatedDuringCapture"] as boolean,
    };
  }
  let screen: CaptureManifestFacts["screen"] = null;
  if (kind !== "WEB") {
    const s = f["screen"] as Record<string, unknown> | undefined;
    const endReason = factStr(s?.["endReason"], 40);
    const artifactCount = factInt(s?.["artifactCount"]);
    if (!s || !endReason || artifactCount === null) return null;
    screen = {
      endReason,
      artifactCount,
      recordedSegmentCount: factInt(s["recordedSegmentCount"]),
      totalDurationMs: factInt(s["totalDurationMs"]),
    };
  }
  return {
    schema: CAPTURE_MANIFEST_FACTS_SCHEMA,
    kind,
    reportedBy: "CAPTURE_CLIENT",
    manifestSchemaVersion,
    manifestSha256,
    manifestPartIndex,
    clientCaptureWindow: { startedAtUtc, endedAtUtc },
    completeness,
    reportedComplete: f["reportedComplete"] === true,
    limitations,
    client: {
      kind: clientKind,
      appVersion,
      platform: factStr(c["platform"], 40),
      osVersion: factStr(c["osVersion"]),
      model: factStr(c["model"]),
      browserName: factStr(c["browserName"]),
      browserVersion: factStr(c["browserVersion"]),
    },
    web,
    screen,
  };
}

/**
 * THE selector a projection uses over a session's trust events (the rows
 * `loadProvenanceChain` already loads): the LAST manifest-facts event, or the
 * last one for a given manifest digest when the sealed record's
 * CAPTURE_MANIFEST digest is known (a retried seal may have recorded facts for
 * a manifest that did not seal).
 */
export function selectCaptureManifestFacts(
  events: ReadonlyArray<{ code: string; payload: unknown }>,
  opts: { manifestSha256?: string | null } = {},
): CaptureManifestFacts | null {
  let found: CaptureManifestFacts | null = null;
  for (const e of events) {
    if (e.code !== "CAPTURE_ARTIFACT_RECEIVED") continue;
    const p = e.payload as Record<string, unknown> | null;
    if (!p || p["stage"] !== CAPTURE_MANIFEST_FACTS_STAGE) continue;
    const facts = readCaptureManifestFacts(p);
    if (!facts) continue;
    if (opts.manifestSha256 && facts.manifestSha256 !== opts.manifestSha256.toLowerCase()) continue;
    found = facts;
  }
  return found;
}

/** Strip every private value (source URL, title) for a public surface. */
export function publicCaptureManifestFacts(f: CaptureManifestFacts): PublicCaptureManifestFacts {
  return {
    ...f,
    web: f.web
      ? { domain: f.web.domain, captureMode: f.web.captureMode, pageMutatedDuringCapture: f.web.pageMutatedDuringCapture }
      : null,
  };
}
