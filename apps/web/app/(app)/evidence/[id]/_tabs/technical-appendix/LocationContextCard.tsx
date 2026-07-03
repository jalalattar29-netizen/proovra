/**
 * LocationContextCard — Section 5.
 *
 * Renders the browser/device-reported capture location with an explicit
 * boundary statement. Coordinates are shown to the authenticated reviewer
 * (the same data is in the review-workspace payload and the PDF report),
 * with copy-coordinates and open-map affordances. When no location exists,
 * a clear empty state is shown.
 */

"use client";

import { MapPin } from "lucide-react";
import { TechnicalAppendixCard } from "./TechnicalAppendixCard";
import {
  AdvisoryNote,
  AppendixEmpty,
  CopyButton,
  MetadataRows,
} from "./MetadataRow";
import { rows } from "./sections-model";

export type SourceCaptureLocation = {
  statusLabel: string;
  description: string;
  lat: number | null;
  lng: number | null;
  accuracyMeters: number | null;
  capturedAtUtc: string;
  deviceTimeIso: string | null;
  source: string;
  externalMapUrl: string | null;
  legalBoundary: string;
} | null;

const DEFAULT_BOUNDARY =
  "Location is device/browser-reported and permission-based. It may support context, but it does not independently prove physical presence.";

export function LocationContextCard({
  location,
}: {
  location: SourceCaptureLocation;
}) {
  const hasCoords =
    location != null && location.lat != null && location.lng != null;

  const coordString = hasCoords
    ? `${location!.lat!.toFixed(6)}, ${location!.lng!.toFixed(6)}`
    : null;

  const bodyRows = location
    ? rows([
        {
          label: "Latitude",
          value: location.lat != null ? location.lat.toFixed(6) : null,
          mono: true,
        },
        {
          label: "Longitude",
          value: location.lng != null ? location.lng.toFixed(6) : null,
          mono: true,
        },
        {
          label: "Accuracy radius",
          value:
            location.accuracyMeters != null
              ? `± ${Math.round(location.accuracyMeters)} m`
              : null,
        },
        { label: "Source", value: location.source },
        { label: "Recorded at (server UTC)", value: location.capturedAtUtc },
      ])
    : [];

  return (
    <TechnicalAppendixCard
      icon={MapPin}
      title="Location"
      subtitle={location?.statusLabel}
      testId="ta-section-location"
    >
      {!location ? (
        <AppendixEmpty>Location was not provided for this evidence.</AppendixEmpty>
      ) : (
        <>
          <MetadataRows rows={bodyRows} empty="Location was not provided." />
          {coordString ? (
            <div className="ta-location-actions">
              <span className="ta-location-coords ta-mono">{coordString}</span>
              <CopyButton value={coordString} label="Copy coordinates" />
              {location.externalMapUrl ? (
                <a
                  className="ta-link-btn"
                  href={location.externalMapUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Open map
                </a>
              ) : null}
            </div>
          ) : null}
          <AdvisoryNote>{location.legalBoundary || DEFAULT_BOUNDARY}</AdvisoryNote>
        </>
      )}
    </TechnicalAppendixCard>
  );
}
