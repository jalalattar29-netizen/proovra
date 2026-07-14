"use client";

/**
 * Settings → Notification preferences (System 3).
 *
 * User-facing preference surface for the per-workspace, per-category,
 * per-channel notification preference model (GET/PUT
 * /v1/me/notification-preferences). Distinct by design from the
 * Operations Center (/inbox — where operational items are worked) and
 * from the admin-only outbound delivery log (/notifications).
 *
 * Every toggle rendered here is backend-driven: the panel reads the
 * preference-type catalog from the API response, so the UI can never
 * invent a category the server does not enforce.
 */

import { useActiveWorkspaceId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader } from "../../../../components/ui";
import {
  NotificationPreferencesPanel,
  NotificationScheduleCard,
} from "../../../../components/notifications/NotificationPreferencesPanel";

export default function NotificationSettingsPage() {
  return (
    <PageRouteGate routeId="account.notification_settings">
      <NotificationSettingsPageInner />
    </PageRouteGate>
  );
}

function NotificationSettingsPageInner() {
  const teamId = useActiveWorkspaceId();
  return (
    <PageShell>
      <PageHeader
        title="Notification preferences"
        subtitle="Choose which operational categories reach you in-app and by email for the current workspace. Changes apply immediately and are recorded in the security audit trail."
      />
      {!teamId ? (
        <p style={{ opacity: 0.65, fontSize: 14 }}>
          Select a workspace to manage its notification preferences.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          <NotificationPreferencesPanel teamId={teamId} />
          <NotificationScheduleCard teamId={teamId} />
        </div>
      )}
    </PageShell>
  );
}
