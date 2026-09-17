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
  notes: string[];
};

/** Overall completeness derives from the artifacts and the mutation flag. */
export function deriveCompleteness(
  artifacts: WebCaptureArtifactDescriptor[],
  pageMutated: boolean,
  truncated: boolean,
): WebCaptureCompleteness {
  if (artifacts.some((a) => a.completeness === "FAILED")) return "FAILED";
  if (pageMutated || truncated || artifacts.some((a) => a.completeness !== "CAPTURED")) {
    return "PARTIAL";
  }
  return "CAPTURED";
}

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
    completeness: deriveCompleteness(
      input.artifacts,
      input.pageMutatedDuringCapture,
      input.limitations.includes("PAGE_EXCEEDED_CAPTURE_BOUNDS"),
    ),
    pageMutatedDuringCapture: input.pageMutatedDuringCapture,
    limitations: input.limitations,
    notes: input.notes.slice(0, 32).map((n) => n.slice(0, 300)),
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
