"use client";

/**
 * Phase G3.1 — Notification preferences panel.
 *
 * Renders the per-workspace, per-preference-type, per-channel
 * toggles backed by the `WorkspaceNotificationPreference` Prisma
 * model. Operators see all seven preference types (mentions,
 * assigned threads, reviewer assignments, escalations, SLA
 * near-breach, evidence request updates, governance updates) with
 * IN_APP + EMAIL channel toggles.
 *
 * Hard rules:
 *   * Reads + writes are bounded — the catalog is shipped from the
 *     backend so the UI never invents a preference type.
 *   * Defaults from the catalog: IN_APP = enabled, EMAIL = disabled.
 *   * Saves are immediate (toggle on change). The PUT endpoint
 *     emits a `notification_preference_updated` security event so
 *     governance admins can review unusual disable patterns.
 *   * No social/chat notification semantics. Vocabulary contract
 *     enforced by the G3.1 test suite.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";

type PreferenceType =
  | "MENTION"
  | "ASSIGNED_THREAD"
  | "REVIEWER_ASSIGNMENT"
  | "ESCALATION"
  | "SLA_NEAR_BREACH"
  | "EVIDENCE_REQUEST_UPDATE"
  | "GOVERNANCE_UPDATE";

type Channel = "IN_APP" | "EMAIL";

type PreferenceRow = {
  preferenceType: PreferenceType;
  channel: Channel;
  enabled: boolean;
  updatedAt: string;
};

type Response = {
  teamId: string;
  preferences: ReadonlyArray<PreferenceRow>;
  catalog: {
    preferenceTypes: ReadonlyArray<PreferenceType>;
    channels: ReadonlyArray<Channel>;
    defaults: Record<Channel, boolean>;
  };
};

const TYPE_LABEL: Record<PreferenceType, string> = {
  MENTION: "@-mentions in discussions",
  ASSIGNED_THREAD: "Discussion threads assigned to you",
  REVIEWER_ASSIGNMENT: "Reviewer workflow assignments",
  ESCALATION: "Escalations routed to you",
  SLA_NEAR_BREACH: "SLA timers approaching breach",
  EVIDENCE_REQUEST_UPDATE: "Evidence request updates",
  GOVERNANCE_UPDATE: "Governance / destruction updates",
};

const TYPE_HELP: Record<PreferenceType, string> = {
  MENTION:
    "Inbox + topbar surface when a reviewer @-mentions you in a workspace discussion.",
  ASSIGNED_THREAD:
    "Inbox + topbar surface when a discussion thread is assigned to you.",
  REVIEWER_ASSIGNMENT:
    "Notified when a reviewer-ops workflow is assigned to you.",
  ESCALATION: "Notified when an escalation is routed to you.",
  SLA_NEAR_BREACH:
    "Notified when an SLA timer on a workflow you own is approaching its breach window.",
  EVIDENCE_REQUEST_UPDATE:
    "Notified when an evidence request you own has new activity.",
  GOVERNANCE_UPDATE:
    "Notified when a governance event (destruction, retention) affects scope you own.",
};

export function NotificationPreferencesPanel({
  teamId,
}: {
  teamId: string | null;
}) {
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!teamId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Phase O-blockers / D-1 — apiFetch already returns parsed JSON.
      const json = (await apiFetch(
        `/v1/me/notification-preferences?teamId=${encodeURIComponent(teamId)}`,
      )) as Response;
      setData(json);
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Could not load notification preferences.");
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    async (preferenceType: PreferenceType, channel: Channel, next: boolean) => {
      if (!teamId || !data) return;
      const key = `${preferenceType}|${channel}`;
      setSavingKey(key);
      // Optimistic update — the row is upserted server-side.
      const optimistic = {
        ...data,
        preferences: [
          ...data.preferences.filter(
            (p) => !(p.preferenceType === preferenceType && p.channel === channel),
          ),
          {
            preferenceType,
            channel,
            enabled: next,
            updatedAt: new Date().toISOString(),
          },
        ],
      };
      setData(optimistic);
      try {
        await apiFetch("/v1/me/notification-preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            teamId,
            preferenceType,
            channel,
            enabled: next,
          }),
        });
      } catch (err) {
        const e = err as { message?: string };
        setError(e.message ?? "Could not save preference.");
        // Rollback by reloading.
        void load();
      } finally {
        setSavingKey(null);
      }
    },
    [data, load, teamId],
  );

  if (!teamId) {
    return (
      <section
        data-notification-preferences-empty="no-workspace"
        style={panelStyle}
      >
        <strong>Notification preferences</strong>
        <p style={mutedStyle}>
          Notification preferences are workspace-scoped. Switch to a workspace
          to manage your operational notifications.
        </p>
      </section>
    );
  }

  if (loading || !data) {
    return (
      <section data-notification-preferences-loading style={panelStyle}>
        <strong>Notification preferences</strong>
        <p style={mutedStyle}>Loading…</p>
      </section>
    );
  }

  // Build a lookup keyed by (type|channel) so we can render the
  // bounded catalog even when no row exists for that combination.
  const responseData = data; // narrowing — typechecker sees null is unreachable past the guard above
  const lookup = new Map<string, boolean>();
  for (const p of responseData.preferences) {
    lookup.set(`${p.preferenceType}|${p.channel}`, p.enabled);
  }
  function isEnabled(type: PreferenceType, channel: Channel): boolean {
    const key = `${type}|${channel}`;
    return lookup.get(key) ?? responseData.catalog.defaults[channel];
  }

  return (
    <section data-notification-preferences-panel style={panelStyle}>
      <header style={{ marginBottom: 12 }}>
        <strong style={{ fontSize: 14 }}>Notification preferences</strong>
        <p style={mutedStyle}>
          Operational notifications for this workspace. Inbox is enabled by
          default; email is opt-in. Toggling here is audited.
        </p>
      </header>

      {error ? (
        <div role="alert" style={errorStyle}>
          {error}
        </div>
      ) : null}

      <table
        data-notification-preferences-table
        style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
      >
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
            <th style={{ padding: "8px 0", fontWeight: 600 }}>Preference</th>
            <th
              style={{
                padding: "8px 12px",
                fontWeight: 600,
                textAlign: "center",
              }}
            >
              Inbox
            </th>
            <th
              style={{
                padding: "8px 12px",
                fontWeight: 600,
                textAlign: "center",
              }}
            >
              Email
            </th>
          </tr>
        </thead>
        <tbody>
          {data.catalog.preferenceTypes.map((type) => (
            <tr
              key={type}
              data-notification-preference-type={type}
              style={{ borderBottom: "1px solid #f1f5f9" }}
            >
              <td style={{ padding: "10px 0" }}>
                <strong>{TYPE_LABEL[type]}</strong>
                <div style={{ ...mutedStyle, marginTop: 2 }}>
                  {TYPE_HELP[type]}
                </div>
              </td>
              {(["IN_APP", "EMAIL"] as Channel[]).map((channel) => {
                const enabled = isEnabled(type, channel);
                const key = `${type}|${channel}`;
                const busy = savingKey === key;
                return (
                  <td
                    key={channel}
                    style={{ padding: "10px 12px", textAlign: "center" }}
                  >
                    <label
                      data-notification-preference-toggle={`${type}|${channel}`}
                      data-notification-preference-enabled={
                        enabled ? "true" : "false"
                      }
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        cursor: busy ? "wait" : "pointer",
                        opacity: busy ? 0.6 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={enabled}
                        disabled={busy}
                        onChange={(e) =>
                          void toggle(type, channel, e.target.checked)
                        }
                      />
                    </label>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const panelStyle = {
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  background: "#fff",
  padding: "1rem 1.25rem",
} as const;

const mutedStyle = {
  fontSize: 12,
  color: "#64748b",
  margin: "2px 0 0",
} as const;

const errorStyle = {
  marginBottom: 12,
  padding: "8px 12px",
  borderRadius: 6,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  fontSize: 12.5,
} as const;
