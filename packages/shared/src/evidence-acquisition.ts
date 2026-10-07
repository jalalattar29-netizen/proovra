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
 * that events happened as depicted, or that the material is admissible. In
 * every mode PROOVRA received bytes whose creation its SERVER did not observe:
 * the direct-capture channels (UC-1 onward, `isDirectCapture: true`) are
 * client-attested captures, never server-observed ones (see provenanceTier).
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
   * UC-1 — the PROOVRA browser extension reports it captured a web page, in a
   * server-issued capture session (the extension opens it; the server does not
   * verify it preceded the capture — ET-DC-02). The first `isDirectCapture:
   * true` channel: a CLIENT-ATTESTED capture (ET-DC-03) — the server recomputed
   * every artifact's digest but did not observe the capture. It still does not
   * prove the page's content, the site's genuineness or the bytes' server
   * origin (see the limitations below).
   */
  "DIRECT_WEB_CAPTURE_EXTENSION",
  /**
   * UC-2 — the PROOVRA Android app reports it captured the device screen,
   * through Android's MediaProjection consent, in a server-issued capture
   * session (opened by the app after the capture; never verified as preceding
   * it — ET-DC-02). Like UC-1 a CLIENT-ATTESTED capture: the server recomputed
   * every artifact's digest. It still does not prove the displayed content, who
   * or what produced it, or that the Android device was uncompromised (see the
   * limitations below). It is NOT the same as `PROOVRA_MOBILE_APP`, which is a
   * generic mobile submission of a file PROOVRA did not observe being produced.
   */
  "DIRECT_SCREEN_CAPTURE_ANDROID",
  /**
   * UC-3 — the PROOVRA Android app captured a CONTINUOUS/streaming screen session
   * (a bounded recording split into ORIGINAL segments), through MediaProjection
   * consent, in a server-issued capture session. Like the UC-2 frame mode this is
   * `isDirectCapture: true` and the server recomputes every segment's digest. It
   * is a DISTINCT mode from `DIRECT_SCREEN_CAPTURE_ANDROID` (deliberate single
   * frames) so downstream can state continuity truthfully — a continuous session
   * can be COMPLETE or INTERRUPTED, and it never proves the displayed content,
   * source app, device integrity, or that no gap occurred beyond what the
   * continuity manifest records.
   */
  "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
  /**
   * UC-5 — the PROOVRA iOS app reports it captured the device screen through
   * Apple's user-authorized system screen broadcast (ReplayKit
   * `RPSystemBroadcastPickerView` + a PROOVRA Broadcast Upload Extension), in a
   * server-issued capture session (not verified as preceding the capture). Like
   * the Android screen modes a CLIENT-ATTESTED capture; the server recomputes
   * every segment's digest. It is a DISTINCT mode from the Android screen modes
   * because the provenance differs: iOS capture is a SYSTEM-CONTROLLED broadcast
   * — the user starts and stops it from Apple's own broadcast UI, protected/DRM
   * content is omitted by the OS, and the app does not observe frames outside the
   * authorised broadcast. It never proves the displayed content, source app,
   * device integrity, or that no gap occurred beyond what the continuity manifest
   * records. A single iOS mode (not two) reflects that Apple exposes ONE
   * user-authorised system-broadcast path, which is inherently continuous.
   */
  "DIRECT_SCREEN_CAPTURE_IOS",
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
 * PROVENANCE TIERS (owner decision 4, ET-DC-03, 2026-09-29).
 *
 *   SERVER_OBSERVED_CAPTURE   the PROOVRA server itself observed the capture
 *                             (verifiable proof — e.g. a positive platform
 *                             attestation verdict — binds the bytes to
 *                             PROOVRA's capture code). NO ingress channel
 *                             reaches this tier today: no attestation provider
 *                             can return a positive verdict.
 *   CLIENT_ATTESTED_CAPTURE   PROOVRA software on the user's device reports it
 *                             produced the bytes in a server-issued session.
 *                             The server recomputed every digest, but it did
 *                             not observe the capture; the claim is the
 *                             client's.
 *   IMPORTED_EXISTING_MEDIA   a file PROOVRA did not see being created.
 *
 * The tier, not `isDirectCapture`, is what a surface may state about WHO
 * produced the bytes. `isDirectCapture` only names the ingress channel: the
 * caller chose the channel's mode string, and nothing proves the client.
 */
export const EVIDENCE_PROVENANCE_TIERS = [
  "SERVER_OBSERVED_CAPTURE",
  "CLIENT_ATTESTED_CAPTURE",
  "IMPORTED_EXISTING_MEDIA",
] as const;
export type EvidenceProvenanceTier = (typeof EVIDENCE_PROVENANCE_TIERS)[number];

export const EVIDENCE_PROVENANCE_TIER_LABELS: Readonly<Record<EvidenceProvenanceTier, string>> = {
  SERVER_OBSERVED_CAPTURE: "Capture observed by PROOVRA",
  CLIENT_ATTESTED_CAPTURE: "Capture reported by PROOVRA software (client-attested)",
  IMPORTED_EXISTING_MEDIA: "Existing media received by PROOVRA",
};

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
  /** What PROOVRA itself observed (server-side), and nothing more. */
  observedByProovra: string;
  /** What the client or the submitter reported, unverified by PROOVRA. */
  attested: string;
  /** What happened before PROOVRA had any visibility of the material. */
  beforeProovraVisibility: string;
  /**
   * True for the direct-capture CHANNELS (a PROOVRA capture client in a
   * server-issued session). It names the channel only — see provenanceTier.
   */
  isDirectCapture: boolean;
  provenanceTier: EvidenceProvenanceTier;
  /** Bounded limitation codes that always accompany the statement. */
  limitations: ReadonlyArray<AcquisitionLimitationCode>;
};

export const ACQUISITION_LIMITATION_CODES = [
  "CREATION_NOT_OBSERVED_BY_PROOVRA",
  "ACQUISITION_NOT_RECORDED",
  "CLIENT_REPORTED_CAPTURE_SOURCE",
  "DEVICE_INTEGRITY_NOT_VERIFIED",
  // ET-DC-02/03: every direct-capture channel.
  "CAPTURE_CLIENT_ATTESTED",
  // UC-1 direct web capture.
  "WEB_CONTENT_TRUTH_NOT_PROVEN",
  "WEB_SERVER_ORIGIN_NOT_PROVEN",
  "WEB_PAGE_STATE_AT_CAPTURE",
  // UC-2 Android direct screen capture.
  "SCREEN_CONTENT_TRUTH_NOT_PROVEN",
  "SCREEN_SOURCE_APP_NOT_PROVEN",
  "SCREEN_DEVICE_INTEGRITY_NOT_VERIFIED",
  // UC-3 Android continuous screen capture.
  "SCREEN_SESSION_CONTINUITY_LIMITED",
  // UC-5 iOS system screen broadcast.
  "SCREEN_IOS_CONTENT_TRUTH_NOT_PROVEN",
  "SCREEN_IOS_SOURCE_APP_NOT_PROVEN",
  "SCREEN_IOS_DEVICE_INTEGRITY_NOT_VERIFIED",
  "SCREEN_IOS_SYSTEM_BROADCAST_SCOPE",
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
  CAPTURE_CLIENT_ATTESTED:
    "The capture ran on the user's device. The PROOVRA server did not observe it: that PROOVRA's software produced these bytes, and when the capture happened relative to the session, are reported by the client and not independently proven.",
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
  SCREEN_SESSION_CONTINUITY_LIMITED:
    "A continuous screen capture is preserved as a sequence of segments. PROOVRA records the segment order and any interruptions it detected (a stop, an OS revocation, a device or orientation change); it does not guarantee that nothing occurred in a gap, and an interrupted session is recorded as such rather than as a complete one.",
  SCREEN_IOS_CONTENT_TRUTH_NOT_PROVEN:
    "A screen capture preserves what was shown on the iOS device's screen. It does not establish that the displayed content is true, who authored it, or that any person or account shown is genuine.",
  SCREEN_IOS_SOURCE_APP_NOT_PROVEN:
    "PROOVRA does not prove which app produced what was on screen, or that the underlying app or server actually supplied the displayed data. Content displayed by a modified app, a mock-up or an overlay cannot be ruled out.",
  SCREEN_IOS_DEVICE_INTEGRITY_NOT_VERIFIED:
    "The integrity of the iOS device and OS was not independently verified. A jailbroken or otherwise modified device cannot be ruled out.",
  SCREEN_IOS_SYSTEM_BROADCAST_SCOPE:
    "iOS screen capture runs as an Apple system broadcast that the user starts and stops from Apple's own broadcast controls. The operating system omits protected (DRM) content and can end the broadcast at any time; PROOVRA records only the frames Apple delivered to its broadcast extension during the authorised session, preserved as ordered segments, and marks an interrupted session as such rather than as a complete one.",
};

const DESCRIPTORS: Readonly<Record<ProjectedAcquisitionMode, ModeDescriptor>> = {
  PROOVRA_WEB_UPLOAD: {
    category: "UPLOAD",
    label: "Uploaded to PROOVRA",
    statement:
      "Files submitted through PROOVRA Web Upload. PROOVRA did not observe creation or editing before submission.",
    observedByProovra:
      "The upload of these files by a signed-in account, their bytes as received, and their digests when the upload was completed.",
    attested:
      "File names and any device or browser details sent with the upload.",
    beforeProovraVisibility:
      "How, when and by whom the files were created, and any editing before submission.",
    isDirectCapture: false,
    provenanceTier: "IMPORTED_EXISTING_MEDIA",
    limitations: ["CREATION_NOT_OBSERVED_BY_PROOVRA"],
  },
  SECURE_INTAKE_LINK: {
    category: "SECURE_INTAKE",
    label: "Submitted through a secure intake link",
    statement:
      "This material was submitted to PROOVRA through a secure intake link. PROOVRA established integrity when the submission was completed.",
    observedByProovra:
      "The submission of these files through a secure intake link, their bytes as received, and their digests when the submission was completed.",
    attested:
      "Everything the contributor entered or their browser reported, including file names and any location the contributor shared.",
    beforeProovraVisibility:
      "How, when and by whom the files were created, and any editing before submission. The contributor's identity is not independently verified.",
    isDirectCapture: false,
    provenanceTier: "IMPORTED_EXISTING_MEDIA",
    limitations: ["CREATION_NOT_OBSERVED_BY_PROOVRA"],
  },
  PROOVRA_MOBILE_APP: {
    category: "MOBILE_APP",
    label: "Submitted through the PROOVRA mobile app",
    statement:
      "This material was submitted through the PROOVRA mobile app in a server-issued capture session. PROOVRA established integrity when the session was completed.",
    observedByProovra:
      "The submission in a server-issued capture session, the bytes as received, and their digests when the session was completed.",
    attested:
      "Whether an item came from the app's camera or from files on the device, and the device details the app reported.",
    beforeProovraVisibility:
      "How the material was produced on the device, and any editing before submission.",
    isDirectCapture: false,
    provenanceTier: "IMPORTED_EXISTING_MEDIA",
    limitations: [
      "CREATION_NOT_OBSERVED_BY_PROOVRA",
      "CLIENT_REPORTED_CAPTURE_SOURCE",
      "DEVICE_INTEGRITY_NOT_VERIFIED",
    ],
  },
  DIRECT_WEB_CAPTURE_EXTENSION: {
    category: "DIRECT_WEB_CAPTURE",
    label: "Web capture — PROOVRA extension (client-attested)",
    statement:
      "The PROOVRA browser extension reports that it captured this web page, in a server-issued capture session. PROOVRA independently recomputed the digest of every captured artifact and established integrity when the session was completed.",
    observedByProovra:
      "A server-issued capture session, the captured artifacts as received, and the digest of every artifact, recomputed by PROOVRA.",
    attested:
      "That the PROOVRA extension captured the page, when it did so relative to the session, and the page address and browser details it reported.",
    beforeProovraVisibility:
      "The page's content and how it was served or altered in the browser before capture.",
    isDirectCapture: true,
    provenanceTier: "CLIENT_ATTESTED_CAPTURE",
    limitations: [
      "CAPTURE_CLIENT_ATTESTED",
      "WEB_CONTENT_TRUTH_NOT_PROVEN",
      "WEB_SERVER_ORIGIN_NOT_PROVEN",
      "WEB_PAGE_STATE_AT_CAPTURE",
    ],
  },
  DIRECT_SCREEN_CAPTURE_ANDROID: {
    category: "DIRECT_SCREEN_CAPTURE",
    label: "Android screen capture — PROOVRA app (client-attested)",
    statement:
      "The PROOVRA Android app reports that it captured this device screen, using Android's screen-capture consent, in a server-issued capture session. PROOVRA independently recomputed the digest of every captured frame and established integrity when the session was completed.",
    observedByProovra:
      "A server-issued capture session, the captured frames as received, and the digest of every frame, recomputed by PROOVRA.",
    attested:
      "That the PROOVRA Android app captured the screen, when, and the device details it reported.",
    beforeProovraVisibility:
      "What produced the content shown on screen, and the state of the device.",
    isDirectCapture: true,
    provenanceTier: "CLIENT_ATTESTED_CAPTURE",
    limitations: [
      "CAPTURE_CLIENT_ATTESTED",
      "SCREEN_CONTENT_TRUTH_NOT_PROVEN",
      "SCREEN_SOURCE_APP_NOT_PROVEN",
      "SCREEN_DEVICE_INTEGRITY_NOT_VERIFIED",
    ],
  },
  DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS: {
    category: "DIRECT_SCREEN_CAPTURE",
    label: "Android screen recording — PROOVRA app (client-attested)",
    statement:
      "The PROOVRA Android app reports that it recorded this device screen continuously, using Android's screen-capture consent, in a server-issued capture session. The recording is preserved as ordered segments; PROOVRA independently recomputed the digest of every segment and established integrity when the session was completed.",
    observedByProovra:
      "A server-issued capture session, the recorded segments as received, their order, and the digest of every segment, recomputed by PROOVRA.",
    attested:
      "That the PROOVRA Android app recorded the screen continuously, the interruptions it reported, and the device details it reported.",
    beforeProovraVisibility:
      "What produced the content shown on screen, and the state of the device.",
    isDirectCapture: true,
    provenanceTier: "CLIENT_ATTESTED_CAPTURE",
    limitations: [
      "CAPTURE_CLIENT_ATTESTED",
      "SCREEN_CONTENT_TRUTH_NOT_PROVEN",
      "SCREEN_SOURCE_APP_NOT_PROVEN",
      "SCREEN_DEVICE_INTEGRITY_NOT_VERIFIED",
      "SCREEN_SESSION_CONTINUITY_LIMITED",
    ],
  },
  DIRECT_SCREEN_CAPTURE_IOS: {
    category: "DIRECT_SCREEN_CAPTURE",
    label: "iOS screen recording — PROOVRA app (client-attested)",
    statement:
      "The PROOVRA iOS app reports that it recorded this device screen through Apple's user-authorised system screen broadcast, in a server-issued capture session. The broadcast is preserved as ordered segments; PROOVRA independently recomputed the digest of every segment and established integrity when the session was completed.",
    observedByProovra:
      "A server-issued capture session, the broadcast segments as received, their order, and the digest of every segment, recomputed by PROOVRA.",
    attested:
      "That the PROOVRA iOS app recorded Apple's system screen broadcast, the interruptions it reported, and the device details it reported.",
    beforeProovraVisibility:
      "What produced the content shown on screen, and the state of the device.",
    isDirectCapture: true,
    provenanceTier: "CLIENT_ATTESTED_CAPTURE",
    limitations: [
      "CAPTURE_CLIENT_ATTESTED",
      "SCREEN_IOS_CONTENT_TRUTH_NOT_PROVEN",
      "SCREEN_IOS_SOURCE_APP_NOT_PROVEN",
      "SCREEN_IOS_DEVICE_INTEGRITY_NOT_VERIFIED",
      "SCREEN_IOS_SYSTEM_BROADCAST_SCOPE",
    ],
  },
  LEGACY_NOT_RECORDED: {
    category: "NOT_RECORDED",
    label: "Not recorded",
    statement:
      "How this record entered PROOVRA was not recorded when it was created.",
    observedByProovra:
      "How this record entered PROOVRA was not recorded.",
    attested:
      "Not recorded.",
    beforeProovraVisibility:
      "Not known.",
    isDirectCapture: false,
    provenanceTier: "IMPORTED_EXISTING_MEDIA",
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
  /** What PROOVRA observed / what was attested / what preceded visibility. */
  observedByProovra: string;
  attested: string;
  beforeProovraVisibility: string;
  isDirectCapture: boolean;
  /** Owner decision 4: what may be said about who produced the bytes. */
  provenanceTier: EvidenceProvenanceTier;
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
    observedByProovra: d.observedByProovra,
    attested: d.attested,
    beforeProovraVisibility: d.beforeProovraVisibility,
    isDirectCapture: d.isDirectCapture,
    provenanceTier: d.provenanceTier,
    limitations: d.limitations,
  };
}

/**
 * ET-INT-12 — THE "submitted by" attribution of a secure-intake record, on
 * every surface (report, package, public Verify). It is a ROLE: the workspace
 * account on the record is the link's creator, not the person who submitted,
 * so that account's email, sign-in provider and identity level are never
 * presented as the submitter's.
 */
export const INTAKE_SUBMITTED_BY_LABEL = "Remote Contributor via Secure Intake Link";

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
  // UC-PROV-001 — for a direct capture the record is created when the server
  // receives the capture session (the extension reserves it AFTER the capture
  // ran): the value is the server-received time, never a capture time.
  if (
    mode === "DIRECT_WEB_CAPTURE_EXTENSION" ||
    mode === "DIRECT_SCREEN_CAPTURE_ANDROID" ||
    mode === "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS" ||
    mode === "DIRECT_SCREEN_CAPTURE_IOS"
  ) {
    return "Server received at (server UTC)";
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
  // UC-4 — DERIVED evidence intelligence transformations. Keyframes/crops are
  // ordinary EvidencePartDerivedAsset rows (destruction + storage accounting already
  // cover them); their per-keyframe identity is the derived-asset variantKey.
  "video-keyframe/v1",
  "screen-crop/v1",
  "screen-ocr/v1",
  "screen-overlap-analysis/v1",
  "screen-conversation-reconstruction/v1",
  "unspecified-legacy",
] as const;
export type DerivedAssetTransformation =
  (typeof DERIVED_ASSET_TRANSFORMATIONS)[number];

export const DEFAULT_DERIVED_ASSET_VARIANT_KEY = "default" as const;

/** UC-4 — new DERIVED asset kinds (free-text `assetKind`, no schema/CHECK change). */
export const UC4_DERIVED_ASSET_KINDS = [
  "video_keyframe",
  "screen_crop",
  // The reconstruction PRODUCT: one bounded versioned JSON descriptor per run,
  // stored as this derived asset's object bytes (variantKey recon-vN).
  "screen_reconstruction",
] as const;
export type Uc4DerivedAssetKind = (typeof UC4_DERIVED_ASSET_KINDS)[number];

const TRANSFORMATION_BY_KIND: Readonly<Record<string, DerivedAssetTransformation>> = {
  image_thumbnail: "image-thumbnail/v1",
  video_frame: "video-frame/v1",
  audio_waveform: "audio-waveform/v1",
  low_res_proxy: "low-res-proxy/v1",
  compact_review_preview: "review-preview/v1",
  video_keyframe: "video-keyframe/v1",
  screen_crop: "screen-crop/v1",
  screen_reconstruction: "screen-conversation-reconstruction/v1",
};

export function derivedAssetTransformationForKind(
  assetKind: string,
): DerivedAssetTransformation {
  return TRANSFORMATION_BY_KIND[assetKind] ?? "unspecified-legacy";
}

/** Search/package marker for text that PROOVRA derived from a source artifact. */
export const DERIVED_TEXT_PROVENANCE = "DERIVED_MACHINE_EXTRACTED" as const;

/** UC-4 — marker for review content PROOVRA RECONSTRUCTED (never directly acquired). */
export const DERIVED_RECONSTRUCTED_PROVENANCE = "DERIVED_RECONSTRUCTED" as const;

/** The provenance markers a search/package surface may attach to derived text. */
export const DERIVED_TEXT_PROVENANCES = [
  DERIVED_TEXT_PROVENANCE,
  DERIVED_RECONSTRUCTED_PROVENANCE,
] as const;
export type DerivedTextProvenance = (typeof DERIVED_TEXT_PROVENANCES)[number];

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
    /** Owner decision 4 (ET-DC-03). */
    provenanceTier: EvidenceProvenanceTier;
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
