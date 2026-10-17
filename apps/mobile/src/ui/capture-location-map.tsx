/**
 * THE RECORDED-LOCATION PANEL (native) — the same contract as the web's
 * `components/capture-location/CaptureLocationMapPanel.tsx` (2026-10-17):
 *
 *   - an approved tile endpoint (EXPO_PUBLIC_CAPTURE_LOCATION_TILE_URL, through
 *     the ONE shared policy `resolveApprovedTileTemplate` — never a public tile
 *     provider) → a real map: tiles, marker, the recorded accuracy radius,
 *     attribution;
 *   - otherwise, or when tiles fail → a compact "Recorded location" card with
 *     the same facts, stating only that the map PREVIEW is unavailable — never
 *     the old dark panel that looked like a map and carried no geography;
 *   - coordinates out of range → a neutral unavailable state, no outbound link.
 * Coordinates reported by a device are never shown as verified.
 */
import React, { useMemo, useState } from "react";
import { Image, Linking, View } from "react-native";
import {
  CAPTURE_LOCATION_MAP_ATTRIBUTION,
  buildCaptureLocationDisplayModel,
  isValidCaptureCoordinatePair,
  resolveApprovedTileTemplate,
} from "@proovra/shared";

import { theme } from "../theme/theme";
import { ProovraButton, ProovraText } from "./index";

const MODEL_WIDTH = 1200;
const MODEL_HEIGHT = 640;
const CONFIGURED_TILE_TEMPLATE = resolveApprovedTileTemplate(process.env.EXPO_PUBLIC_CAPTURE_LOCATION_TILE_URL).template;
const BOUNDARY =
  "Reported by the capturing device or client: where the device reported itself to be. It does not independently prove where the subject matter was, and the accuracy is recorded metadata, not a guarantee.";

export function CaptureLocationMap({
  lat,
  lng,
  accuracyMeters,
  sourceLabel,
  tileTemplate,
}: {
  lat: number;
  lng: number;
  accuracyMeters: number | null;
  sourceLabel?: string | null;
  /** Test/override seam; defaults to the deployment's approved endpoint. */
  tileTemplate?: string | null;
}) {
  const valid = isValidCaptureCoordinatePair({ lat, lng });
  const accuracy = typeof accuracyMeters === "number" && Number.isFinite(accuracyMeters) && accuracyMeters >= 0 ? accuracyMeters : null;
  const template = tileTemplate === undefined ? CONFIGURED_TILE_TEMPLATE : resolveApprovedTileTemplate(tileTemplate).template;
  const display = useMemo(
    () =>
      valid
        ? buildCaptureLocationDisplayModel({ lat, lng, accuracyMeters: accuracy, width: MODEL_WIDTH, height: MODEL_HEIGHT, tileTemplate: template })
        : null,
    [valid, lat, lng, accuracy, template],
  );
  const [tilesFailed, setTilesFailed] = useState(false);

  const card = {
    gap: theme.space.s2,
    borderWidth: 1,
    borderColor: theme.color.border.subtle,
    borderRadius: theme.radius.card,
    padding: theme.space.s3,
    backgroundColor: theme.color.surface.card,
  } as const;

  if (!valid || !display) {
    return (
      <View style={card} testID="capture-location-map" accessibilityLabel="Recorded location">
        <ProovraText variant="bodySm" weight="semibold">Location unavailable</ProovraText>
        <ProovraText variant="label" color={theme.color.ink.secondary}>
          The recorded coordinates are not valid, so no map or location link is shown.
        </ProovraText>
      </View>
    );
  }

  const showTiles = Boolean(template) && !tilesFailed && display.tiles.some((t) => t.url);
  const pct = (v: number, of: number) => `${(v / of) * 100}%` as const;
  const ringW = accuracy === null ? 0 : Math.min(96, (display.accuracyRadiusPx * 2 * 100) / display.width);
  const ringH = accuracy === null ? 0 : Math.min(96, (display.accuracyRadiusPx * 2 * 100) / display.height);
  const coordinates = `${display.latLabel}, ${display.lngLabel}`;

  return (
    <View style={card} testID="capture-location-map" accessibilityLabel="Recorded location">
      <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
        Recorded location
      </ProovraText>
      <ProovraText variant="bodySm" weight="semibold" selectable>
        {coordinates}
      </ProovraText>
      <ProovraText variant="label" color={theme.color.ink.secondary}>
        {/* The source is stated only when the caller knows it: absent (undefined) is
            omitted, never rendered as "not recorded". */}
        {`${accuracy === null ? "Accuracy not recorded" : `Accuracy ${display.accuracyLabel}`}${sourceLabel === undefined ? "" : ` · ${sourceLabel ?? "Location source not recorded"}`}`}
      </ProovraText>
      {showTiles ? (
        <View
          style={{
            width: "100%",
            aspectRatio: display.width / display.height,
            borderRadius: theme.radius.card,
            overflow: "hidden",
            backgroundColor: theme.color.surface.muted,
          }}
          accessible
          accessibilityRole="image"
          accessibilityLabel={`Map of the recorded location at ${coordinates}`}
          testID="capture-location-map-view"
        >
          {display.tiles.map((tile) =>
            tile.url ? (
              <Image
                key={tile.key}
                source={{ uri: tile.url }}
                onError={() => setTilesFailed(true)}
                style={{
                  position: "absolute",
                  left: pct(tile.left, display.width),
                  top: pct(tile.top, display.height),
                  width: pct(tile.width, display.width),
                  height: pct(tile.height, display.height),
                }}
                resizeMode="cover"
              />
            ) : null,
          )}
          {accuracy !== null ? (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: `${(display.markerX / display.width) * 100 - ringW / 2}%`,
                top: `${(display.markerY / display.height) * 100 - ringH / 2}%`,
                width: `${ringW}%`,
                height: `${ringH}%`,
                borderRadius: 999,
                borderWidth: 2,
                borderColor: theme.color.status.info.fg,
              }}
            />
          ) : null}
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: pct(display.markerX, display.width),
              top: pct(display.markerY, display.height),
              width: 14,
              height: 14,
              marginLeft: -7,
              marginTop: -7,
              borderRadius: 7,
              borderWidth: 2,
              borderColor: theme.color.ink.onAccent,
              backgroundColor: theme.color.status.info.fg,
            }}
          />
        </View>
      ) : (
        <ProovraText variant="label" color={theme.color.ink.muted} testID="capture-location-map-unavailable">
          Map preview unavailable
        </ProovraText>
      )}
      {showTiles ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>
          {CAPTURE_LOCATION_MAP_ATTRIBUTION}
        </ProovraText>
      ) : null}
      <ProovraButton label="Open in map" variant="secondary" fullWidth={false} onPress={() => void Linking.openURL(display.externalMapUrl)} />
      <ProovraText variant="label" color={theme.color.ink.muted}>
        {BOUNDARY}
      </ProovraText>
    </View>
  );
}
