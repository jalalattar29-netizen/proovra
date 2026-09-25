import { Stack } from "expo-router";
import React from "react";

// Crash telemetry initializes from the REAL entry (this root layout is the one
// ancestor of every route), but ONLY after the user has consented — web treats
// reliability monitoring as the consent-gated analytics category, and native
// now matches (opt-in, changeable in Settings). No-op + never throws otherwise.
import { initTelemetryIfConsented } from "../src/privacy/telemetry-consent";
void initTelemetryIfConsented();

import { DeepLinkGate } from "../src/DeepLinkGate";
import { ErrorBoundary } from "../src/error-boundary";
import { AuthProvider } from "../src/auth-context";
import { LocaleProvider } from "../src/locale-context";
import { NetworkProvider } from "../src/network/network-context";
import { ToastProvider } from "../src/toast-context";
import { theme } from "../src/theme/theme";
import { useAppFonts } from "../src/theme/fonts";

/**
 * F4 — THE root layout and the ONE place the app's React providers mount.
 *
 * The Expo Router root `_layout` is the single ancestor of every route. It
 * therefore MUST be a navigator (Stack/Slot/Tabs) AND the mount point for the
 * global providers, or the very first routed screen (`app/index.tsx`, which
 * calls `useAuth()`) throws "AuthContext missing" on boot and the whole app
 * falls into the ErrorBoundary — which is exactly the regression this replaces.
 *
 * Previously this file was a `Tabs` navigator that listed three lifecycle
 * screens and mounted NONE of the providers, while the real tab set lives in
 * `app/(tabs)/_layout.tsx`. The correct root is a `Stack` that hosts the
 * top-level groups (`index`, `(tabs)`, `(stack)`, `verify`) with the providers
 * wrapped around it. Route groups keep their own layouts; nothing is duplicated.
 *
 * Provider order: ErrorBoundary (outermost — it catches everything below),
 * then LocaleProvider → AuthProvider → ToastProvider (none depends on another
 * at provide time), then the navigator. DeepLinkGate renders inside the router
 * context (it uses `useRouter`) and returns null.
 */
export default function RootLayout() {
  // T-04 / RC-04 — hold first paint until the application faces are registered.
  //
  // Rendering before they load produces a frame in the platform system face
  // that then reflows, which is the "flash of unstyled text" that made the app
  // read as unfinished. `null` here is correct rather than a spinner: the
  // native splash is still up at this point, so the user sees the brand, not a
  // blank screen. A load FAILURE falls through to render anyway — a product in
  // the system face beats a product that will not start — and the error is
  // carried into LocaleProvider so it can be surfaced rather than swallowed.
  const [fontsLoaded, fontError] = useAppFonts();
  if (!fontsLoaded && !fontError) return null;

  return (
    <ErrorBoundary>
      <LocaleProvider fontError={fontError}>
        <NetworkProvider>
        <AuthProvider>
          <ToastProvider>
            <DeepLinkGate />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: theme.color.surface.app },
              }}
            />
          </ToastProvider>
        </AuthProvider>
        </NetworkProvider>
      </LocaleProvider>
    </ErrorBoundary>
  );
}
