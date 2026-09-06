"use client";

import { useCallback, useEffect, useState } from "react";
import { openCookiePreferences } from "../../lib/consent";

export const PRIVACY_LAUNCHER_TEST_ID = "privacy-preferences-launcher";

/**
 * THE PRIVACY PREFERENCES LAUNCHER.
 *
 * ============================================================================
 * WHY IT IS 44px NOW
 * ============================================================================
 * It was 38×38. That is under every published minimum for an interactive
 * target — 44×44 (WCAG 2.5.5 AAA / Apple) and 48×48 (Android) — and this is
 * the one control on the page that a person with a motor impairment, on a
 * phone, in a hurry, is most likely to be reaching for: it is how they change
 * what is collected about them. A consent control that is hard to hit is a
 * consent control that gets abandoned, and an abandoned consent control leaves
 * the previous answer standing.
 *
 * The box grows to 44; the ICON does not. It stays at 20px, because a bigger
 * shield would make the corner of every page noisier without making the target
 * any easier to hit — the padding is what the finger needs, not the glyph.
 *
 * ============================================================================
 * WHY IT IS `insetInlineStart` AND NOT `left`
 * ============================================================================
 * `left: 16` pins it to the bottom-LEFT in every language. In Arabic the page
 * reads right-to-left, the reading eye finishes on the left, and a control
 * anchored there sits where the text ends rather than where the page begins.
 * The logical property follows the direction; in English it still computes to
 * `left`.
 *
 * ============================================================================
 * WHY THE PURPLE IS A TOKEN
 * ============================================================================
 * Three page-local spellings of the brand accent lived here —
 * `rgba(124,90,255,…)` twice and `#6B5BFF` on the icon — none of which is the
 * canonical `--accent-600`. A fourth purple in a product that has one is how a
 * palette stops being a palette.
 */
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

  const active = hovered || focused;

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
        insetInlineStart: 16,
        bottom: 16,
        width: 44,
        height: 44,
        padding: 0,
        margin: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "var(--radius-md, 10px)",
        background: hovered
          ? "var(--surface-standard, #FFFFFF)"
          : "rgba(255,255,255,0.92)",
        border: `1px solid ${
          active ? "var(--accent-500, #7C3AED)" : "var(--accent-200, #D9C7FB)"
        }`,
        boxShadow: focused
          ? "var(--focus-ring)"
          : "0 6px 18px rgba(15,23,42,0.10), 0 1px 2px rgba(15,23,42,0.06)",
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
        stroke="var(--accent-600, #6D28D9)"
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
