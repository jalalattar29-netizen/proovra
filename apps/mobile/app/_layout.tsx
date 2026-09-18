import { Stack } from "expo-router";
import React from "react";

import { DeepLinkGate } from "../src/DeepLinkGate";
import { ErrorBoundary } from "../src/error-boundary";
import { AuthProvider } from "../src/auth-context";
import { LocaleProvider } from "../src/locale-context";
import { ToastProvider } from "../src/toast-context";
import { appTheme } from "../src/app-theme";

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
  return (
    <ErrorBoundary>
      <LocaleProvider>
        <AuthProvider>
          <ToastProvider>
            <DeepLinkGate />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: appTheme.bg },
              }}
            />
          </ToastProvider>
        </AuthProvider>
      </LocaleProvider>
    </ErrorBoundary>
  );
}
