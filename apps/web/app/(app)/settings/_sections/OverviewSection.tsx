"use client";

/**
 * Account Overview section (Settings IA refactor 2026-07-17).
 *
 * The workspace's opening section: WHO you are (identity + the former
 * `/settings/profile` display-name editing, behavior unchanged) and the
 * account facts at a glance — plan, workspace, last sign-in, two-factor
 * status, subscription scope. Values are backend-derived; anything whose
 * full controls live in a section below links to that section's anchor
 * instead of duplicating it.
 */

import { useEffect, useMemo, useState } from "react";

import { useToast, Input } from "../../../../components/ui";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import { apiFetch } from "../../../../lib/api";
import { captureException } from "../../../../lib/sentry";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { formatUserDateTime } from "../../../../lib/date";
import { useAuth } from "../../../providers";
import { usePlatformContext } from "../../../../lib/platform-context";
import type { SettingsUiContext } from "../../../../lib/settings/settingsUiContext";
import type { AccountSecuritySummary } from "../../../../lib/security/useAccountSecuritySummary";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

type UpdatedUser = {
  id: string;
  provider: string;
  displayName?: string | null;
  [k: string]: unknown;
};

function extractUserFromResponse(res: unknown): UpdatedUser | null {
  const obj = asRecord(res);
  if (!obj) return null;
  const directUser = asRecord(obj["user"]);
  if (directUser && typeof directUser["id"] === "string") {
    return directUser as unknown as UpdatedUser;
  }
  const dataObj = asRecord(obj["data"]);
  const nestedUser = dataObj ? asRecord(dataObj["user"]) : null;
  if (nestedUser && typeof nestedUser["id"] === "string") {
    return nestedUser as unknown as UpdatedUser;
  }
  return null;
}

const muted: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "var(--ink-secondary, #475569)",
};

function FactRow({
  label,
  value,
  marker,
}: {
  showFacts?: boolean;
  label: string;
  value: React.ReactNode;
  marker?: string;
}) {
  return (
    <div
      className="flex items-center justify-between gap-4 py-2 text-[13px]"
      style={{ borderBottom: "1px solid var(--border-default, rgba(15,23,42,0.06))" }}
      {...(marker ? { [`data-cc-overview-${marker}`]: "true" } : {})}
    >
      <span style={{ color: "var(--ink-secondary, #475569)" }}>{label}</span>
      <span style={{ color: "var(--ink-primary, #0f172a)", fontWeight: 600, textAlign: "right" }}>
        {value}
      </span>
    </div>
  );
}

/**
 * `showFacts` — the account-facts table (plan / workspace / last sign-in /
 * two-factor / subscription) is now stated by the Overview's own summary
 * cards, so the pane that hosts this component asks for the identity and the
 * editing form without it. Nothing is removed here; the caller chooses whether
 * the table is the right thing on its surface.
 */
export function OverviewSection({
  showFacts = true,
  ui,
  security,
}: {
  showFacts?: boolean;
  ui: SettingsUiContext;
  security: AccountSecuritySummary;
}) {
  const { user, updateUser } = useAuth();
  const platformCtx = usePlatformContext();
  const { addToast } = useToast();

  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDisplayName(user?.displayName ?? "");
  }, [user?.displayName, editing]);

  const dirty = editing && displayName.trim() !== (user?.displayName ?? "").trim();

  // Unsaved-change protection — warn before the tab closes while dirty.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const initials = useMemo(() => {
    const a = (user?.displayName ?? user?.email ?? "?").trim();
    return a ? a[0]?.toUpperCase() : "?";
  }, [user?.displayName, user?.email]);

  const save = async () => {
    const trimmed = displayName.trim();
    if (trimmed.length === 0) {
      setError("Display name cannot be empty.");
      return;
    }
    if (trimmed.length > 120) {
      setError("Display name must be 120 characters or fewer.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await apiFetch("/v1/users/me", {
        method: "PATCH",
        body: JSON.stringify({ displayName: trimmed }),
      });
      const updated = extractUserFromResponse(res);
      if (updated) updateUser(updated);
      try {
        await platformCtx.refresh();
      } catch {
        /* non-fatal — local update already applied */
      }
      addToast("Profile updated", "success");
      setEditing(false);
    } catch (err: unknown) {
      captureException(err, { feature: "web_settings_profile_save" });
      setError(
        toSafeUserError(err, {
          message: "Could not save profile. Please try again.",
        }).message,
      );
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setDisplayName(user?.displayName ?? "");
    setError(null);
    setEditing(false);
  };

  return (
    <div style={{ maxWidth: 720 }} data-cc-overview-section>
      {/* Identity — read-only avatar/initial (avatar upload is not a
          supported flow; no fake edit control) + display-name editing. */}
      <div className="flex items-center gap-4" data-cc-profile-card>
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-[rgba(79,70,229,0.16)] bg-[linear-gradient(180deg,rgba(243,240,255,0.9)_0%,rgba(255,255,255,0.56)_100%)] text-[1.1rem] font-bold text-[#6D28D9]">
          {user?.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt=""
              style={{ width: "100%", height: "100%", borderRadius: "50%", objectFit: "cover" }}
            />
          ) : (
            initials
          )}
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            className="text-[1rem] font-semibold tracking-[-0.02em]"
            style={{ color: "var(--ink-primary, #0f172a)" }}
            data-cc-profile-display-name
          >
            {user?.displayName || user?.email || "—"}
          </div>
          {user?.email ? (
            <div className="text-[13px]" style={{ color: "var(--ink-secondary, #475569)" }}>
              {user.email}
            </div>
          ) : null}
        </div>
        {!editing ? (
          <div style={{ marginLeft: "auto" }}>
            <button
              type="button"
              className="app-secondary-action app-secondary-action--lg"
              onClick={() => setEditing(true)}
              data-cc-profile-edit
            >
              Edit profile
            </button>
          </div>
        ) : null}
      </div>

      {editing ? (
        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="block text-[13px]" style={{ color: "var(--ink-secondary, #475569)" }}>
            Display name — what appears on evidence reviews, reports, and
            invitations.
            <div className="mt-2" style={{ maxWidth: 360 }}>
              <Input
                className="cases-form-input"
                value={displayName}
                onChange={setDisplayName}
                placeholder="Display name"
                maxLength={120}
              />
            </div>
          </label>
          {error ? (
            <div
              role="alert"
              className="mt-3 rounded-lg border px-3 py-2 text-[12px]"
              style={{
                borderColor: "rgba(179,38,30,0.35)",
                background: "rgba(179,38,30,0.06)",
                color: "#8f1d16",
              }}
            >
              {error}
            </div>
          ) : null}
          <div className="mt-3 flex gap-3">
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              loading={busy}
              disabled={busy || !dirty}
              data-cc-profile-save
            >
              Save
            </Button>
            <Button variant="secondary" size="sm" onClick={cancel} disabled={busy} data-cc-profile-cancel>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {showFacts ? (
        <>
        {/* Account facts — plan / workspace / last sign-in / two-factor /
            subscription scope. Full controls live in their sections below. */}
        <div className="mt-5" data-cc-overview-facts>
          <FactRow
            label="Plan"
            value={ui.billing.displayPlan}
            marker="plan"
          />
          <FactRow label="Workspace" value={ui.activeWorkspaceName} marker="workspace" />
          <FactRow
            label="Last sign-in"
            value={
              security.lastLoginAtUtc
                ? formatUserDateTime(security.lastLoginAtUtc)
                : "…"
            }
            marker="last-login"
          />
          <FactRow
            label="Two-factor authentication"
            value={
              security.mfaConfigured === null ? (
                "…"
              ) : (
                <Badge tone={security.mfaConfigured ? "verified" : "neutral"} subtle>
                  {security.mfaConfigured ? "Enabled" : "Not configured"}
                </Badge>
              )
            }
            marker="mfa"
          />
          <FactRow
            label="Subscription"
            value={ui.billing.scopeLabel}
            marker="subscription"
          />
        </div>
        {ui.billing.managedByOrgName ? (
          <p style={{ ...muted, marginTop: 8 }}>
            Billing is managed under {ui.billing.managedByOrgName}. Details are in
            the Billing section below.
          </p>
        ) : null}
        </>
      ) : null}
    </div>
  );
}