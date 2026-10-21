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
 * origin; without an override an HTML / SVG / XML / script original rendered
 * there as an active page. Active or unknown content is always a download
 * (application/octet-stream, attachment); every other type is viewable inline
 * AS ITS DECLARED TYPE (the stored Content-Type was set by whoever uploaded the
 * bytes, so it is never trusted). The filename never repeats the
 * contributor's original file name.
 */
const ACTIVE_CONTENT = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript|application\/x-javascript|application\/ecmascript|text\/ecmascript|multipart\/)/i;

export function presignedOriginalResponseHeaders(
  mimeType: string | null | undefined,
  itemNumber: number,
): { contentDisposition: string; contentType: string } {
  const mime = (mimeType ?? "").trim().toLowerCase();
  const name = `proovra-item-${Math.max(1, Math.floor(itemNumber))}`;
  if (!mime || ACTIVE_CONTENT.test(mime)) {
    return { contentDisposition: `attachment; filename="${name}"`, contentType: "application/octet-stream" };
  }
  return { contentDisposition: `inline; filename="${name}"`, contentType: mime };
}
