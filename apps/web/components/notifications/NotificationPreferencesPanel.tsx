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

import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../lib/api";
import { useAuth } from "../../app/providers";
import { resolveEffectiveTimezone } from "../../lib/notifications/effectiveTimezone";
import { useOperationsUiContext } from "../../lib/notifications/useOperationsUiContext";
import {
  buildActualItemSignal,
  preferenceGroupVisible,
  type ActualItemSignal,
  type PreferenceGroupDomain,
} from "../../lib/notifications/operationsFilterPolicy";

type PreferenceType =
  | "MENTION"
  | "ASSIGNED_THREAD"
  | "REVIEWER_ASSIGNMENT"
  | "ESCALATION"
  | "SLA_NEAR_BREACH"
  | "EVIDENCE_REQUEST_UPDATE"
  | "GOVERNANCE_UPDATE";

type Channel = "IN_APP" | "EMAIL";

type Frequency = "IMMEDIATE" | "HOURLY" | "DAILY" | "WEEKLY" | "OFF";

const FREQUENCY_LABEL: Record<Frequency, string> = {
  IMMEDIATE: "Immediate",
  HOURLY: "Hourly digest",
  DAILY: "Daily digest",
  WEEKLY: "Weekly digest",
  OFF: "Off",
};

type PreferenceRow = {
  preferenceType: PreferenceType;
  channel: Channel;
  enabled: boolean;
  frequency?: Frequency;
  updatedAt: string;
};

type Response = {
  teamId: string;
  preferences: ReadonlyArray<PreferenceRow>;
  /** Categories managed by organization policy — rendered locked. */
  lockedTypes?: ReadonlyArray<PreferenceType>;
  emailLockedTypes?: ReadonlyArray<PreferenceType>;
  minimumFrequencyByType?: Record<string, Frequency>;
  organizationId?: string | null;
  canManageOrgPolicy?: boolean;
  isPersonalWorkspace?: boolean;
  catalog: {
    preferenceTypes: ReadonlyArray<PreferenceType>;
    channels: ReadonlyArray<Channel>;
    frequencies?: ReadonlyArray<Frequency>;
    defaults: Record<Channel, boolean> & { frequency?: Frequency };
  };
};

const FREQUENCY_RANK: Record<Frequency, number> = {
  IMMEDIATE: 4,
  HOURLY: 3,
  DAILY: 2,
  WEEKLY: 1,
  OFF: 0,
};

/**
 * PROOVRA preference taxonomy — concise operator-facing groups over the
 * enforced backend types. Organization-only groups are hidden in
 * Personal workspaces (the events still flow with safe defaults; only
 * the configuration clutter is removed).
 */
const PREFERENCE_GROUPS: ReadonlyArray<{
  title: string;
  types: ReadonlyArray<PreferenceType>;
  /** Operational domain — the group renders when the SAME canonical
   * visibility predicate (`preferenceGroupVisible`) that gates the
   * Operations Center filters allows this domain: static eligibility
   * (plan + participation + role/capability) OR a real authorized item
   * in scope. `integrity` is universal (mandatory evidence signals). */
  domain: PreferenceGroupDomain;
}> = [
  {
    title: "Evidence integrity & verification",
    types: ["SLA_NEAR_BREACH"],
    domain: "integrity",
  },
  {
    title: "Reviews & quality",
    types: ["REVIEWER_ASSIGNMENT", "ESCALATION"],
    domain: "review",
  },
  {
    title: "Secure intake",
    types: ["EVIDENCE_REQUEST_UPDATE"],
    domain: "intake",
  },
  {
    title: "Collaboration",
    types: ["MENTION", "ASSIGNED_THREAD"],
    domain: "collaboration",
  },
  {
    title: "Governance & retention",
    types: ["GOVERNANCE_UPDATE"],
    domain: "governance",
  },
];

const TYPE_LABEL: Record<PreferenceType, string> = {
  MENTION: "@-mentions in discussions",
  ASSIGNED_THREAD: "Discussion threads assigned to you",
  REVIEWER_ASSIGNMENT: "Reviewer workflow assignments",
  ESCALATION: "Escalations routed to you",
  // Semantic-honesty rename (2026-07-14): the backend type is still
  // SLA_NEAR_BREACH, but what it actually maps to is the mandatory
  // evidence-integrity failure set (TSA/OTS timestamping, report and
  // verification-package failures) — the label says so.
  SLA_NEAR_BREACH: "Evidence integrity & verification failures",
  EVIDENCE_REQUEST_UPDATE: "Evidence request updates",
  GOVERNANCE_UPDATE: "Governance / destruction updates",
};

/**
 * Per-type lock reasons for IN_APP toggles that the platform (or the
 * organization) keeps always-on. Rendered as the toggle tooltip AND as
 * visible muted text in the locked row so the "why" is never hidden.
 */
const IN_APP_LOCK_REASON: Partial<Record<PreferenceType, string>> = {
  SLA_NEAR_BREACH:
    "Required for evidence integrity — always shown in the app",
  GOVERNANCE_UPDATE:
    "Required governance duty — always shown in the app",
};

function inAppLockReason(type: PreferenceType): string {
  return (
    IN_APP_LOCK_REASON[type] ?? "Managed by your organization — always on."
  );
}

const TYPE_HELP: Record<PreferenceType, string> = {
  MENTION:
    "In-app + topbar surface when a reviewer @-mentions you in a workspace discussion.",
  ASSIGNED_THREAD:
    "In-app + topbar surface when a discussion thread is assigned to you.",
  REVIEWER_ASSIGNMENT:
    "Notified when a reviewer-ops workflow is assigned to you.",
  ESCALATION: "Notified when an escalation is routed to you.",
  SLA_NEAR_BREACH:
    "Evidence-integrity failures on records you can access — failed trusted timestamps (TSA/OTS), and, where your plan includes them, report generation and verification-package failures. Always shown in the app; email delivery is your choice.",
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
  // Canonical UI-context — group relevance only; the backend enforces
  // every preference write regardless of what renders here.
  const uiCtx = useOperationsUiContext();
  // Actual-item override signal — a group also renders when a real,
  // authorized item exists in scope, not only on static eligibility, so a
  // preference is never hidden while genuine incoming items arrive. Sourced
  // from the SAME aggregation scopeSummary the Operations Center uses (one
  // pipeline); a degraded/absent fetch falls back to eligibility-only.
  const [itemSignal, setItemSignal] = useState<ActualItemSignal>(
    buildActualItemSignal(null),
  );

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
      setError(toSafeUserError(e, { message: "Could not load notification preferences." }).message);
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Fetch the aggregation's filter-independent scope summary (byCategory +
  // deadlines) so group visibility applies the identical eligibility-OR-item
  // predicate as the Operations Center filters. Best-effort: a failure
  // leaves the eligibility-only default.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = (await apiFetch("/v1/me/inbox?pageSize=1")) as {
          scopeSummary?: {
            byCategory?: Record<string, number>;
            deadlines?: { dueSoon?: number; overdue?: number };
          };
        };
        if (alive) setItemSignal(buildActualItemSignal(res.scopeSummary));
      } catch {
        /* eligibility-only fallback */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

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
        setError(toSafeUserError(e, { message: "Could not save preference." }).message);
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
        className="ops-panel"
      >
        <strong>Notification preferences</strong>
        <p className="ops-muted" style={{ margin: "2px 0 0" }}>
          Notification preferences are workspace-scoped. Switch to a workspace
          to manage your operational notifications.
        </p>
      </section>
    );
  }

  if (loading || !data) {
    return (
      <section data-notification-preferences-loading className="ops-panel">
        <strong>Notification preferences</strong>
        <p className="ops-muted" style={{ margin: "2px 0 0" }}>Loading…</p>
      </section>
    );
  }

  // Build a lookup keyed by (type|channel) so we can render the
  // bounded catalog even when no row exists for that combination.
  const responseData = data; // narrowing — typechecker sees null is unreachable past the guard above
  const lookup = new Map<string, boolean>();
  const freqLookup = new Map<string, Frequency>();
  for (const p of responseData.preferences) {
    lookup.set(`${p.preferenceType}|${p.channel}`, p.enabled);
    if (p.frequency) freqLookup.set(`${p.preferenceType}|${p.channel}`, p.frequency);
  }
  function isEnabled(type: PreferenceType, channel: Channel): boolean {
    const key = `${type}|${channel}`;
    return lookup.get(key) ?? responseData.catalog.defaults[channel];
  }
  function frequencyFor(type: PreferenceType): Frequency {
    return (
      freqLookup.get(`${type}|EMAIL`) ??
      responseData.catalog.defaults.frequency ??
      "IMMEDIATE"
    );
  }
  const lockedTypes = new Set(responseData.lockedTypes ?? []);
  const emailLockedTypes = new Set(responseData.emailLockedTypes ?? []);
  const minFrequencyByType = responseData.minimumFrequencyByType ?? {};
  // A REAL organization-policy lock exists (beyond the platform's own
  // always-on evidence-integrity/governance in-app locks).
  const hasOrgPolicyLocks =
    emailLockedTypes.size > 0 ||
    Object.keys(minFrequencyByType).length > 0 ||
    [...lockedTypes].some((t) => !(t in IN_APP_LOCK_REASON));
  const frequencies: ReadonlyArray<Frequency> =
    responseData.catalog.frequencies ?? ["IMMEDIATE", "HOURLY", "DAILY", "WEEKLY", "OFF"];

  async function setFrequency(type: PreferenceType, frequency: Frequency) {
    const key = `${type}|EMAIL|freq`;
    setSavingKey(key);
    try {
      await apiFetch("/v1/me/notification-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId,
          preferenceType: type,
          channel: "EMAIL",
          enabled: isEnabled(type, "EMAIL"),
          frequency,
        }),
      });
      void load();
    } catch (err) {
      const e = err as { message?: string };
      setError(toSafeUserError(e, { message: "Could not save frequency." }).message);
      void load();
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <section data-notification-preferences-panel className="ops-panel">
      <header style={{ marginBottom: 12 }}>
        <strong className="ops-panel__title">Notification preferences</strong>
        <p className="ops-muted" style={{ margin: "2px 0 0" }}>
          Operational notifications for this workspace. In-app delivery is enabled by
          default; email is opt-in. Toggling here is audited.
        </p>
      </header>

      <div
        data-notification-preferences-legend
        className="ops-legend"
        style={{ marginBottom: 12 }}
      >
        <p>
          <strong>In-app</strong> — what appears in your bell and Operations
          Center.
        </p>
        <p>
          <strong>Email</strong> — choose immediate delivery or an hourly,
          daily, or weekly digest per category.
        </p>
        <p>
          Critical evidence-integrity alerts always remain enabled in-app.
        </p>
        {/* §8.2 — organization-policy explanation renders ONLY when a real
            organization policy actually locks something here. Personal
            workspaces never see organization-governance terminology. */}
        {!responseData.isPersonalWorkspace && hasOrgPolicyLocks ? (
          <p data-notification-org-policy-legend>
            <strong>&ldquo;Managed by your organization&rdquo;</strong> means
            your organization&rsquo;s policy controls that setting.
          </p>
        ) : null}
      </div>

      {error ? (
        <div role="alert" className="ops-error-box" style={{ marginBottom: 12 }}>
          {error}
        </div>
      ) : null}

      <table data-notification-preferences-table className="ops-table">
        <thead>
          <tr>
            <th>Preference</th>
            {/* §8.4 — channel headers render on ONE line; the narrow
                column must not hyphen-break the label. */}
            <th style={{ textAlign: "center", whiteSpace: "nowrap" }}>In-app</th>
            <th style={{ textAlign: "center", whiteSpace: "nowrap" }}>Email</th>
          </tr>
        </thead>
        <tbody>
          {PREFERENCE_GROUPS.filter((g) =>
            preferenceGroupVisible(g.domain, uiCtx, itemSignal),
          ).flatMap((g) => [
            <tr
              key={`group-${g.title}`}
              data-preference-group={g.title}
              className="ops-table__group-row"
            >
              <td colSpan={3}>{g.title}</td>
            </tr>,
            ...g.types
              .filter((t) => data.catalog.preferenceTypes.includes(t))
              .map((type) => (
            <tr key={type} data-notification-preference-type={type}>
              <td>
                <strong>{TYPE_LABEL[type]}</strong>
                <div className="ops-muted" style={{ marginTop: 2 }}>
                  {TYPE_HELP[type]}
                </div>
                {lockedTypes.has(type) ? (
                  <div
                    data-notification-preference-locked={type}
                    className="ops-muted ops-muted--strong"
                    style={{ marginTop: 4 }}
                  >
                    {inAppLockReason(type)}
                  </div>
                ) : null}
              </td>
              {(["IN_APP", "EMAIL"] as Channel[]).map((channel) => {
                const enabled = isEnabled(type, channel);
                const key = `${type}|${channel}`;
                const busy = savingKey === key;
                const locked =
                  channel === "IN_APP"
                    ? lockedTypes.has(type)
                    : emailLockedTypes.has(type);
                return (
                  <td key={channel} style={{ textAlign: "center" }}>
                    <label
                      data-notification-preference-toggle={`${type}|${channel}`}
                      data-notification-preference-enabled={
                        enabled ? "true" : "false"
                      }
                      className="ops-toggle"
                      data-busy={busy ? "true" : "false"}
                      data-locked={locked ? "true" : "false"}
                      title={
                        locked
                          ? channel === "IN_APP"
                            ? inAppLockReason(type)
                            : "Managed by your organization — email delivery is required."
                          : undefined
                      }
                    >
                      <input
                        type="checkbox"
                        checked={locked ? true : enabled}
                        disabled={busy || locked}
                        aria-label={`${TYPE_LABEL[type]} — ${channel === "IN_APP" ? "in-app" : "email"}`}
                        onChange={(e) =>
                          void toggle(type, channel, e.target.checked)
                        }
                      />
                    </label>
                    {channel === "EMAIL" && (locked ? true : enabled) ? (
                      <div style={{ marginTop: 6 }}>
                        <select
                          data-notification-preference-frequency={type}
                          value={frequencyFor(type)}
                          disabled={savingKey === `${type}|EMAIL|freq`}
                          aria-label={`${TYPE_LABEL[type]} email frequency`}
                          onChange={(e) =>
                            void setFrequency(type, e.target.value as Frequency)
                          }
                          className="ops-select"
                        >
                          {frequencies
                            .filter((f) => !(locked && f === "OFF"))
                            .filter((f) => {
                              // Organization minimum cadence — options
                              // weaker than the policy floor are removed.
                              const min = minFrequencyByType[type];
                              if (!min) return true;
                              return FREQUENCY_RANK[f] >= FREQUENCY_RANK[min];
                            })
                            .map((f) => (
                              <option key={f} value={f}>
                                {FREQUENCY_LABEL[f]}
                              </option>
                            ))}
                        </select>
                      </div>
                    ) : null}
                  </td>
                );
              })}
            </tr>
              )),
          ])}
        </tbody>
      </table>
      {responseData.canManageOrgPolicy && responseData.organizationId ? (
        <div style={{ marginTop: 16 }}>
          <OrgNotificationPolicyManager orgId={responseData.organizationId} />
        </div>
      ) : null}
    </section>
  );
}

type OrgPolicyRow = {
  category: PreferenceType;
  mandatoryInApp: boolean;
  mandatoryEmail: boolean;
  minimumFrequency: Frequency | null;
  quietHoursCriticalOverride: boolean;
  policyVersion: number;
};

/**
 * Organization Notification Policy manager — rendered ONLY when the
 * preferences endpoint reports canManageOrgPolicy (ORG_OWNER/ORG_ADMIN
 * of the workspace's organization; server-enforced on every write).
 * Members and personal workspaces never see this card.
 */
function OrgNotificationPolicyManager({ orgId }: { orgId: string }) {
  const [rows, setRows] = useState<OrgPolicyRow[] | null>(null);
  const [catalog, setCatalog] = useState<ReadonlyArray<PreferenceType>>([]);
  const [error, setError] = useState<string | null>(null);
  const [savingCat, setSavingCat] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = (await apiFetch(
        `/v1/orgs/${encodeURIComponent(orgId)}/notification-policy`,
      )) as { policies: OrgPolicyRow[]; catalog: { categories: ReadonlyArray<PreferenceType> } };
      setRows(res.policies);
      setCatalog(res.catalog.categories);
      setError(null);
    } catch (err) {
      setError(
        toSafeUserError(err as { message?: string }, {
          message: "Could not load the organization notification policy.",
        }).message,
      );
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (next: OrgPolicyRow) => {
      setSavingCat(next.category);
      try {
        await apiFetch(`/v1/orgs/${encodeURIComponent(orgId)}/notification-policy`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            category: next.category,
            mandatoryInApp: next.mandatoryInApp,
            mandatoryEmail: next.mandatoryEmail,
            minimumFrequency: next.minimumFrequency,
            quietHoursCriticalOverride: next.quietHoursCriticalOverride,
          }),
        });
        await load();
      } catch (err) {
        setError(
          toSafeUserError(err as { message?: string }, {
            message: "Could not save the policy.",
          }).message,
        );
      } finally {
        setSavingCat(null);
      }
    },
    [orgId, load],
  );

  if (rows === null && !error) {
    return (
      <section data-org-notification-policy-loading className="ops-panel">
        <strong>Organization notification policy</strong>
        <p className="ops-muted" style={{ margin: "2px 0 0" }} aria-live="polite">Loading…</p>
      </section>
    );
  }

  const rowFor = (cat: PreferenceType): OrgPolicyRow =>
    rows?.find((r) => r.category === cat) ?? {
      category: cat,
      mandatoryInApp: false,
      mandatoryEmail: false,
      minimumFrequency: null,
      quietHoursCriticalOverride: true,
      policyVersion: 0,
    };

  return (
    <section data-org-notification-policy-card className="ops-panel">
      <header style={{ marginBottom: 12 }}>
        <strong className="ops-panel__title">Organization notification policy</strong>
        <p className="ops-muted" style={{ margin: "2px 0 0" }}>
          Enterprise controls for evidence-operations categories. Mandatory
          categories cannot be disabled by members; minimum frequency caps how
          far members may defer email delivery. Every change is audited.
        </p>
      </header>
      {error ? (
        <div role="alert" className="ops-error-box" style={{ marginBottom: 12 }}>
          {error}
        </div>
      ) : null}
      <table className="ops-table">
        <thead>
          <tr>
            <th>Category</th>
            <th style={{ textAlign: "center" }}>Mandatory in-app</th>
            <th style={{ textAlign: "center" }}>Mandatory email</th>
            <th>Minimum frequency</th>
          </tr>
        </thead>
        <tbody>
          {catalog.map((cat) => {
            const row = rowFor(cat);
            const busy = savingCat === cat;
            return (
              <tr key={cat} data-org-policy-category={cat}>
                <td>{TYPE_LABEL[cat]}</td>
                <td style={{ textAlign: "center" }}>
                  <input
                    type="checkbox"
                    checked={row.mandatoryInApp}
                    disabled={busy}
                    aria-label={`${TYPE_LABEL[cat]} mandatory in-app`}
                    onChange={(e) => void save({ ...row, mandatoryInApp: e.target.checked })}
                  />
                </td>
                <td style={{ textAlign: "center" }}>
                  <input
                    type="checkbox"
                    checked={row.mandatoryEmail}
                    disabled={busy}
                    aria-label={`${TYPE_LABEL[cat]} mandatory email`}
                    onChange={(e) => void save({ ...row, mandatoryEmail: e.target.checked })}
                  />
                </td>
                <td>
                  <select
                    value={row.minimumFrequency ?? ""}
                    disabled={busy}
                    aria-label={`${TYPE_LABEL[cat]} minimum frequency`}
                    onChange={(e) =>
                      void save({
                        ...row,
                        minimumFrequency: (e.target.value || null) as Frequency | null,
                      })
                    }
                    className="ops-select"
                  >
                    <option value="">No minimum</option>
                    {(["IMMEDIATE", "HOURLY", "DAILY", "WEEKLY"] as Frequency[]).map((f) => (
                      <option key={f} value={f}>
                        {FREQUENCY_LABEL[f]}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

type ScheduleResponse = {
  schedule: {
    teamId: string;
    /**
     * Explicit per-workspace override, or null = inherit the account
     * timezone (Settings → Preferences) → UTC fallback. The digest
     * scheduler applies exactly this precedence server-side.
     */
    timezone: string | null;
    quietHoursEnabled: boolean;
    quietStartMinute: number;
    quietEndMinute: number;
    quietCriticalOverride: boolean;
    updatedAt: string | null;
  };
};

function minutesToTime(m: number): string {
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map((x) => Number(x));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return Math.min(1439, Math.max(0, h * 60 + m));
}

function supportedTimezones(): string[] {
  try {
    const intlWithValues = Intl as unknown as {
      supportedValuesOf?: (key: string) => string[];
    };
    const values = intlWithValues.supportedValuesOf?.("timeZone");
    if (Array.isArray(values) && values.length > 0) return values;
  } catch {
    /* older runtimes */
  }
  return ["UTC"];
}

/**
 * Quiet hours + timezone card. Backend-driven: reads/writes
 * /v1/me/notification-schedule; the timezone list comes from the
 * runtime's IANA database and the server re-validates it. Digest
 * delivery and quiet-hour suppression are enforced by the digest
 * scheduler server-side — this card only edits the settings.
 */
export function NotificationScheduleCard({ teamId }: { teamId: string | null }) {
  const [schedule, setSchedule] = useState<ScheduleResponse["schedule"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Account timezone — the inherited default (Settings → Preferences).
  const { user } = useAuth();
  const accountTimezone = user?.timezone?.trim() ? user.timezone : null;
  // Environment honesty — true when the backend answers 503
  // `notification_schedule_unavailable` (schedule migration not applied).
  // We never render defaults as if they were saved in that state.
  const [unavailable, setUnavailable] = useState(false);
  const timezones = useMemo(() => supportedTimezones(), []);

  const load = useCallback(async () => {
    if (!teamId) return;
    try {
      const res = (await apiFetch(
        `/v1/me/notification-schedule?teamId=${encodeURIComponent(teamId)}`,
      )) as ScheduleResponse;
      setSchedule(res.schedule);
      setUnavailable(false);
      setError(null);
    } catch (err) {
      const e = err as { message?: string; statusCode?: number; code?: string };
      if (e.statusCode === 503 || e.code === "notification_schedule_unavailable") {
        setUnavailable(true);
        setSchedule(null);
        setError(null);
        return;
      }
      setError(
        toSafeUserError(e, {
          message: "Could not load the notification schedule.",
        }).message,
      );
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (next: ScheduleResponse["schedule"]) => {
      if (!teamId || saving || unavailable) return;
      setSaving(true);
      setSchedule(next); // optimistic; rolled back via reload on failure
      try {
        await apiFetch("/v1/me/notification-schedule", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            teamId,
            timezone: next.timezone,
            quietHoursEnabled: next.quietHoursEnabled,
            quietStartMinute: next.quietStartMinute,
            quietEndMinute: next.quietEndMinute,
            quietCriticalOverride: next.quietCriticalOverride,
          }),
        });
        setError(null);
      } catch (err) {
        setError(
          toSafeUserError(err as { message?: string }, {
            message: "Could not save the notification schedule.",
          }).message,
        );
        void load();
      } finally {
        setSaving(false);
      }
    },
    [teamId, saving, unavailable, load],
  );

  if (!teamId) return null;
  if (unavailable) {
    return (
      <section data-notification-schedule-unavailable className="ops-panel">
        <header style={{ marginBottom: 8 }}>
          <strong className="ops-panel__title">Quiet hours &amp; timezone</strong>
        </header>
        <div className="ops-note">
          Quiet hours and digest scheduling aren&rsquo;t provisioned in this
          environment yet. Your other preferences still work.
        </div>
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            className="ops-retry-btn"
            disabled
            aria-disabled="true"
            title="Scheduling is not provisioned in this environment."
          >
            Save schedule
          </button>
        </div>
      </section>
    );
  }
  if (!schedule) {
    return (
      <section data-notification-schedule-loading className="ops-panel">
        <strong>Quiet hours &amp; timezone</strong>
        <p className="ops-muted" style={{ margin: "2px 0 0" }} aria-live="polite">Loading…</p>
      </section>
    );
  }

  return (
    <section data-notification-schedule-card className="ops-panel">
      <header style={{ marginBottom: 12 }}>
        <strong className="ops-panel__title">Quiet hours &amp; timezone</strong>
        <p className="ops-muted" style={{ margin: "2px 0 0" }}>
          Digest emails respect your quiet hours in your local timezone.
          Critical items may still deliver during quiet hours when the
          override is on.
        </p>
      </header>
      {error ? (
        <div role="alert" className="ops-error-box" style={{ marginBottom: 12 }}>
          {error}
        </div>
      ) : null}
      <div className="ops-form">
        {/* §6.2 — EXPLICIT timezone inheritance. Two states, never a
            silently-diverging second timezone value:
              inherit  → account timezone (or the UTC fallback when unset)
              override → an explicit IANA zone for THIS workspace only. */}
        <fieldset
          data-notification-schedule-timezone-mode
          style={{ border: 0, margin: 0, padding: 0 }}
        >
          <legend className="ops-field-label" style={{ padding: 0 }}>
            Notification timezone
          </legend>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="radio"
              name="notification-timezone-mode"
              checked={schedule.timezone === null}
              disabled={saving}
              onChange={() => void save({ ...schedule, timezone: null })}
              data-notification-schedule-tz-inherit
            />
            <span className="ops-muted">
              Use account timezone —{" "}
              {accountTimezone
                ? accountTimezone
                : "not set, so UTC fallback applies"}
            </span>
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
            <input
              type="radio"
              name="notification-timezone-mode"
              checked={schedule.timezone !== null}
              disabled={saving}
              onChange={() =>
                void save({
                  ...schedule,
                  timezone:
                    schedule.timezone ?? accountTimezone ?? "UTC",
                })
              }
              data-notification-schedule-tz-override
            />
            <span className="ops-muted">Override for this workspace</span>
          </label>
          {schedule.timezone !== null ? (
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
              <span className="ops-field-label">Workspace timezone</span>
              <select
                data-notification-schedule-timezone
                value={schedule.timezone}
                disabled={saving}
                aria-label="Workspace timezone override"
                onChange={(e) => void save({ ...schedule, timezone: e.target.value })}
                className="ops-select"
                style={{ maxWidth: 320 }}
              >
                {!timezones.includes(schedule.timezone) ? (
                  <option value={schedule.timezone}>{schedule.timezone}</option>
                ) : null}
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <p
            className="ops-muted"
            style={{ margin: "6px 0 0" }}
            data-notification-schedule-effective-tz
          >
            Digests and quiet hours use:{" "}
            <strong>
              {resolveEffectiveTimezone(schedule.timezone, accountTimezone)}
            </strong>
          </p>
        </fieldset>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="ops-field-label">Quiet hours</span>
          <input
            type="checkbox"
            data-notification-schedule-quiet-enabled
            checked={schedule.quietHoursEnabled}
            disabled={saving}
            aria-label="Enable quiet hours"
            onChange={(e) =>
              void save({ ...schedule, quietHoursEnabled: e.target.checked })
            }
          />
          <span className="ops-muted">Pause digest delivery during the window below.</span>
        </label>
        {schedule.quietHoursEnabled ? (
          <>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="ops-field-label">From</span>
              <input
                type="time"
                value={minutesToTime(schedule.quietStartMinute)}
                disabled={saving}
                aria-label="Quiet hours start"
                onChange={(e) =>
                  void save({
                    ...schedule,
                    quietStartMinute: timeToMinutes(e.target.value),
                  })
                }
              />
              <span className="ops-field-label" style={{ minWidth: 24 }}>to</span>
              <input
                type="time"
                value={minutesToTime(schedule.quietEndMinute)}
                disabled={saving}
                aria-label="Quiet hours end"
                onChange={(e) =>
                  void save({
                    ...schedule,
                    quietEndMinute: timeToMinutes(e.target.value),
                  })
                }
              />
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="ops-field-label">Critical override</span>
              <input
                type="checkbox"
                checked={schedule.quietCriticalOverride}
                disabled={saving}
                aria-label="Allow critical notifications during quiet hours"
                onChange={(e) =>
                  void save({
                    ...schedule,
                    quietCriticalOverride: e.target.checked,
                  })
                }
              />
              <span className="ops-muted">
                Critical operational items may bypass quiet hours.
              </span>
            </label>
          </>
        ) : null}
      </div>
    </section>
  );
}

// Visual styling lives in notifications.css (`ops-panel`, `ops-muted`,
// `ops-error-box`, `ops-table`, `ops-select`, `ops-toggle`, `ops-form`,
// `ops-field-label`) — token-derived, no literal colors in JSX.
