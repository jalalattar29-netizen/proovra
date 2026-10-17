"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CAPTURE_LOCATION_MAP_ATTRIBUTION,
  buildCaptureLocationDisplayModel,
  isValidCaptureCoordinatePair,
  resolveApprovedTileTemplate,
} from "@proovra/shared";

/**
 * THE RECORDED-LOCATION PANEL (2026-10-17) — one presentation for the owner
 * Evidence page and the full Public Verify page.
 *
 * WHAT WAS HERE: a dark panel drawing a synthetic grid with curved "roads"
 * under the label "Map imagery unavailable". It looked like a map and carried
 * no geography at all.
 *
 * WHAT IS HERE NOW, by what is true:
 *   - an approved tile endpoint is configured (AUD-025: never a public tile
 *     provider — the one policy, `resolveApprovedTileTemplate`, shared with the
 *     report worker) → a REAL map of the recorded coordinates: tiles, marker,
 *     the recorded accuracy radius, zoom controls and attribution;
 *   - no endpoint, or the tiles fail → a compact "Recorded location" card with
 *     the same facts and actions, saying only that the map PREVIEW is
 *     unavailable — never that the location is;
 *   - coordinates out of range → a neutral unavailable state and no outbound
 *     link (fail closed).
 * Coordinates reported by a device are never shown as verified.
 */
const CONFIGURED_TILE_TEMPLATE = resolveApprovedTileTemplate(
  process.env.NEXT_PUBLIC_CAPTURE_LOCATION_TILE_URL,
).template;

const MIN_ZOOM = 3;
const MAX_ZOOM = 19;

type CaptureLocationMapPanelProps = {
  lat: number;
  lng: number;
  accuracyMeters?: number | null;
  addToast?: (message: string, type: "success" | "info" | "error" | "warning") => void;
  height?: number;
  rounded?: number;
  /**
   * The mapped label for the record's location source (e.g. "Reported by the
   * submitting browser"). Null/absent is stated as "Location source not
   * recorded" — never as "location not recorded".
   */
  sourceLabel?: string | null;
  /** Test/override seam; defaults to the deployment's approved endpoint. */
  tileTemplate?: string | null;
  /** Off where the surrounding page already states the location boundary. */
  showBoundary?: boolean;
};

const BOUNDARY =
  "Reported by the capturing device or client: where the device reported itself to be. It does not independently prove where the subject matter was, and the accuracy is recorded metadata, not a guarantee.";

export default function CaptureLocationMapPanel(props: CaptureLocationMapPanelProps) {
  const valid = isValidCaptureCoordinatePair({ lat: props.lat, lng: props.lng });
  const accuracy =
    typeof props.accuracyMeters === "number" && Number.isFinite(props.accuracyMeters) && props.accuracyMeters >= 0
      ? props.accuracyMeters
      : null;
  const tileTemplate =
    props.tileTemplate === undefined ? CONFIGURED_TILE_TEMPLATE : resolveApprovedTileTemplate(props.tileTemplate).template;

  const base = useMemo(
    () =>
      valid
        ? buildCaptureLocationDisplayModel({ lat: props.lat, lng: props.lng, accuracyMeters: accuracy, width: 1200, height: 560 })
        : null,
    [valid, props.lat, props.lng, accuracy],
  );
  const [zoom, setZoom] = useState<number | null>(null);
  const [tilesFailed, setTilesFailed] = useState(false);
  useEffect(() => {
    setZoom(null);
    setTilesFailed(false);
  }, [props.lat, props.lng, accuracy, tileTemplate]);

  const display = useMemo(
    () =>
      valid && base
        ? buildCaptureLocationDisplayModel({
            lat: props.lat,
            lng: props.lng,
            accuracyMeters: accuracy,
            width: 1200,
            height: 560,
            zoom: zoom ?? base.zoom,
            tileTemplate,
          })
        : null,
    [valid, base, props.lat, props.lng, accuracy, zoom, tileTemplate],
  );

  const panelStyle: React.CSSProperties = {
    border: "1px solid var(--border-default, #e2e8f0)",
    borderRadius: props.rounded ?? 16,
    background: "var(--surface-card, #ffffff)",
    overflow: "hidden",
  };

  if (!valid || !display) {
    return (
      <div style={{ ...panelStyle, padding: 16 }} data-capture-location-map="invalid" role="group" aria-label="Recorded location">
        <div style={{ fontSize: 14, fontWeight: 650, color: "var(--ink-primary, #0f172a)" }}>Location unavailable</div>
        <div style={{ fontSize: 13, color: "var(--ink-secondary, #475569)", marginTop: 4 }}>
          The recorded coordinates are not valid, so no map or location link is shown.
        </div>
      </div>
    );
  }

  const showTiles = Boolean(tileTemplate) && !tilesFailed && display.tiles.some((t) => t.url);
  // Absent (undefined) is omitted; an explicit null is stated as not recorded.
  const sourceText = props.sourceLabel === undefined ? null : (props.sourceLabel ?? "Location source not recorded");
  const coordinates = `${display.latLabel}, ${display.lngLabel}`;

  const handleCopyCoordinates = async () => {
    try {
      await navigator.clipboard.writeText(coordinates);
      props.addToast?.("Coordinates copied", "success");
    } catch {
      props.addToast?.("Could not copy coordinates", "warning");
    }
  };

  const markerX = (display.markerX / display.width) * 100;
  const markerY = (display.markerY / display.height) * 100;
  const radiusX = accuracy === null ? 0 : Math.min(48, (display.accuracyRadiusPx * 100) / display.width);
  const radiusY = accuracy === null ? 0 : Math.min(48, (display.accuracyRadiusPx * 100) / display.height);

  return (
    <div style={panelStyle} data-capture-location-map={showTiles ? "tiles" : "fallback"} role="group" aria-label="Recorded location">
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 12, padding: "14px 16px" }}>
        <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-secondary, #475569)" }}>
            Recorded location
          </div>
          <div style={{ fontSize: 15, fontWeight: 650, color: "var(--ink-primary, #0f172a)", overflowWrap: "anywhere" }} data-capture-location-coordinates>
            {coordinates}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 14px", fontSize: 12.5, color: "var(--ink-secondary, #475569)" }}>
            <span data-capture-location-accuracy={accuracy === null ? "not-recorded" : String(accuracy)}>
              {accuracy === null ? "Accuracy not recorded" : `Accuracy ${display.accuracyLabel}`}
            </span>
            {sourceText !== null ? <span data-capture-location-source-label="true">{sourceText}</span> : null}
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 8 }}>
          <button type="button" className="app-secondary-action" onClick={handleCopyCoordinates} data-map-action="copy-coordinates">
            Copy coordinates
          </button>
          <a
            className="app-secondary-action"
            href={display.externalMapUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-map-action="open-in-map"
          >
            Open in map
          </a>
        </div>
      </div>

      {showTiles ? (
        <div
          role="img"
          aria-label={`Map of the recorded location at ${coordinates}${accuracy === null ? "" : `, accuracy ${display.accuracyLabel}`}`}
          data-capture-location-map-view
          data-map-zoom={display.zoom}
          style={{
            position: "relative",
            height: props.height ?? 280,
            overflow: "hidden",
            borderTop: "1px solid var(--border-default, #e2e8f0)",
            background: "var(--surface-muted, #f1f5f9)",
          }}
        >
          {display.tiles.map((tile) =>
            tile.url ? (
              <img
                key={tile.key}
                src={tile.url}
                alt=""
                draggable={false}
                referrerPolicy="no-referrer"
                onError={() => setTilesFailed(true)}
                data-map-tile={tile.key}
                style={{
                  position: "absolute",
                  left: `${(tile.left / display.width) * 100}%`,
                  top: `${(tile.top / display.height) * 100}%`,
                  width: `${(tile.width / display.width) * 100}%`,
                  height: `${(tile.height / display.height) * 100}%`,
                  objectFit: "cover",
                  filter: "saturate(0.85)",
                }}
              />
            ) : null,
          )}
          {accuracy !== null ? (
            <div
              data-map-accuracy-radius={accuracy}
              style={{
                position: "absolute",
                left: `${markerX}%`,
                top: `${markerY}%`,
                width: `${radiusX * 2}%`,
                height: `${radiusY * 2}%`,
                transform: "translate(-50%, -50%)",
                borderRadius: "50%",
                background: "color-mix(in srgb, var(--info, #2563eb) 14%, transparent)",
                border: "2px solid color-mix(in srgb, var(--info, #2563eb) 55%, transparent)",
              }}
            />
          ) : null}
          <div
            data-map-marker
            style={{
              position: "absolute",
              left: `${markerX}%`,
              top: `${markerY}%`,
              width: 16,
              height: 16,
              transform: "translate(-50%, -50%)",
              borderRadius: "50%",
              background: "var(--info, #2563eb)",
              border: "3px solid #ffffff",
              boxShadow: "0 2px 6px rgba(15,23,42,0.35)",
            }}
          />
          <div style={{ position: "absolute", insetInlineEnd: 10, insetBlockStart: 10, display: "grid", gap: 4 }}>
            <button
              type="button"
              className="app-secondary-action"
              aria-label="Zoom in"
              data-map-action="zoom-in"
              disabled={display.zoom >= MAX_ZOOM}
              onClick={() => setZoom(Math.min(MAX_ZOOM, display.zoom + 1))}
              style={{ minWidth: 32, padding: "2px 8px" }}
            >
              +
            </button>
            <button
              type="button"
              className="app-secondary-action"
              aria-label="Zoom out"
              data-map-action="zoom-out"
              disabled={display.zoom <= MIN_ZOOM}
              onClick={() => setZoom(Math.max(MIN_ZOOM, display.zoom - 1))}
              style={{ minWidth: 32, padding: "2px 8px" }}
            >
              −
            </button>
          </div>
          <div
            data-map-attribution
            style={{
              position: "absolute",
              insetInlineEnd: 0,
              insetBlockEnd: 0,
              padding: "2px 6px",
              fontSize: 11,
              background: "rgba(255,255,255,0.85)",
              color: "var(--ink-secondary, #475569)",
            }}
          >
            {CAPTURE_LOCATION_MAP_ATTRIBUTION}
          </div>
        </div>
      ) : (
        <div
          data-capture-location-map-unavailable
          style={{
            borderTop: "1px solid var(--border-default, #e2e8f0)",
            padding: "8px 16px",
            fontSize: 12.5,
            color: "var(--ink-secondary, #475569)",
            background: "var(--surface-muted, #f8fafc)",
          }}
        >
          Map preview unavailable
        </div>
      )}

      {props.showBoundary === false ? null : (
      <p style={{ margin: 0, padding: "10px 16px 14px", fontSize: 12, lineHeight: 1.5, color: "var(--ink-secondary, #475569)" }} data-capture-location-boundary>
        {BOUNDARY}
      </p>
      )}
    </div>
  );
}
