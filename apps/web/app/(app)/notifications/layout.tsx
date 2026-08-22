/**
 * ATTENTION ARCHITECTURE PHASE 5 (2026-08-22).
 *
 * The ENTERPRISE-tier surface gate that used to guard this directory is GONE.
 * It guarded the outbound delivery LOG, which was an enterprise admin surface;
 * this directory now holds the PERSONAL NOTIFICATION CENTER, and a person's own
 * notifications are not an enterprise feature. Gating them behind a plan tier
 * would hide someone's own mail from them.
 *
 * The delivery log kept its gate: it moved to
 * `/settings/notifications/deliveries`, which sits under the settings surface
 * and remains capability-gated on SETTINGS_VIEW.
 *
 * Access to what a caller may SEE inside the feed is unchanged and is decided
 * server-side by the aggregation's own authorization, not by this layout.
 */
export default function NotificationsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
