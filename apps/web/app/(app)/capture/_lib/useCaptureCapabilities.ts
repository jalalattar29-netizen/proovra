"use client";

/**
 * Web client adapter over the canonical capture-capability authority (F7).
 *
 * It reads the ONLY web-specific inputs — User-Agent Client Hints / userAgent
 * and the build-time `NEXT_PUBLIC_EXTENSION_INSTALL_URL` — and delegates every
 * decision to `resolveWebCaptureCapabilities` in `@proovra/shared`. No capability
 * logic lives here; this file only gathers browser signals and env.
 *
 * It resolves to UNKNOWN on the server / first paint (no `navigator`), then
 * re-resolves after mount so the truthful platform/browser state appears once
 * the client is known. This guarantees no install control is ever shown before
 * the browser has been confirmed.
 */

import { useEffect, useState } from "react";
import {
  resolveWebCaptureCapabilities,
  type CaptureCapabilities,
  type WebPlatformSignals,
} from "@proovra/shared";

/** The env value is inlined at build time; a relative/internal string can never install (F7 validates). */
function extensionInstallUrl(): string | null {
  return process.env.NEXT_PUBLIC_EXTENSION_INSTALL_URL ?? null;
}

function readWebSignals(): WebPlatformSignals {
  if (typeof navigator === "undefined") return {};
  const uaData = (navigator as unknown as {
    userAgentData?: { mobile?: boolean; brands?: Array<{ brand: string }> };
  }).userAgentData;
  return {
    userAgent: navigator.userAgent ?? null,
    uaDataMobile: typeof uaData?.mobile === "boolean" ? uaData.mobile : null,
    uaDataBrands: Array.isArray(uaData?.brands) ? uaData!.brands!.map((b) => b.brand) : null,
  };
}

export function useCaptureCapabilities(): CaptureCapabilities {
  // SSR/first-paint: UNKNOWN platform → no actionable capability, no install control.
  const [capabilities, setCapabilities] = useState<CaptureCapabilities>(() =>
    resolveWebCaptureCapabilities({}, extensionInstallUrl()),
  );

  useEffect(() => {
    setCapabilities(resolveWebCaptureCapabilities(readWebSignals(), extensionInstallUrl()));
  }, []);

  return capabilities;
}
