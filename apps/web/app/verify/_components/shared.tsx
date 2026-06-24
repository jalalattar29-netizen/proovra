"use client";

// Shared primitives for the public Verify landing page sections.
// Lives under app/verify/_components/ so the directory is private to
// the route and excluded from Next.js routing.

import type { ReactNode } from "react";

export const SECTION_BORDER = "#DDE7F3";
export const SECTION_MUTED = "#526176";
export const SECTION_INK = "#07142F";

export function SectionEyebrow({
  children,
  color = "#2563EB",
  variant = "light",
}: {
  children: ReactNode;
  color?: string;
  variant?: "light" | "dark";
}) {
  const isDark = variant === "dark";
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em]"
      style={{
        color: isDark ? "#E2EBF8" : color,
        borderColor: isDark ? "rgba(255,255,255,0.20)" : SECTION_BORDER,
        background: isDark ? "rgba(255,255,255,0.06)" : "#FFFFFF",
      }}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {children}
    </span>
  );
}
