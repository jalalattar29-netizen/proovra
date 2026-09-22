/**
 * Provider composition for render tests — the same providers `app/_layout.tsx`
 * mounts, in the same order, minus the ones that require a device (crash
 * telemetry, deep-link listening).
 *
 * AuthProvider is included because several screens reach it indirectly through
 * usePlatformContext, whose hook throws rather than defaulting — deliberately,
 * so a missing provider cannot ship. A render test has to mount what the app
 * mounts.
 *
 * `onToast` captures toast calls so a test can assert on user feedback, which
 * is otherwise invisible to a render tree.
 */
import React from "react";
import { AuthProvider } from "../../src/auth-context";
import { LocaleProvider } from "../../src/locale-context";
import { NetworkProvider } from "../../src/network/network-context";
import { ToastProvider } from "../../src/toast-context";

export function TestProviders({
  children,
}: {
  children: React.ReactNode;
  onToast?: (t: { message: string; tone: string }) => void;
}) {
  return (
    <LocaleProvider>
      <AuthProvider>
        <NetworkProvider>
          <ToastProvider>{children}</ToastProvider>
        </NetworkProvider>
      </AuthProvider>
    </LocaleProvider>
  );
}
