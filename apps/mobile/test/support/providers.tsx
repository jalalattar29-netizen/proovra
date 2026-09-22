/**
 * Provider composition for render tests — the same providers `app/_layout.tsx`
 * mounts, minus the ones that require a device (crash telemetry, deep links).
 *
 * `onToast` captures toast calls so a test can assert on user feedback, which
 * is otherwise invisible to a render tree.
 */
import React from "react";
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
      <NetworkProvider>
        <ToastProvider>{children}</ToastProvider>
      </NetworkProvider>
    </LocaleProvider>
  );
}
