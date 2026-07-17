"use client";

/**
 * Profile & Identity (2026-07-16 Settings IA remediation).
 *
 * Canonical account-identity page. Default mode is a COMPACT READ-ONLY
 * summary; editing happens only after an explicit "Edit profile" action,
 * with save/cancel and unsaved-change protection.
 *
 * FIELD MODEL (Option 1 — display-name-only, decided from the repo-wide
 * caller audit):
 *   - displayName  KEEP + editable — the ONE product identity consumed by
 *                  evidence reviews, audit report exports, reviewer
 *                  identity, and invitation emails.
 *   - email        KEEP, read-only (verified login identity).
 *   - avatar       KEEP (initial-based; avatarUrl rendered when present).
 *   - provider     KEEP, read-only summary of the login method.
 *   - firstName/lastName  REMOVED from UI — zero consumers (identity reads
 *                  displayName only); they sat permanently blank for OAuth
 *                  accounts. Columns + API compatibility retained.
 *   - bio          REMOVED from UI — zero consumers repo-wide.
 *   - country      REMOVED from UI — zero consumers (analytics uses geo-IP,
 *                  not the profile field).
 *   - timezone     MOVED to /settings/preferences (account timezone is a
 *                  preference consumed by digests/quiet hours, not identity).
 *
 * R1 Part 4 contract (carried from the old /settings form): the
 * PATCH /v1/users/me mutation is paired with a platform-envelope refresh —
 * local AuthContext update first, then the envelope refresh, then the
 * success toast.
 */

import { useEffect, useMemo, useState } from "react";

import { useToast, Input } from "../../../../components/ui";
import { PageShell, PageHeader } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { apiFetch } from "../../../../lib/api";
import { captureException } from "../../../../lib/sentry";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useAuth } from "../../../providers";
import { usePlatformContext } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

// The API returns the full user record (id + provider + profile fields);
// the cast mirrors the long-standing extraction on the old settings form.
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

export default function ProfilePage() {
  return (
    <div data-testid="account-profile-page">
      <PageRouteGate routeId="account.profile">
        <ProfileInner />
      </PageRouteGate>
    </div>
  );
}

function ProfileInner() {
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
      // R1 Part 4 — sync the canonical platform envelope so every surface
      // reading user identity from the envelope reflects the edit
      // immediately (local AuthContext update above comes first).
      try {
        await platformCtx.refresh();
      } catch {
        // Non-fatal: local update already applied; drift resolves on the
        // next provider refresh.
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
    <PageShell
      header={
        <PageHeader
          eyebrow="Account"
          title="Profile & identity"
          subtitle="Your account identity. The display name below is what appears on evidence reviews, reports, and invitations."
        />
      }
    >
      {/* §2 — intentionally compact: avatar/initial (read-only — avatar
          upload is not a supported flow, so no fake edit control), display
          name, email, and the explicit Edit action. Login methods live
          only in /settings/security. */}
      <Card
        variant="admin"
        padding="comfortable"
        data-cc-profile-card
        style={{ maxWidth: 640 }}
      >
        <div className="mb-4 flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full border border-[rgba(79,70,229,0.16)] bg-[linear-gradient(180deg,rgba(243,240,255,0.9)_0%,rgba(255,255,255,0.56)_100%)] text-[1.1rem] font-bold text-[#4F46E5]">
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
          <div>
            <div className="text-[12px]" style={{ color: "var(--ink-secondary, #475569)" }}>
              Account
            </div>
            <div
              className="text-[1.05rem] font-semibold tracking-[-0.02em]"
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
        </div>

        {!editing ? (
          <>
            <div className="grid gap-3">
              <div className="flex items-center justify-between gap-4 border-b border-[rgba(15,23,42,0.06)] pb-3 text-[13px]">
                <span style={{ color: "var(--ink-secondary, #475569)" }}>Display name</span>
                <span style={{ color: "var(--ink-primary, #0f172a)", fontWeight: 600 }}>
                  {user?.displayName || "Not set"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4 text-[13px]">
                <span style={{ color: "var(--ink-secondary, #475569)" }}>Email</span>
                <span style={{ color: "var(--ink-primary, #0f172a)" }}>{user?.email ?? "—"}</span>
              </div>
            </div>
            <div className="mt-5">
              <Button
                variant="secondary"
                onClick={() => setEditing(true)}
                data-cc-profile-edit
              >
                Edit profile
              </Button>
            </div>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="block text-[13px]" style={{ color: "var(--ink-secondary, #475569)" }}>
              Display name
              <div className="mt-2">
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
            <div className="mt-4 flex gap-3">
              <Button
                type="submit"
                variant="secondary"
                loading={busy}
                disabled={busy || !dirty}
                data-cc-profile-save
              >
                Save
              </Button>
              <Button
                variant="secondary"
                onClick={cancel}
                disabled={busy}
                data-cc-profile-cancel
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Card>
    </PageShell>
  );
}
