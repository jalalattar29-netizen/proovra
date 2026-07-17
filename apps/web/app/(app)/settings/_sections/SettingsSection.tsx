"use client";

/**
 * Settings IA refactor (2026-07-17) — shared section primitives for the
 * SINGLE unified Settings workspace.
 *
 * `SettingsSection` is a flat, bordered SECTION CONTAINER (administration-
 * console density — GitHub/Linear-style), not a floating dashboard card.
 * Each section carries a stable `id` anchor consumed by the internal
 * scrollspy navigation and by `/settings#<id>` deep links (the old child
 * routes redirect here).
 */

export const SETTINGS_SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "security", label: "Security" },
  { id: "preferences", label: "Preferences" },
  { id: "notifications", label: "Notifications" },
  { id: "ai", label: "AI" },
  { id: "privacy", label: "Privacy" },
  { id: "billing", label: "Billing" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: SettingsSectionId;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      data-settings-section={id}
      style={{
        // Anchor offset so the sticky app topbar never hides the heading.
        scrollMarginTop: 88,
        borderTop: "1px solid var(--border-default, rgba(15,23,42,0.09))",
        padding: "22px 0 26px",
      }}
    >
      <h2
        id={`${id}-heading`}
        style={{
          margin: 0,
          fontSize: 16,
          fontWeight: 700,
          letterSpacing: "-0.01em",
          color: "var(--ink-primary, #0f172a)",
        }}
      >
        {title}
      </h2>
      {description ? (
        <p
          style={{
            margin: "4px 0 0",
            fontSize: 13,
            color: "var(--ink-secondary, #475569)",
            maxWidth: 720,
          }}
        >
          {description}
        </p>
      ) : null}
      <div style={{ marginTop: 14 }}>{children}</div>
    </section>
  );
}
