"use client";

import { useCallback, useEffect, useState } from "react";
import { openCookiePreferences } from "../../lib/consent";

export const PRIVACY_LAUNCHER_TEST_ID = "privacy-preferences-launcher";

export default function PrivacyPreferencesLauncher() {
  const [mounted, setMounted] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const handleClick = useCallback(() => {
    openCookiePreferences();
  }, []);

  if (!mounted) return null;

  const borderColor = hovered || focused
    ? "rgba(124,90,255,0.65)"
    : "rgba(124,90,255,0.35)";
  const background = hovered ? "#FFFFFF" : "rgba(255,255,255,0.92)";
  const focusRing = focused
    ? "0 0 0 3px rgba(124,90,255,0.35)"
    : "0 6px 18px rgba(15,23,42,0.10), 0 1px 2px rgba(15,23,42,0.06)";

  return (
    <button
      type="button"
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      aria-label="Open privacy preferences"
      title="Privacy preferences"
      data-testid={PRIVACY_LAUNCHER_TEST_ID}
      style={{
        position: "fixed",
        left: 16,
        bottom: 16,
        width: 38,
        height: 38,
        padding: 0,
        margin: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 10,
        background,
        border: `1px solid ${borderColor}`,
        boxShadow: focusRing,
        cursor: "pointer",
        zIndex: 2147483000,
        transition:
          "background 120ms ease, border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease",
        transform: hovered ? "translateY(-1px)" : "translateY(0)",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width={20}
        height={20}
        fill="none"
        stroke="#6B5BFF"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M12 3l7 3v5c0 4.5-3 8.4-7 10-4-1.6-7-5.5-7-10V6l7-3z" />
        <circle cx="12" cy="11" r="1.6" />
        <path d="M12 12.6V16" />
      </svg>
    </button>
  );
}
