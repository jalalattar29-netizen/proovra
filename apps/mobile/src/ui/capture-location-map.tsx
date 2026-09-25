/**
 * CAPTURE LOCATION MAP (T-12 / RC-13) — the native port of
 * `components/capture-location/CaptureLocationMapPanel.tsx`.
 *
 * Built from the SAME `buildCaptureLocationDisplayModel` (@proovra/shared) the
 * web uses, so the tiles, marker, accuracy ring, labels and external map URL
 * are identical. Touch adaptations: "Copy coordinates" becomes selectable
 * coordinate text (this build ships no clipboard module); the web's SVG
 * fallback (react-native cannot render an SVG data URL) becomes the same dark
 * panel with the location line, so a tile failure never blanks the record.
 */
import React, { useMemo, useState } from "react";
import { Image, Linking, View } from "react-native";
import { buildCaptureLocationDisplayModel } from "@proovra/shared";

import { theme } from "../theme/theme";
import { ProovraButton, ProovraText } from "./index";

const MODEL_WIDTH = 1200;
const MODEL_HEIGHT = 720;

export function CaptureLocationMap({
  lat,
  lng,
  accuracyMeters,
}: {
  lat: number;
  lng: number;
  accuracyMeters: number | null;
}) {
  const display = useMemo(
    () => buildCaptureLocationDisplayModel({ lat, lng, accuracyMeters, width: MODEL_WIDTH, height: MODEL_HEIGHT }),
    [lat, lng, accuracyMeters],
  );
  const [tilesFailed, setTilesFailed] = useState(false);
  if (!display) return null;

  const pct = (v: number, of: number) => `${(v / of) * 100}%` as const;
  const ringW = Math.min(72, Math.max(10, (display.accuracyRadiusPx * 2 * 100) / display.width));
  const ringH = Math.min(72, Math.max(10, (display.accuracyRadiusPx * 2 * 100) / display.height));

  return (
    <View style={{ gap: theme.space.s2 }} testID="capture-location-map">
      <View
        style={{
          width: "100%",
          aspectRatio: display.width / display.height,
          borderRadius: theme.radius.card,
          overflow: "hidden",
          backgroundColor: theme.color.ink.primary,
        }}
        accessible
        accessibilityRole="image"
        accessibilityLabel="Capture context map preview"
      >
        {!tilesFailed
          ? display.tiles.map((tile) =>
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
            )
          : null}
        {/* Accuracy ring and marker, positioned as the web positions them. */}
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
            borderColor: "rgba(124, 58, 237, 0.7)",
            backgroundColor: "rgba(124, 58, 237, 0.14)",
          }}
        />
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
            backgroundColor: theme.color.accent.a500,
          }}
        />
        <View style={{ position: "absolute", left: 12, bottom: 10, right: 12 }}>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.onAccent}>
            Capture Context
          </ProovraText>
          <ProovraText variant="label" color="rgba(255,255,255,0.86)">
            {display.locationLineLabel}
          </ProovraText>
        </View>
      </View>
      <ProovraText variant="label" color={theme.color.ink.muted} selectable>
        {`${display.latLabel}, ${display.lngLabel}`}
      </ProovraText>
      <ProovraText variant="label" color={theme.color.ink.muted}>
        {display.attributionLabel}
      </ProovraText>
      <ProovraButton label="Open in map" variant="secondary" fullWidth={false} onPress={() => void Linking.openURL(display.externalMapUrl)} />
    </View>
  );
}
