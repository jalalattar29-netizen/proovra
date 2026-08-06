"use client";

/**
 * Notifications section (Settings IA refactor 2026-07-17) — former
 * `/settings/notifications` page body. The notification matrix, quiet
 * hours, and digest cadence are the SAME backend-driven components
 * (per-workspace, per-category, per-channel model); behavior unchanged.
 */

import { useActiveWorkspaceId } from "../../../../lib/platform-context";
import {
  NotificationPreferencesPanel,
  NotificationScheduleCard,
} from "../../../../components/notifications/NotificationPreferencesPanel";
// PHASE 12B (Evidence Operations) — messaging (SMS/WhatsApp) contact
// verification + durable communication preference. It belongs in the SAME
// canonical Notifications section as the in-app/email matrix rather than a
// parallel communications settings surface.
import { ContactChannelVerificationCard } from "../../../../components/notifications/ContactChannelVerificationCard";

export function NotificationsSection() {
  const teamId = useActiveWorkspaceId();
  return !teamId ? (
    <p style={{ opacity: 0.65, fontSize: 14, margin: 0 }}>
      Select a workspace to manage its notification preferences.
    </p>
  ) : (
    <div style={{ display: "grid", gap: 16 }}>
      <NotificationPreferencesPanel teamId={teamId} />
      <NotificationScheduleCard teamId={teamId} />
      <ContactChannelVerificationCard teamId={teamId} />
    </div>
  );
}
