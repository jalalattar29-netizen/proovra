/**
 * F-33 (independent forward audit, 2026-10-21) — WHICH ISSUED ARTIFACT IS
 * CURRENT. Public Verify listed every issued report and package version but
 * never said which one is current or what superseded the one a visitor was
 * given: a canonical reference or a reviewer share opened on "the latest" with
 * no marker, and an older report's holder could not tell it had been replaced.
 *
 * ONE annotation, computed by the server with the history it serves: per kind,
 * the highest version is current, and every other version names the version
 * that immediately superseded it. Clients render it; they never re-derive it.
 */

export type ArtifactHistoryKind = "report" | "package";

export type ArtifactHistoryItem = {
  kind: ArtifactHistoryKind;
  version: number;
  reportVersion: number | null;
  issuedAtUtc: string | null;
};

export type AnnotatedArtifactHistoryItem = ArtifactHistoryItem & {
  /** The latest issued version of its kind. */
  current: boolean;
  /** The version of the same kind that immediately superseded it; null when current. */
  supersededByVersion: number | null;
};

export function annotateArtifactHistory(items: ReadonlyArray<ArtifactHistoryItem>): AnnotatedArtifactHistoryItem[] {
  const versionsByKind = new Map<ArtifactHistoryKind, number[]>();
  for (const item of items) {
    const list = versionsByKind.get(item.kind) ?? [];
    if (!list.includes(item.version)) list.push(item.version);
    versionsByKind.set(item.kind, list);
  }
  for (const list of versionsByKind.values()) list.sort((a, b) => a - b);
  return items.map((item) => {
    const list = versionsByKind.get(item.kind)!;
    const next = list.find((v) => v > item.version) ?? null;
    return { ...item, current: next === null, supersededByVersion: next };
  });
}

/** The words every surface uses for an annotated history entry. */
export function artifactHistoryStatusLabel(item: Pick<AnnotatedArtifactHistoryItem, "kind" | "current" | "supersededByVersion">): string {
  if (item.current) return "Current";
  return item.supersededByVersion !== null
    ? `Superseded by ${item.kind === "report" ? "report" : "package"} v${item.supersededByVersion}`
    : "Superseded";
}

/**
 * F-36 (independent forward audit) — THE response headers of a presigned
 * ORIGINAL handed to a reviewer share. The URL is served by the storage
 * origin, which cannot be told "nosniff" through a presigned URL; without an
 * override an HTML / SVG / XML / script original rendered there as an active
 * page. (Closure, 2026-10-21) The decision is an ALLOWLIST of media types a
 * browser only ever renders as inert media or a PDF: everything else — any
 * text/*, any XML or script type, an unknown or invented type (the type is
 * whatever the uploader declared, never trusted) — is a download as
 * application/octet-stream. The filename never repeats the contributor's
 * original file name.
 */
const INLINE_SAFE_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/heic",
  "image/heif",
  "image/bmp",
  "image/tiff",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
  "application/pdf",
]);

export function presignedOriginalResponseHeaders(
  mimeType: string | null | undefined,
  itemNumber: number,
): { contentDisposition: string; contentType: string } {
  const mime = (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  const name = `proovra-item-${Math.max(1, Math.floor(itemNumber))}`;
  if (!INLINE_SAFE_TYPES.has(mime)) {
    return { contentDisposition: `attachment; filename="${name}"`, contentType: "application/octet-stream" };
  }
  return { contentDisposition: `inline; filename="${name}"`, contentType: mime };
}
