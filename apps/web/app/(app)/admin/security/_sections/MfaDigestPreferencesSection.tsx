"use client";

/**
 * PHASE 12B — Recovery-digest notification preferences. Product surface for
 *
 *   GET   /v1/identity/mfa-admin/digest-preferences
 *   PATCH /v1/identity/mfa-admin/digest-preferences
 *   GET   /v1/identity/mfa-admin/digest-preferences/preview
 *   POST  /v1/identity/mfa-admin/digest-preferences/preview/send-test
 *
 * The send-test endpoint (the worklist item) had no consumer, so an admin
 * could not confirm that the recovery digest actually reaches them.
 *
 * These four endpoints are ACTOR-scoped, not workspace-scoped: they read and
 * write the SIGNED-IN operator's own notification preferences and can only
 * ever email that operator's own address. There is therefore no teamId to
 * declare and no subject to choose — the server derives both. The optional
 * per-workspace preference row is keyed by the active workspace from
 * `lib/platform-context`, never by a typed id.
 *
 * Suppressing the digest affects EMAIL ONLY. Audit logs and security events
 * are never suppressed, and the copy says so.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { notifyApiError } from "../../../../../lib/feedback/notify";
import { useTeamId, useTenantGuard } from "../../../../../lib/platform-context";
import { useToast } from "../../../../../components/ui";
import { Badge } from "../../../../../components/ui/Badge";
import { Button } from "../../../../../components/ui/Button";
import { Card } from "../../../../../components/ui/Card";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import { PageSection } from "../../../../../components/ui/PageShell";
import { formatUserDateTime } from "../../../../../lib/date";
import {
  SectionDenied,
  SectionDescription,
  SectionError,
  SectionLoading,
  classifyError,
  sectionMuted,
  type SectionState,
} from "./section-state";

type DigestPreference = {
  id: string;
  teamId: string | null;
  digestEnabled: boolean;
  suppressUntil: string | null;
};

type DigestPreview = {
  adminUserId: string;
  teamCount: number;
  requestCount: number;
  suppressedTeamCount: number;
};

type DigestState = {
  preferences: DigestPreference[];
  preview: DigestPreview | null;
};

const SNOOZE_DAYS = 15;

export function MfaDigestPreferencesSection() {
  const teamId = useTeamId();
  const { stamp, isStale } = useTenantGuard();
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const [state, setState] = useState<SectionState<DigestState>>({ kind: "loading" });
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const captured = stamp();
    try {
      const [prefs, preview] = await Promise.all([
        apiFetch("/v1/identity/mfa-admin/digest-preferences", { method: "GET" }),
        apiFetch("/v1/identity/mfa-admin/digest-preferences/preview", {
          method: "GET",
        }).catch(() => null),
      ]);
      if (isStale(captured)) return;
      setState({
        kind: "ready",
        data: {
          preferences:
            ((prefs as { preferences?: DigestPreference[] })?.preferences ??
              []) as DigestPreference[],
          preview:
            ((preview as { preview?: DigestPreview } | null)?.preview ??
              null) as DigestPreview | null,
        },
      });
    } catch (err) {
      if (isStale(captured)) return;
      setState(
        classifyError<DigestState>(
          err,
          "We couldn't load your recovery-digest preferences.",
        ),
      );
    }
  }, [stamp, isStale]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback(
    async (
      key: string,
      body: Record<string, unknown>,
      successMessage: string,
      failureMessage: string,
    ) => {
      const captured = stamp();
      setBusy(key);
      try {
        await apiFetch("/v1/identity/mfa-admin/digest-preferences", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (isStale(captured)) return;
        addToast(successMessage, "success");
        await load();
      } catch (err) {
        if (isStale(captured)) return;
        notifyApiError(addToast, err, { message: failureMessage });
      } finally {
        setBusy(null);
      }
    },
    [stamp, isStale, addToast, load],
  );

  const sendTest = useCallback(async () => {
    const ok = await confirm({
      title: "Send a test digest to your own address?",
      description:
        "We email the digest you would receive on the next scheduled run to your own account address. It is subject-prefixed [TEST] and does not affect the real digest. You can send at most 3 tests a day.",
      confirmLabel: "Send test digest",
      testId: "mfa-digest-send-test",
    });
    if (!ok) return;
    const captured = stamp();
    setBusy("send-test");
    try {
      await apiFetch("/v1/identity/mfa-admin/digest-preferences/preview/send-test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (isStale(captured)) return;
      addToast("Test digest sent to your account address.", "success");
      await load();
    } catch (err) {
      if (isStale(captured)) return;
      notifyApiError(addToast, err, {
        message: "We couldn't send the test digest.",
      });
    } finally {
      setBusy(null);
    }
  }, [confirm, stamp, isStale, addToast, load]);

  const description = (
    <SectionDescription text="Your own notification settings for the lost-factor recovery digest. Snoozing or turning the digest off suppresses EMAIL only — security events and audit records are never suppressed. Test sends always go to your own account address and never to anyone else." />
  );

  if (state.kind === "loading") {
    return (
      <PageSection title="Recovery digest notifications" description={description}>
        <SectionLoading label="Reading your digest preferences…" />
      </PageSection>
    );
  }
  if (state.kind === "denied") {
    return (
      <PageSection title="Recovery digest notifications" description={description}>
        <SectionDenied
          message={state.message}
          hint="The recovery digest is only offered to owners and admins of at least one workspace."
        />
      </PageSection>
    );
  }
  if (state.kind === "error") {
    return (
      <PageSection title="Recovery digest notifications" description={description}>
        <SectionError message={state.message} onRetry={() => void load()} />
      </PageSection>
    );
  }

  const { preferences, preview } = state.data;
  const globalPref = preferences.find((p) => p.teamId === null) ?? null;
  const workspacePref = teamId
    ? (preferences.find((p) => p.teamId === teamId) ?? null)
    : null;

  const renderPref = (
    label: string,
    hint: string,
    pref: DigestPreference | null,
    scopeTeamId: string | null,
    keyPrefix: string,
  ) => {
    const enabled = pref?.digestEnabled ?? true;
    const suppressedUntil = pref?.suppressUntil ?? null;
    const suppressedNow =
      suppressedUntil !== null && new Date(suppressedUntil).getTime() > Date.now();
    return (
      <Card padding="comfortable" key={keyPrefix}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
        <div style={{ ...sectionMuted, marginTop: 2 }}>{hint}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          <Badge tone={enabled ? "verified" : "neutral"}>
            {enabled ? "Digest on" : "Digest off"}
          </Badge>
          {suppressedNow ? (
            <Badge tone="pending">
              Snoozed until {formatUserDateTime(suppressedUntil as string)}
            </Badge>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          <Button
            variant="secondary"
            size="sm"
            loading={busy === `${keyPrefix}-toggle`}
            disabled={busy !== null}
            onClick={() =>
              void patch(
                `${keyPrefix}-toggle`,
                { teamId: scopeTeamId, digestEnabled: !enabled },
                enabled ? "Digest turned off." : "Digest turned on.",
                "We couldn't change the digest setting.",
              )
            }
          >
            {enabled ? "Turn digest off" : "Turn digest on"}
          </Button>
          {suppressedNow ? (
            <Button
              variant="secondary"
              size="sm"
              loading={busy === `${keyPrefix}-resume`}
              disabled={busy !== null}
              onClick={() =>
                void patch(
                  `${keyPrefix}-resume`,
                  { teamId: scopeTeamId, suppressUntil: null },
                  "Digest resumed.",
                  "We couldn't resume the digest.",
                )
              }
            >
              Resume now
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              loading={busy === `${keyPrefix}-snooze`}
              disabled={busy !== null}
              onClick={() =>
                void patch(
                  `${keyPrefix}-snooze`,
                  {
                    teamId: scopeTeamId,
                    suppressUntil: new Date(
                      Date.now() + SNOOZE_DAYS * 24 * 60 * 60 * 1000,
                    ).toISOString(),
                  },
                  `Digest snoozed for ${SNOOZE_DAYS} days.`,
                  "We couldn't snooze the digest.",
                )
              }
            >
              Snooze {SNOOZE_DAYS} days
            </Button>
          )}
        </div>
      </Card>
    );
  };

  return (
    <PageSection
      title="Recovery digest notifications"
      description={description}
      data-mfa-digest-section
      action={
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
          <Button
            variant="primary"
            loading={busy === "send-test"}
            disabled={busy !== null}
            onClick={() => void sendTest()}
            data-mfa-digest-send-test
          >
            Send test digest
          </Button>
        </div>
      }
      >
      {preview ? (
        <Card padding="compact" style={{ marginBottom: 12 }}>
          <p style={{ margin: 0, fontSize: 13 }}>
            Your next digest would cover <strong>{preview.requestCount}</strong> pending
            recovery request{preview.requestCount === 1 ? "" : "s"} across{" "}
            <strong>{preview.teamCount}</strong> workspace
            {preview.teamCount === 1 ? "" : "s"}
            {preview.suppressedTeamCount > 0
              ? `, with ${preview.suppressedTeamCount} suppressed by your own settings`
              : ""}
            .
          </p>
        </Card>
      ) : (
        <EmptyState variant="inline"
          title="No digest preview available"
          purpose="The server could not build a digest preview for your account right now. Your preferences below are still accurate."
          style={{ marginBottom: 12 }}
        />
      )}

      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
        }}
      >
        {renderPref(
          "All workspaces",
          "Applies wherever you do not have a workspace-specific setting.",
          globalPref,
          null,
          "digest-global",
        )}
        {teamId
          ? renderPref(
              "This workspace only",
              "Overrides the all-workspaces setting for the workspace you are currently in.",
              workspacePref,
              teamId,
              "digest-workspace",
            )
          : null}
      </div>
    </PageSection>
  );
}

export default MfaDigestPreferencesSection;
