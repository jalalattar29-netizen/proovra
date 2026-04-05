"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { trackEvent } from "../lib/analytics";

export default function AnalyticsTracker() {
  const pathname = usePathname();
  const lastTrackedPathRef = useRef<string | null>(null);

  useEffect(() => {
    const currentPath = pathname ?? "/";
    if (lastTrackedPathRef.current === currentPath) return;

    lastTrackedPathRef.current = currentPath;
    void trackEvent("page_view", undefined, { pathname: currentPath });
  }, [pathname]);

  return null;
}