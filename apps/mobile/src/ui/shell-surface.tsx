/**
 * BRANDED SURFACES — the two artworks the web paints behind its pages, and the
 * card/header surfaces it re-scopes to read over them.
 *
 * APP SHELL (NEW:VIS-SHELL-BG) — `app-shell-bg.png` attached ONCE to
 * `.app-shell-v2` (app-shell-v2.css:71): cover, anchored center-top, fixed
 * while the content scrolls, behind header + content only (the rail carries
 * its own artwork). Over it: cards `rgba(255,255,255,0.92)` (:611) and the
 * header `rgba(255,255,255,0.18)` with no separator (:626-631).
 *
 * AUTH (NEW:VIS-AUTH-HERO) — `register-logo...png` full-bleed, object-cover
 * centred, under a warm horizontal readability wash (login/page.tsx:676-686;
 * register, reset-password and verify-email use the same). The card is glass:
 * `rgba(255,255,255,0.74)`, border `rgba(255,255,255,0.45)`, radius 28,
 * `0 28px 80px rgba(59,28,74,0.22)` (login/page.tsx:759-764).
 *
 * Both assets under assets/brand/ are byte-identical to the web's and were
 * shipped but never required. `useSurfaceKind()` tells a card or the header
 * which surface it sits on; outside both it keeps the opaque tokens.
 */
import React, { createContext, useContext, useState } from "react";
import { Image, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

import APP_SHELL_BG from "../../assets/brand/app-shell-bg.png";
import AUTH_HERO from "../../assets/brand/auth-hero.png";

export type SurfaceKind = "shell" | "auth" | null;

export const SHELL_SURFACE = {
  card: "rgba(255, 255, 255, 0.92)",
  header: "rgba(255, 255, 255, 0.18)",
  fallback: "#F8FAFC",
} as const;

export const AUTH_SURFACE = {
  card: {
    backgroundColor: "rgba(255, 255, 255, 0.74)",
    borderColor: "rgba(255, 255, 255, 0.45)",
    borderWidth: 1,
    borderRadius: 28,
    shadowColor: "rgb(59, 28, 74)",
    shadowOpacity: 0.22,
    shadowRadius: 40,
    shadowOffset: { width: 0, height: 28 },
    elevation: 12,
  },
  /** linear-gradient(90deg, rgba(255,229,207,.10) 0%, rgba(255,255,255,.02) 45%, rgba(33,22,45,.10) 100%) */
  wash: ["rgba(255, 229, 207, 0.10)", "rgba(255, 255, 255, 0.02)", "rgba(33, 22, 45, 0.10)"] as const,
  washStops: [0, 0.45, 1] as const,
  fallback: "#FFF4EC",
} as const;

const SurfaceContext = createContext<SurfaceKind>(null);

export function useSurfaceKind(): SurfaceKind {
  return useContext(SurfaceContext);
}
/** True inside the shell's artwork area. */
export function useShellSurface(): boolean {
  return useContext(SurfaceContext) === "shell";
}

type Art = { w: number; h: number };
const SHELL_ART: Art = { w: 1672, h: 941 }; // IHDR of app-shell-bg.png
const AUTH_ART: Art = { w: 1688, h: 932 }; // IHDR of auth-hero.png

/**
 * CSS `background-size: cover` for a box of w×h, with the image anchored
 * `center top` (shell) or `center center` (auth, object-cover).
 */
export function coverFit(art: Art, w: number, h: number, anchor: "top" | "center"): { width: number; height: number; left: number; top: number } {
  const scale = Math.max(w / art.w, h / art.h);
  const width = art.w * scale;
  const height = art.h * scale;
  return { width, height, left: (w - width) / 2, top: anchor === "top" ? 0 : (h - height) / 2 };
}
/** Kept for the shell's callers and tests. */
export function coverCenterTop(w: number, h: number) {
  return coverFit(SHELL_ART, w, h, "top");
}

function useBox() {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setBox((b) => (b && b.w === width && b.h === height ? b : { w: width, h: height }));
  };
  return [box, onLayout] as const;
}

export function ShellBackdrop({ children }: { children: React.ReactNode }) {
  const [box, onLayout] = useBox();
  const art = box ? coverFit(SHELL_ART, box.w, box.h, "top") : null;
  return (
    <View style={[styles.root, { backgroundColor: SHELL_SURFACE.fallback }]} onLayout={onLayout} testID="app-shell-backdrop">
      {/* Fixed: it sits under the scroll view, so content scrolls over it. */}
      {art ? (
        <Image source={APP_SHELL_BG} resizeMode="stretch" style={[styles.art, art]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID="app-shell-artwork" />
      ) : null}
      <SurfaceContext.Provider value="shell">{children}</SurfaceContext.Provider>
    </View>
  );
}

export function AuthBackdrop({ children }: { children: React.ReactNode }) {
  const [box, onLayout] = useBox();
  const art = box ? coverFit(AUTH_ART, box.w, box.h, "center") : null;
  return (
    <View style={[styles.root, { backgroundColor: AUTH_SURFACE.fallback }]} onLayout={onLayout} testID="auth-backdrop">
      {art ? (
        <Image source={AUTH_HERO} resizeMode="stretch" style={[styles.art, art]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID="auth-artwork" />
      ) : null}
      <LinearGradient
        colors={AUTH_SURFACE.wash as unknown as [string, string, string]}
        locations={AUTH_SURFACE.washStops as unknown as [number, number, number]}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <SurfaceContext.Provider value="auth">{children}</SurfaceContext.Provider>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, overflow: "hidden" },
  art: { position: "absolute" },
});
