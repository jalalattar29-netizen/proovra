/**
 * Builds the PROOVRA_WEB_CAPTURE_MANIFEST_V1 the extension uploads and the
 * server validates. Uses the ONE shared schema so client and server cannot
 * drift. Pure and unit-tested. The manifest cannot declare itself verified.
 */
import {
  WEB_CAPTURE_MANIFEST_SCHEMA_VERSION,
  publicDomainFromUrl,
  validateWebCaptureManifest,
  type WebCaptureManifest,
  type WebCaptureArtifactDescriptor,
  type WebCaptureMode,
  type WebCaptureCompleteness,
  type WebCaptureLimitationCode,
} from "@proovra/shared";

export type BuildManifestInput = {
  captureMode: WebCaptureMode;
  captureSessionId: string;
  captureStartedAtUtc: string;
  captureEndedAtUtc: string;
  sourceUrl: string;
  title: string | null;
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
  pageMutatedDuringCapture: boolean;
  limitations: WebCaptureLimitationCode[];
  /**
   * UC-EXT-004 — the sanitized DOM snapshot the popup promises was NOT
   * produced (the content script failed or returned nothing). The manifest
   * schema has no limitation code for it, so it is disclosed in `notes` and
   * makes the capture PARTIAL.
   */
  domSnapshotMissing?: boolean;
  notes: string[];
};

/**
 * Overall completeness (UC-EXT-004).
 *
 * A capture is CAPTURED only when every artifact is CAPTURED, the page did not
 * mutate, the DOM snapshot exists and NO limitation was detected. ANY
 * limitation — including CAPTURE_INTERRUPTED (the time budget or a tile failure
 * cut the capture short), CROSS_ORIGIN_IFRAME_NOT_CAPTURED,
 * SHADOW_DOM_NOT_FULLY_REPRESENTED, PROTECTED_MEDIA_NOT_CAPTURED and
 * DYNAMIC_CONTENT_MAY_BE_INCOMPLETE — means the record is not a complete
 * representation, so it is PARTIAL. It used to consider only mutation and
 * truncation, so an interrupted capture was labelled CAPTURED.
 */
export function deriveCompleteness(
  artifacts: WebCaptureArtifactDescriptor[],
  facts: {
    pageMutated: boolean;
    limitations: ReadonlyArray<WebCaptureLimitationCode>;
    domSnapshotMissing?: boolean;
  },
): WebCaptureCompleteness {
  if (artifacts.length === 0) return "FAILED";
  if (artifacts.some((a) => a.completeness === "FAILED")) return "FAILED";
  if (
    facts.pageMutated ||
    facts.limitations.length > 0 ||
    facts.domSnapshotMissing === true ||
    artifacts.some((a) => a.completeness !== "CAPTURED")
  ) {
    return "PARTIAL";
  }
  return "CAPTURED";
}

/** The manifest note that discloses a missing DOM snapshot. */
export const DOM_SNAPSHOT_MISSING_NOTE =
  "DOM snapshot not produced: the page did not return a sanitized copy of its structure, so this record holds screenshots only.";

export function buildWebCaptureManifest(input: BuildManifestInput): {
  manifest: WebCaptureManifest;
  manifestJson: string;
} {
  const domain = publicDomainFromUrl(input.sourceUrl) ?? "unknown";
  const manifest: WebCaptureManifest = {
    schemaVersion: WEB_CAPTURE_MANIFEST_SCHEMA_VERSION,
    captureMode: input.captureMode,
    captureSessionId: input.captureSessionId,
    captureStartedAtUtc: input.captureStartedAtUtc,
    captureEndedAtUtc: input.captureEndedAtUtc,
    page: {
      domain,
      sourceUrlPrivate: input.sourceUrl.slice(0, 4096),
      title: input.title ? input.title.slice(0, 400) : null,
    },
    browser: input.browser,
    extensionVersion: input.extensionVersion,
    artifacts: input.artifacts,
    completeness: deriveCompleteness(input.artifacts, {
      pageMutated: input.pageMutatedDuringCapture,
      limitations: input.limitations,
      domSnapshotMissing: input.domSnapshotMissing,
    }),
    pageMutatedDuringCapture: input.pageMutatedDuringCapture,
    // A mutated page always carries its limitation code, so the two facts
    // cannot disagree in the record.
    // A mutated page and a missing DOM snapshot always carry their limitation codes
    // (UC-EXT-004), so the facts and the codes cannot disagree in the record.
    limitations: [
      ...input.limitations,
      ...(input.pageMutatedDuringCapture && !input.limitations.includes("PAGE_MUTATED_DURING_CAPTURE")
        ? (["PAGE_MUTATED_DURING_CAPTURE"] as const)
        : []),
      ...(input.domSnapshotMissing && !input.limitations.includes("DOM_SNAPSHOT_MISSING")
        ? (["DOM_SNAPSHOT_MISSING"] as const)
        : []),
    ],
    notes: [
      ...(input.domSnapshotMissing && !input.notes.includes(DOM_SNAPSHOT_MISSING_NOTE)
        ? [DOM_SNAPSHOT_MISSING_NOTE]
        : []),
      ...input.notes,
    ]
      .slice(0, 32)
      .map((n) => n.slice(0, 300)),
  };
  // The client validates its own manifest before upload so a malformed one is
  // caught here rather than as a server refusal after the bytes are sent.
  const check = validateWebCaptureManifest(manifest);
  if (!check.ok) {
    throw new Error(`manifest failed local validation: ${check.error}`);
  }
  // Canonical stable serialization — the EXACT bytes uploaded and hashed.
  const manifestJson = JSON.stringify(manifest);
  return { manifest, manifestJson };
}
