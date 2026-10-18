"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CAPTURE_LOCATION_MAP_ATTRIBUTION,
  buildCaptureLocationDisplayModel,
  PUBLIC_MAP_CONSENT_NOTICE,
  isValidCaptureCoordinatePair,
  resolveInteractiveMapTileSource,
  type InteractiveMapTileSource,
} from "@proovra/shared";

/**
 * THE RECORDED-LOCATION PANEL (2026-10-17) — one presentation for the owner
 * Evidence page and the full Public Verify page.
 *
 * WHAT WAS HERE: a dark panel drawing a synthetic grid with curved "roads"
 * under the label "Map imagery unavailable". It looked like a map and carried
 * no geography at all.
 *
 * WHAT IS HERE NOW (2026-10-18), by the ONE map policy
 * (`resolveInteractiveMapTileSource`):
 *   - the "Recorded location" card — coordinates, accuracy, source, Copy
 *     coordinates, Open in map — always, immediately;
 *   - a privately hosted, approved tile endpoint → the REAL map loads at once
 *     (the location never leaves the deployment);
 *   - otherwise the REAL OpenStreetMap map the panel drew until ebea6a075, but
 *     only after the viewer presses "Load interactive map" under a notice that
 *     loading it sends the approximate location and their IP address to
 *     OpenStreetMap. No tile is requested before that press (no SSR, prefetch
 *     or background load); the choice lives in this view's memory only;
 *   - tiles that genuinely fail → the card says only that the map PREVIEW is
 *     unavailable, never that the location is;
 *   - coordinates out of range → a neutral unavailable state, no tile request,
 *     no outbound link (fail closed).
 * The report worker is unaffected: it still refuses every public provider.
 * A location the API withholds is never passed here. Coordinates reported by
 * a device are never shown as verified.
 */
const CONFIGURED_TILE_SOURCE = resolveInteractiveMapTileSource(
  process.env.NEXT_PUBLIC_CAPTURE_LOCATION_TILE_URL,
);

/** The map model's frame. The view keeps THIS aspect ratio, so tiles scale
 *  uniformly (no stretched tiles, the accuracy circle stays a circle). */
const MAP_WIDTH = 1200;
const MAP_HEIGHT = 680;

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
  /**
   * Test/override seam. Omitted: the deployment's tile source (the one
   * policy). A string: resolved through the same policy. null: no imagery.
   */
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
  const source: InteractiveMapTileSource | null =
    props.tileTemplate === undefined
      ? CONFIGURED_TILE_SOURCE
      : props.tileTemplate === null
        ? null
        : resolveInteractiveMapTileSource(props.tileTemplate);
  // Public tiles wait for the viewer's explicit choice; an approved private
  // endpoint loads at once. The choice is this view's only — never stored.
  const [consented, setConsented] = useState(false);
  const tileTemplate =
    source && (source.mode === "automatic" || consented) ? source.template : null;

  const base = useMemo(
    () =>
      valid
        ? buildCaptureLocationDisplayModel({ lat: props.lat, lng: props.lng, accuracyMeters: accuracy, width: MAP_WIDTH, height: MAP_HEIGHT })
        : null,
    [valid, props.lat, props.lng, accuracy],
  );
  const [zoom, setZoom] = useState<number | null>(null);
  const [tilesFailed, setTilesFailed] = useState(false);
  const [tilesLoaded, setTilesLoaded] = useState(false);
  useEffect(() => {
    setZoom(null);
    setTilesFailed(false);
    setTilesLoaded(false);
  }, [props.lat, props.lng, accuracy, tileTemplate]);

  const display = useMemo(
    () =>
      valid && base
        ? buildCaptureLocationDisplayModel({
            lat: props.lat,
            lng: props.lng,
            accuracyMeters: accuracy,
            width: MAP_WIDTH,
            height: MAP_HEIGHT,
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
  // Waiting for the viewer's choice: public tiles, not yet asked for.
  const awaitingConsent = source?.mode === "consent" && !consented;
  const mapState = showTiles ? "tiles" : awaitingConsent ? "consent" : "fallback";
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
    <div style={panelStyle} data-capture-location-map={mapState} role="group" aria-label="Recorded location">
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
          data-map-loaded={tilesLoaded ? "true" : "false"}
          aria-busy={!tilesLoaded}
          style={{
            position: "relative",
            width: "100%",
            aspectRatio: `${display.width} / ${display.height}`,
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
                // OpenStreetMap's tile policy requires a Referer from a browser
                // (without one it serves an "Access blocked" tile). The ORIGIN
                // only — never the page path, which can carry an evidence id or
                // a verification token.
                referrerPolicy="strict-origin"
                onLoad={() => setTilesLoaded(true)}
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
          {!tilesLoaded ? (
            <div
              data-map-loading
              aria-hidden="true"
              style={{
                position: "absolute",
                insetInlineStart: 10,
                insetBlockStart: 10,
                padding: "2px 8px",
                borderRadius: 6,
                fontSize: 11.5,
                background: "rgba(255,255,255,0.85)",
                color: "var(--ink-secondary, #475569)",
              }}
            >
              Loading map…
            </div>
          ) : null}
        </div>
      ) : awaitingConsent ? (
        <div
          data-capture-location-map-consent
          style={{
            display: "grid",
            justifyItems: "center",
            alignContent: "center",
            gap: 10,
            minHeight: Math.min(props.height ?? 280, 200),
            padding: "18px 16px",
            borderTop: "1px solid var(--border-default, #e2e8f0)",
            background: "var(--surface-muted, #f8fafc)",
            textAlign: "center",
          }}
        >
          <button
            type="button"
            className="app-secondary-action"
            data-map-action="load-interactive-map"
            aria-describedby="capture-location-map-consent-notice"
            onClick={() => setConsented(true)}
          >
            Load interactive map
          </button>
          <p
            id="capture-location-map-consent-notice"
            style={{ margin: 0, maxWidth: 520, fontSize: 12.5, lineHeight: 1.5, color: "var(--ink-secondary, #475569)" }}
          >
            {PUBLIC_MAP_CONSENT_NOTICE}
          </p>
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
