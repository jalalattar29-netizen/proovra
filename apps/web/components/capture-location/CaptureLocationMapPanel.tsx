"use client";

import { useEffect, useMemo, useState } from "react";
import {
  buildCaptureLocationDisplayModel,
  buildCaptureLocationMapDataUrl,
} from "@proovra/shared";

type CaptureLocationMapPanelProps = {
  lat: number;
  lng: number;
  accuracyMeters?: number | null;
  addToast?: (message: string, type: "success" | "info" | "error" | "warning") => void;
  height?: number;
  rounded?: number;
  /**
   * Optional source-label override. When omitted, the panel renders
   * the historical "Browser/device-reported geolocation" label baked
   * into the shared display model — so the Capture flow keeps the
   * exact bytes it always had. The Intake Link surface passes the
   * mapped label for the row's `locationSource` (e.g. "Contributor
   * browser location") so reports/verify don't overclaim Capture
   * provenance for contributor-uploaded coordinates.
   */
  sourceLabel?: string | null;
};

export default function CaptureLocationMapPanel(
  props: CaptureLocationMapPanelProps
) {
  const display = useMemo(
    () =>
      buildCaptureLocationDisplayModel({
        lat: props.lat,
        lng: props.lng,
        accuracyMeters: props.accuracyMeters ?? null,
        width: 1200,
        height: 720,
      }),
    [props.accuracyMeters, props.lat, props.lng]
  );

  const fallbackDataUrl = useMemo(
    () =>
      buildCaptureLocationMapDataUrl({
        lat: props.lat,
        lng: props.lng,
        accuracyMeters: props.accuracyMeters ?? null,
        width: 1200,
        height: 720,
      }),
    [props.accuracyMeters, props.lat, props.lng]
  );

  const [useFallback, setUseFallback] = useState(false);

  useEffect(() => {
    setUseFallback(false);
  }, [props.accuracyMeters, props.lat, props.lng]);

  if (!display) return null;

  const rounded = props.rounded ?? 22;
  const markerPercentX = (display.markerX / display.width) * 100;
  const markerPercentY = (display.markerY / display.height) * 100;
  const accuracyWidthPercent = Math.min(
    72,
    Math.max(10, (display.accuracyRadiusPx * 2 * 100) / display.width)
  );
  const accuracyHeightPercent = Math.min(
    72,
    Math.max(10, (display.accuracyRadiusPx * 2 * 100) / display.height)
  );

  const handleCopyCoordinates = async () => {
    try {
      await navigator.clipboard.writeText(
        `${display.latLabel}, ${display.lngLabel}`
      );
      props.addToast?.("Coordinates copied", "success");
    } catch {
      props.addToast?.("Could not copy coordinates", "warning");
    }
  };

  return (
    <div
      style={{
        position: "relative",
        minHeight: props.height ?? 280,
        borderRadius: rounded,
        overflow: "hidden",
        border: "1px solid rgba(182, 192, 196, 0.18)",
        background:
          "linear-gradient(180deg, rgba(14,22,26,0.98) 0%, rgba(33,42,47,0.98) 100%)",
        boxShadow:
          "0 22px 46px rgba(0,0,0,0.14), inset 0 1px 0 rgba(255,255,255,0.06)",
      }}
    >
      {useFallback ? (
        <img
          src={fallbackDataUrl}
          alt="Capture context map preview"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
        />
      ) : (
        <div
          style={{
            position: "absolute",
            inset: 0,
            overflow: "hidden",
            background:
              "linear-gradient(180deg, rgba(11,17,20,0.96) 0%, rgba(34,43,48,0.94) 100%)",
          }}
        >
          {display.tiles.map((tile) =>
            tile.url ? (
              <img
                key={tile.key}
                src={tile.url}
                alt=""
                onError={() => setUseFallback(true)}
                style={{
                  position: "absolute",
                  left: `${(tile.left / display.width) * 100}%`,
                  top: `${(tile.top / display.height) * 100}%`,
                  width: `${(tile.width / display.width) * 100}%`,
                  height: `${(tile.height / display.height) * 100}%`,
                  objectFit: "cover",
                  filter:
                    "grayscale(1) saturate(0.42) brightness(0.92) contrast(1.04)",
                }}
              />
            ) : null
          )}

          <div
            style={{
              position: "absolute",
              inset: 0,
              background:
                "radial-gradient(circle at 14% 10%, rgba(255,255,255,0.16), transparent 22%), linear-gradient(180deg, rgba(7,12,14,0.16) 0%, rgba(7,12,14,0.06) 36%, rgba(7,12,14,0.42) 100%)",
            }}
          />

          <div
            style={{
              position: "absolute",
              left: `${markerPercentX}%`,
              top: `${markerPercentY}%`,
              width: `${accuracyWidthPercent}%`,
              height: `${accuracyHeightPercent}%`,
              transform: "translate(-50%, -50%)",
              borderRadius: "50%",
              background: "rgba(103, 199, 190, 0.14)",
              border: "2px solid rgba(103, 199, 190, 0.34)",
              boxShadow: "0 0 0 1px rgba(255,255,255,0.04) inset",
              zIndex: 2,
            }}
          />

          <div
            style={{
              position: "absolute",
              left: `calc(${markerPercentX}% - 28px)`,
              top: `calc(${markerPercentY}% - 1px)`,
              width: 56,
              height: 2,
              background: "rgba(235,241,243,0.72)",
              zIndex: 3,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: `calc(${markerPercentX}% - 1px)`,
              top: `calc(${markerPercentY}% - 28px)`,
              width: 2,
              height: 56,
              background: "rgba(235,241,243,0.72)",
              zIndex: 3,
            }}
          />

          <div
            style={{
              position: "absolute",
              left: `${markerPercentX}%`,
              top: `${markerPercentY}%`,
              width: 20,
              height: 20,
              transform: "translate(-50%, -50%)",
              borderRadius: "50%",
              background: "#0b2e27",
              border: "3px solid #ffffff",
              boxShadow: "0 10px 22px rgba(0,0,0,0.26)",
              zIndex: 4,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: `${markerPercentX}%`,
              top: `${markerPercentY}%`,
              width: 0,
              height: 0,
              transform: "translate(-50%, 12px)",
              borderLeft: "7px solid transparent",
              borderRight: "7px solid transparent",
              borderTop: "16px solid #0b2e27",
              filter: "drop-shadow(0 6px 10px rgba(0,0,0,0.22))",
              zIndex: 4,
            }}
          />
        </div>
      )}

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "16px 16px 14px",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "flex-start",
            pointerEvents: "auto",
          }}
        >
          <div>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 800,
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                color: "rgba(240,245,246,0.78)",
              }}
            >
              Capture Context
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 15,
                fontWeight: 700,
                color: "#f0f4f5",
                letterSpacing: "-0.01em",
              }}
            >
              {display.locationLineLabel}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "flex-end",
              gap: 8,
            }}
          >
            {/*
              CANONICAL ACTIONS, ON A MAP.

              These were the last two controls still wearing the old language:
              dark translucent pills (`rgba(14,22,26,0.56)` and a teal
              `rgba(15,42,36,0.78)`), 800-weight uppercase at 11px with 0.08em
              tracking, behind a backdrop blur. Nothing else in the product
              shouts like that any more.

              They sit over map tiles, so they cannot be transparent the way a
              secondary action elsewhere can — an opaque surface and one soft
              shadow are what keep them readable over both a pale street map
              and dark satellite imagery. That is the only reason a shadow
              appears here at all.

              Hierarchy: copying is the quieter of the two, so it is a neutral
              surface with navy text; opening the map leaves the product, and
              takes the canonical action accent.
            */}
            <button
              type="button"
              onClick={handleCopyCoordinates}
              data-map-action="copy-coordinates"
              style={{
                borderRadius: 8,
                border: "1px solid var(--border, #e2e8f0)",
                background: "var(--card, #ffffff)",
                color: "var(--ink-primary, #0f172a)",
                fontSize: 12.5,
                fontWeight: 600,
                padding: "7px 12px",
                cursor: "pointer",
                boxShadow: "0 1px 3px rgba(15,23,42,0.18)",
              }}
            >
              Copy coordinates
            </button>

            <a
              href={display.externalMapUrl}
              target="_blank"
              rel="noreferrer"
              data-map-action="open-in-map"
              style={{
                borderRadius: 8,
                border: "1px solid var(--accent-600, #6d28d9)",
                background: "var(--card, #ffffff)",
                color: "var(--accent-600, #6d28d9)",
                fontSize: 12.5,
                fontWeight: 600,
                padding: "7px 12px",
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                boxShadow: "0 1px 3px rgba(15,23,42,0.18)",
              }}
            >
              Open in map
            </a>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gap: 8,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              alignItems: "end",
              flexWrap: "wrap",
            }}
          >
            <div
              style={{
                fontSize: 18,
                fontWeight: 650,
                color: "#eef3f4",
                letterSpacing: "-0.01em",
              }}
            >
              {display.accuracyLabel}
            </div>
            <div
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: "rgba(228, 235, 237, 0.76)",
              }}
              data-capture-location-source-label="true"
            >
              {props.sourceLabel ?? display.sourceLabel}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <div
              style={{
                fontSize: 11.5,
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "rgba(205, 214, 217, 0.68)",
              }}
            >
              Proovra
            </div>
            <div
              style={{
                fontSize: 11,
                color: "rgba(205, 214, 217, 0.68)",
              }}
            >
              {display.attributionLabel}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
