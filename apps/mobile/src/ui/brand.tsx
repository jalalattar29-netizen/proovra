/**
 * CANONICAL AUTH BRAND HEADER (Native Convergence §7, H4). One shared branded
 * header for every auth screen — the canonical PROOVRA mark + wordmark + an
 * optional tagline — so the first-run visual identity is coherent and defined in
 * ONE place, not re-styled per screen. Centered, RTL-safe (ProovraText handles
 * direction), and clamped by ProovraScreen width="form" on tablet.
 *
 * Imported directly by auth screens (NOT re-exported from ./index) to keep a
 * one-way ui/brand → ui/index dependency with no import cycle.
 */
import React from "react";
import { Image, View, StyleSheet } from "react-native";
import { ProovraText } from "./index";
import { theme } from "../theme/theme";

// The canonical mark, derived from apps/web/.../proovra-mark.png (branding guard).
import MARK from "../../assets/brand-mark.png";

export function AuthBrandHeader({ tagline }: { tagline?: string }) {
  return (
    <View style={styles.wrap}>
      <Image
        source={MARK}
        style={styles.mark}
        resizeMode="contain"
        accessible
        accessibilityRole="image"
        accessibilityLabel="PROOVRA"
      />
      <ProovraText variant="h1" weight="bold" center style={styles.word}>
        PROOVRA
      </ProovraText>
      {tagline ? (
        <ProovraText variant="bodySm" color={theme.color.ink.secondary} center style={styles.tag}>
          {tagline}
        </ProovraText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", marginTop: theme.space.s8, marginBottom: theme.space.s6 },
  mark: { width: 72, height: 81, marginBottom: theme.space.s3 },
  word: { letterSpacing: 2 },
  tag: { marginTop: theme.space.s2 },
});
