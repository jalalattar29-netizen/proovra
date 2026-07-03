/**
 * FullExifAccordion — expandable "View full EXIF" (Section 3).
 *
 * Shows the representative full EXIF for the primary media item. Full
 * per-file EXIF for every part is preserved in the Verification Package
 * (technical-metadata/exif-details.json) — noted here so reviewers know
 * where the exhaustive per-file record lives.
 */

"use client";

import { MetadataRows } from "./MetadataRow";
import type { AppendixRow } from "./types";

export function FullExifAccordion({
  rows,
  multipart,
}: {
  rows: AppendixRow[];
  multipart: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <details className="ta-accordion" data-testid="ta-full-exif">
      <summary className="ta-accordion-summary">View full EXIF</summary>
      <div className="ta-accordion-body">
        <MetadataRows rows={rows} empty="No EXIF metadata recorded." />
        {multipart ? (
          <p className="ta-advisory">
            Representative EXIF is shown for the primary media item. Full
            per-file EXIF for every part is included in the Verification
            Package.
          </p>
        ) : null}
      </div>
    </details>
  );
}
