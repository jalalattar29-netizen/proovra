/**
 * UC-0 — Evidence acquisition authority.
 *
 * THE ONE ANSWER to "How did this Evidence enter PROOVRA?".
 *
 * `Evidence.acquisitionMode` is written ONCE, server-side, by the ingress
 * adapter that created the record (`createEvidence` requires it), and is never
 * rewritten: completion, reports, packages, indexing, derivative jobs, archive,
 * trash, restore and retention all leave it alone, and a database trigger
 * refuses any UPDATE that changes a value once set.
 *
 * Every surface that states acquisition — library, detail, case, search,
 * report, verification package, public Verify — reads it through
 * `resolveEvidenceAcquisition`. Nothing infers acquisition from
 * `captureMethod` (a structure/compat field that completion rewrites),
 * `captureEnvironment.uploadSource` (historically inverted for mobile and
 * citizen routes), MIME type, file name, EXIF, `clientSignals` or
 * `screenshotLike`.
 *
 * WHAT AN ACQUISITION STATEMENT ASSERTS — AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * It says which PROOVRA ingress channel received the bytes. It does not prove
 * that the content is true, who created it, that a device or app was genuine,
 * that events happened as depicted, or that the material is admissible. None of
 * the modes below is a "direct capture" mode: in every one of them PROOVRA
 * received a file whose creation it did not observe. Direct-capture adapters
 * (UC-1 onward) append their own modes here with `isDirectCapture: true`.
 *
 * APPEND-ONLY. A persisted value is never renamed. Adding a mode requires the
 * `evidence_acquisition_mode_check` constraint to be widened in the same
 * change (see the UC-0 migration).
 */

/** Modes an ingress adapter may persist on `Evidence.acquisitionMode`. */
export const EVIDENCE_ACQUISITION_MODES = [
  /** `POST /v1/evidence` — a signed-in account uploaded files (web app). */
  "PROOVRA_WEB_UPLOAD",
  /** Canonical external intake (`/v1/external-intake/*`), incl. Evidence Requests. */
  "SECURE_INTAKE_LINK",
  /** The PROOVRA mobile app, through a server-issued direct-capture session. */
  "PROOVRA_MOBILE_APP",
  /**
   * UC-1 — the PROOVRA browser extension captured a web page directly, in a
   * server-issued capture session started BEFORE the capture. This is the
   * first `isDirectCapture: true` mode: PROOVRA's own adapter produced the
   * bytes and the server recomputed every artifact's digest. It still does not
   * prove the page's content, the site's genuineness or the bytes' server
   * origin (see the limitations below).
   */
  "DIRECT_WEB_CAPTURE_EXTENSION",
  /**
   * UC-2 — the PROOVRA Android app captured the device screen directly, through
   * Android's MediaProjection consent, in a server-issued capture session started
   * BEFORE the capture. Like the UC-1 web mode this is `isDirectCapture: true`:
   * PROOVRA's own adapter produced the frame bytes and the server recomputed
   * every artifact's digest. It still does not prove the displayed content, who
   * or what produced it, or that the Android device was uncompromised (see the
   * limitations below). It is NOT the same as `PROOVRA_MOBILE_APP`, which is a
   * generic mobile submission of a file PROOVRA did not observe being produced.
   */
  "DIRECT_SCREEN_CAPTURE_ANDROID",
] as const;
export type EvidenceAcquisitionMode = (typeof EVIDENCE_ACQUISITION_MODES)[number];

/** Projection-only value for a record whose acquisition was never recorded. */
export const ACQUISITION_NOT_RECORDED = "LEGACY_NOT_RECORDED" as const;
export type ProjectedAcquisitionMode =
  | EvidenceAcquisitionMode
  | typeof ACQUISITION_NOT_RECORDED;

/**
 * How the stored value came to exist. A value recorded by the ingress adapter
 * at creation is distinguishable from one derived later from a proven
 * relationship, so a backfill can never pass for a contemporaneous record.
 */
export const EVIDENCE_ACQUISITION_MODE_SOURCES = [
  "RECORDED_AT_CREATION",
  /** Derived from the unique `workflow_intake_sessions.evidence_id` join (D9). */
  "BACKFILL_INTAKE_SESSION_LINK",
] as const;
export type EvidenceAcquisitionModeSource =
  (typeof EVIDENCE_ACQUISITION_MODE_SOURCES)[number];

export function isEvidenceAcquisitionMode(v: unknown): v is EvidenceAcquisitionMode {
  return (
    typeof v === "string" &&
    (EVIDENCE_ACQUISITION_MODES as ReadonlyArray<string>).includes(v)
  );
}

export function isEvidenceAcquisitionModeSource(
  v: unknown,
): v is EvidenceAcquisitionModeSource {
  return (
    typeof v === "string" &&
    (EVIDENCE_ACQUISITION_MODE_SOURCES as ReadonlyArray<string>).includes(v)
  );
}

/** Coarse, filterable grouping used by the library filter and search. */
export const EVIDENCE_ACQUISITION_CATEGORIES = [
  "UPLOAD",
  "SECURE_INTAKE",
  "MOBILE_APP",
  "DIRECT_WEB_CAPTURE",
  "DIRECT_SCREEN_CAPTURE",
  "NOT_RECORDED",
] as const;
export type EvidenceAcquisitionCategory =
  (typeof EVIDENCE_ACQUISITION_CATEGORIES)[number];

/**
 * The global qualifier appended wherever an acquisition statement appears in a
 * report, on public Verify, or in a verification package.
 */
export const ACQUISITION_GLOBAL_QUALIFIER =
  "PROOVRA records how and when material was received and preserved. It does not establish that the content is true, who authored it, the identity of people shown, or that events occurred as depicted. Legal admissibility and evidentiary weight require separate review.";

type ModeDescriptor = {
  category: EvidenceAcquisitionCategory;
  /** Short neutral label (chips, table cells). */
  label: string;
  /** One factual sentence. Never a trust assertion. */
  statement: string;
  /**
   * True only when PROOVRA's own capture adapter produced the bytes under a
   * server-issued session. No UC-0 mode qualifies.
   */
  isDirectCapture: boolean;
  /** Bounded limitation codes that always accompany the statement. */
  limitations: ReadonlyArray<AcquisitionLimitationCode>;
};

export const ACQUISITION_LIMITATION_CODES = [
  "CREATION_NOT_OBSERVED_BY_PROOVRA",
  "ACQUISITION_NOT_RECORDED",
  "CLIENT_REPORTED_CAPTURE_SOURCE",
  "DEVICE_INTEGRITY_NOT_VERIFIED",
  // UC-1 direct web capture.
  "WEB_CONTENT_TRUTH_NOT_PROVEN",
  "WEB_SERVER_ORIGIN_NOT_PROVEN",
  "WEB_PAGE_STATE_AT_CAPTURE",
  // UC-2 Android direct screen capture.
  "SCREEN_CONTENT_TRUTH_NOT_PROVEN",
  "SCREEN_SOURCE_APP_NOT_PROVEN",
  "SCREEN_DEVICE_INTEGRITY_NOT_VERIFIED",
] as const;
export type AcquisitionLimitationCode =
  (typeof ACQUISITION_LIMITATION_CODES)[number];

export const ACQUISITION_LIMITATION_TEXT: Readonly<
  Record<AcquisitionLimitationCode, string>
> = {
  CREATION_NOT_OBSERVED_BY_PROOVRA:
    "PROOVRA did not observe how, when or by whom the file was created, or whether it was edited before it was received.",
  ACQUISITION_NOT_RECORDED:
    "This record was created before PROOVRA recorded how evidence entered the platform, so the acquisition channel is not known.",
  CLIENT_REPORTED_CAPTURE_SOURCE:
    "Whether an item came from the app's camera or from files on the device is reported by the app and is not independently verified.",
  DEVICE_INTEGRITY_NOT_VERIFIED:
    "The integrity of the submitting device and app was not independently verified.",
  WEB_CONTENT_TRUTH_NOT_PROVEN:
    "A web capture preserves the representation PROOVRA acquired. It does not establish that the page's content is true, who authored it, or that a website or account is genuine.",
  WEB_SERVER_ORIGIN_NOT_PROVEN:
    "PROOVRA does not prove that the captured bytes were served by the website's own servers. A locally modified page or a look-alike site cannot be ruled out.",
  WEB_PAGE_STATE_AT_CAPTURE:
    "A web page can change while it is being captured, and its appearance can be altered in the browser before capture. PROOVRA records the representation it received and any limitations it detected, not a guaranteed untouched original.",
  SCREEN_CONTENT_TRUTH_NOT_PROVEN:
    "A screen capture preserves what was shown on the Android device's screen. It does not establish that the displayed content is true, who authored it, or that any person or account shown is genuine.",
  SCREEN_SOURCE_APP_NOT_PROVEN:
    "PROOVRA does not prove which app produced what was on screen, or that the underlying app or server actually supplied the displayed data. Content displayed by a modified app, a mock-up or an overlay cannot be ruled out.",
  SCREEN_DEVICE_INTEGRITY_NOT_VERIFIED:
    "The integrity of the Android device and OS was not independently verified. A rooted, emulated or otherwise modified device cannot be ruled out; protected content (secure windows) may appear blank or be omitted.",
};

const DESCRIPTORS: Readonly<Record<ProjectedAcquisitionMode, ModeDescriptor>> = {
  PROOVRA_WEB_UPLOAD: {
    category: "UPLOAD",
    label: "Uploaded to PROOVRA",
    statement:
      "This material was uploaded to PROOVRA by a signed-in account. PROOVRA established integrity when the upload was completed.",
    isDirectCapture: false,
    limitations: ["CREATION_NOT_OBSERVED_BY_PROOVRA"],
  },
  SECURE_INTAKE_LINK: {
    category: "SECURE_INTAKE",
    label: "Submitted through a secure intake link",
    statement:
      "This material was submitted to PROOVRA through a secure intake link. PROOVRA established integrity when the submission was completed.",
    isDirectCapture: false,
    limitations: ["CREATION_NOT_OBSERVED_BY_PROOVRA"],
  },
  PROOVRA_MOBILE_APP: {
    category: "MOBILE_APP",
    label: "Submitted through the PROOVRA mobile app",
    statement:
      "This material was submitted through the PROOVRA mobile app in a server-issued capture session. PROOVRA established integrity when the session was completed.",
    isDirectCapture: false,
    limitations: [
      "CREATION_NOT_OBSERVED_BY_PROOVRA",
      "CLIENT_REPORTED_CAPTURE_SOURCE",
      "DEVICE_INTEGRITY_NOT_VERIFIED",
    ],
  },
  DIRECT_WEB_CAPTURE_EXTENSION: {
    category: "DIRECT_WEB_CAPTURE",
    label: "Captured from the web with PROOVRA",
    statement:
      "PROOVRA captured this web page directly through its browser extension, in a server-issued capture session started before the capture. PROOVRA independently recomputed the digest of every captured artifact and established integrity when the session was completed.",
    isDirectCapture: true,
    limitations: [
      "WEB_CONTENT_TRUTH_NOT_PROVEN",
      "WEB_SERVER_ORIGIN_NOT_PROVEN",
      "WEB_PAGE_STATE_AT_CAPTURE",
    ],
  },
  DIRECT_SCREEN_CAPTURE_ANDROID: {
    category: "DIRECT_SCREEN_CAPTURE",
    label: "Captured from an Android screen with PROOVRA",
    statement:
      "PROOVRA captured this Android device screen directly through its app, using Android's screen-capture consent, in a server-issued capture session started before the capture. PROOVRA independently recomputed the digest of every captured frame and established integrity when the session was completed.",
    isDirectCapture: true,
    limitations: [
      "SCREEN_CONTENT_TRUTH_NOT_PROVEN",
      "SCREEN_SOURCE_APP_NOT_PROVEN",
      "SCREEN_DEVICE_INTEGRITY_NOT_VERIFIED",
    ],
  },
  LEGACY_NOT_RECORDED: {
    category: "NOT_RECORDED",
    label: "Not recorded",
    statement:
      "How this record entered PROOVRA was not recorded when it was created.",
    isDirectCapture: false,
    limitations: ["ACQUISITION_NOT_RECORDED"],
  },
};

export type EvidenceAcquisitionProjection = {
  schemaVersion: "PROOVRA_EVIDENCE_ACQUISITION_V1";
  mode: ProjectedAcquisitionMode;
  category: EvidenceAcquisitionCategory;
  /** False only for LEGACY_NOT_RECORDED. Absence is not a failure. */
  recorded: boolean;
  /** Null when not recorded. */
  recordedBy: EvidenceAcquisitionModeSource | null;
  label: string;
  statement: string;
  isDirectCapture: boolean;
  limitations: ReadonlyArray<AcquisitionLimitationCode>;
};

/**
 * THE resolver. Input is exactly the two persisted columns. An unknown or
 * malformed stored value is treated as not recorded — never guessed.
 */
export function resolveEvidenceAcquisition(input: {
  acquisitionMode: string | null | undefined;
  acquisitionModeSource?: string | null | undefined;
}): EvidenceAcquisitionProjection {
  const recorded = isEvidenceAcquisitionMode(input.acquisitionMode);
  const mode: ProjectedAcquisitionMode = recorded
    ? (input.acquisitionMode as EvidenceAcquisitionMode)
    : ACQUISITION_NOT_RECORDED;
  const d = DESCRIPTORS[mode];
  return {
    schemaVersion: "PROOVRA_EVIDENCE_ACQUISITION_V1",
    mode,
    category: d.category,
    recorded,
    recordedBy:
      recorded && isEvidenceAcquisitionModeSource(input.acquisitionModeSource)
        ? input.acquisitionModeSource
        : recorded
          ? "RECORDED_AT_CREATION"
          : null,
    label: d.label,
    statement: d.statement,
    isDirectCapture: d.isDirectCapture,
    limitations: d.limitations,
  };
}

/** Every mode (incl. not-recorded) belonging to a filter category. */
export function acquisitionModesForCategory(
  category: EvidenceAcquisitionCategory,
): ReadonlyArray<ProjectedAcquisitionMode> {
  return (Object.keys(DESCRIPTORS) as ProjectedAcquisitionMode[]).filter(
    (m) => DESCRIPTORS[m].category === category,
  );
}

/** Label for a filter category (library filter chips). */
export const ACQUISITION_CATEGORY_LABELS: Readonly<
  Record<EvidenceAcquisitionCategory, string>
> = {
  UPLOAD: "Uploaded",
  SECURE_INTAKE: "Secure intake",
  MOBILE_APP: "Mobile app",
  DIRECT_WEB_CAPTURE: "Web capture",
  DIRECT_SCREEN_CAPTURE: "Screen capture",
  NOT_RECORDED: "Not recorded",
};

/**
 * Server-time label for the moment PROOVRA recorded the submission, chosen
 * from the acquisition authority (never from `uploadSource`).
 */
export function acquisitionTimestampLabel(
  mode: ProjectedAcquisitionMode,
  isIntake: boolean,
): string {
  if (isIntake || mode === "SECURE_INTAKE_LINK") {
    return "Intake submitted at (server UTC)";
  }
  if (mode === "PROOVRA_MOBILE_APP") {
    return "Recorded at mobile app submission (server UTC)";
  }
  if (mode === "DIRECT_WEB_CAPTURE_EXTENSION") {
    return "Captured from the web at (server UTC)";
  }
  if (mode === "DIRECT_SCREEN_CAPTURE_ANDROID") {
    return "Captured from an Android screen at (server UTC)";
  }
  return "Recorded at submission (server UTC)";
}

// =============================================================================
// Artifact class — original vs capture record vs derivative
// =============================================================================

/**
 * `EvidencePart.artifactClass`. Every part row ever written is an ORIGINAL (a
 * capture manifest has never been stored); derivatives are never parts — they
 * live in `EvidencePartDerivedAsset` and project as DERIVED.
 */
export const EVIDENCE_PART_ARTIFACT_CLASSES = ["ORIGINAL", "CAPTURE_MANIFEST"] as const;
export type EvidencePartArtifactClass =
  (typeof EVIDENCE_PART_ARTIFACT_CLASSES)[number];

export const EVIDENCE_ARTIFACT_CLASSES = [
  ...EVIDENCE_PART_ARTIFACT_CLASSES,
  "DERIVED",
] as const;
export type EvidenceArtifactClass = (typeof EVIDENCE_ARTIFACT_CLASSES)[number];

export const EVIDENCE_ARTIFACT_CLASS_LABELS: Readonly<
  Record<EvidenceArtifactClass, string>
> = {
  ORIGINAL: "Original",
  CAPTURE_MANIFEST: "Capture record",
  DERIVED: "Derived review material",
};

export function normalizePartArtifactClass(v: unknown): EvidencePartArtifactClass {
  return v === "CAPTURE_MANIFEST" ? "CAPTURE_MANIFEST" : "ORIGINAL";
}

/** Bounded counts for the Record tab / package boundaries. */
export type EvidenceArtifactClassCounts = {
  original: number;
  captureRecord: number;
  derived: number;
};

// =============================================================================
// Derivative lineage descriptor
// =============================================================================

/**
 * Bounded transformation identifiers for `EvidencePartDerivedAsset`. A
 * transformation names WHAT was done to the source bytes; `engineVersion`
 * names the tool that did it.
 */
export const DERIVED_ASSET_TRANSFORMATIONS = [
  "image-thumbnail/v1",
  "video-frame/v1",
  "audio-waveform/v1",
  "low-res-proxy/v1",
  "review-preview/v1",
  "unspecified-legacy",
] as const;
export type DerivedAssetTransformation =
  (typeof DERIVED_ASSET_TRANSFORMATIONS)[number];

export const DEFAULT_DERIVED_ASSET_VARIANT_KEY = "default" as const;

const TRANSFORMATION_BY_KIND: Readonly<Record<string, DerivedAssetTransformation>> = {
  image_thumbnail: "image-thumbnail/v1",
  video_frame: "video-frame/v1",
  audio_waveform: "audio-waveform/v1",
  low_res_proxy: "low-res-proxy/v1",
  compact_review_preview: "review-preview/v1",
};

export function derivedAssetTransformationForKind(
  assetKind: string,
): DerivedAssetTransformation {
  return TRANSFORMATION_BY_KIND[assetKind] ?? "unspecified-legacy";
}

/** Search/package marker for text that PROOVRA derived from a source artifact. */
export const DERIVED_TEXT_PROVENANCE = "DERIVED_MACHINE_EXTRACTED" as const;

// =============================================================================
// Public Verify acquisition contract (the ONE typed shape the web consumes)
// =============================================================================

export const PUBLIC_ACQUISITION_SCHEMA_VERSION = "PROOVRA_PUBLIC_ACQUISITION_V1" as const;

/**
 * Public-safe acquisition & capture-trust projection. Emitted by
 * `GET /public/verify/:id` as `acquisition`, consumed verbatim by the Verify
 * page. Never carries a device id, session id, IP, URL path, OCR text, object
 * key, nonce or token.
 */
export type PublicVerifyAcquisition = {
  schemaVersion: typeof PUBLIC_ACQUISITION_SCHEMA_VERSION;
  acquisition: {
    mode: ProjectedAcquisitionMode;
    category: EvidenceAcquisitionCategory;
    recorded: boolean;
    recordedBy: EvidenceAcquisitionModeSource | null;
    label: string;
    statement: string;
    isDirectCapture: boolean;
  };
  /** Present only when a server-issued capture session was bound. */
  captureSession: {
    startedAtUtc: string | null;
    endedAtUtc: string | null;
    outcome: "BOUND";
    /** Parts whose client-declared digest equalled the server digest. */
    digestsConfirmed: number;
  } | null;
  /** Source-device signature (NOT the PROOVRA preservation signature). */
  deviceSignature: {
    applicable: boolean;
    verdict: string;
  };
  /** Always neutral until a cryptographic verifier exists. */
  deviceAttestation: {
    applicable: boolean;
    verdict: string;
    verified: boolean;
  };
  /** When PROOVRA's server first established integrity (completion). */
  integrity: {
    establishedAtUtc: string | null;
    establishedBy: "PROOVRA_SERVER_COMPLETION";
  };
  artifacts: EvidenceArtifactClassCounts;
  limitations: ReadonlyArray<{ code: AcquisitionLimitationCode; text: string }>;
  qualifier: string;
};
