/**
 * WORKSPACE CLOSURE — the native port of
 * `apps/web/app/(app)/teams/[id]/components/WorkspaceClosureCard.tsx`.
 *
 *   GET  /v1/teams/:id/closure                     (OWNER; 403 otherwise → renders nothing)
 *   POST /v1/teams/:id/closure                     { confirmation, stepUp? }
 *   POST /v1/teams/:id/closure/:requestId/cancel
 *   POST /v1/teams/:id/reopen                      (only when the latest request COMPLETED)
 *
 * The phrase, the cooling-off period, the blockers and how many members lose
 * access are all the server's. Each leg announces its outcome in a line that
 * survives the state change it caused (a cancellation flips the card back to
 * its initial branch, and the sentence must outlive that).
 */
import React, { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { formatUserDateTime } from "../lib/date";
import { toSafeUserError } from "../errors/safe-error";
import { theme } from "../theme/theme";
import { withStepUp } from "../product/step-up";
import {
  WORKSPACE_REOPENED_NOTICE,
  buildClosureBody,
  buildWorkspaceReopenPath,
  canReopenWorkspace,
  canRequestClosure,
  closurePhraseMatches,
  closureStatusLabel,
  hasOpenClosure,
  isClosureInFlight,
  parseClosureState,
  parseMembersLosingAccess,
  parseRequestBlockers,
  reopenFailureCopy,
  type ClosureBlocker,
  type ClosureState,
} from "../product/closure";
import { buildWorkspaceClosureCancelPath, buildWorkspaceClosurePath } from "../product/workspace-people";
import { ProovraButton, ProovraCard, ProovraFormField, ProovraInput, ProovraText } from "./index";
import { StepUpSheet, useStepUp } from "./step-up-sheet";

type Loaded = { state: ClosureState; membersLosingAccess: number | null; requestBlockers: ClosureBlocker[] };

function requestFailure(err: unknown): { message: string; reload: boolean } {
  const e = err as { code?: string; body?: { error?: { code?: string; message?: string } } };
  const code = e.body?.error?.code ?? e.code;
  if (code === "closure_blocked") return { message: "Closure is blocked — resolve the listed items and try again.", reload: true };
  if (code === "confirmation_mismatch") {
    return { message: e.body?.error?.message ?? "The confirmation phrase does not match.", reload: false };
  }
  if (code === "closure_request_active") return { message: "A closure request for this workspace is already open.", reload: true };
  return { message: toSafeUserError(err, { message: "Could not request closure." }).message, reload: false };
}

export function WorkspaceClosureCard({ teamId }: { teamId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reopenBusy, setReopenBusy] = useState(false);
  const [reopenNotice, setReopenNotice] = useState<string | null>(null);
  const [reopenError, setReopenError] = useState<string | null>(null);
  const stepUp = useStepUp();

  const reload = useCallback(async () => {
    try {
      const d = await apiFetch(buildWorkspaceClosurePath(teamId));
      setLoaded({ state: parseClosureState(d), membersLosingAccess: parseMembersLosingAccess(d), requestBlockers: parseRequestBlockers(d) });
    } catch {
      // Non-owners get 403 — render nothing rather than a fake control.
      setLoaded(null);
    }
  }, [teamId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onRequestError = useCallback(
    (err: unknown) => {
      const f = requestFailure(err);
      setError(f.message);
      if (f.reload) void reload();
    },
    [reload],
  );

  const requestClosure = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    await stepUp.start(async (proof) => {
      await apiFetch(buildWorkspaceClosurePath(teamId), {
        method: "POST",
        body: JSON.stringify(withStepUp(buildClosureBody(phrase), proof)),
      });
      setShowForm(false);
      setPhrase("");
      setNotice("Closure requested. The cancellation window is now open.");
      await reload();
    }, onRequestError);
    setBusy(false);
  }, [teamId, phrase, stepUp, reload, onRequestError]);

  const cancelClosure = useCallback(
    async (requestId: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await apiFetch(buildWorkspaceClosureCancelPath(teamId, requestId), { method: "POST", body: JSON.stringify({}) });
        setNotice("Closure request cancelled. This workspace stays open.");
        await reload();
      } catch (err) {
        setError(toSafeUserError(err, { message: "Could not cancel the request." }).message);
      } finally {
        setBusy(false);
      }
    },
    [teamId, reload],
  );

  const reopen = useCallback(async () => {
    setReopenBusy(true);
    setReopenError(null);
    setReopenNotice(null);
    try {
      await apiFetch(buildWorkspaceReopenPath(teamId), { method: "POST", body: JSON.stringify({}) });
      setReopenNotice(WORKSPACE_REOPENED_NOTICE);
      await reload();
    } catch (err) {
      setReopenError(reopenFailureCopy(err, toSafeUserError(err).message || null));
      if ((err as { statusCode?: number }).statusCode === 409) void reload();
    } finally {
      setReopenBusy(false);
    }
  }, [teamId, reload]);

  if (!loaded) return null;
  const { state, membersLosingAccess, requestBlockers } = loaded;
  const inFlight = isClosureInFlight(state);
  const status = (state.requestStatus ?? "").toUpperCase();
  const muted = theme.color.ink.muted;

  return (
    <ProovraCard testID="workspace-closure-card">
      <ProovraText variant="h3" weight="semibold">
        Close workspace
      </ProovraText>
      <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
        {`${
          state.coolingOffDays !== null
            ? `Archives access to this workspace after a ${state.coolingOffDays}-day cancellation window. `
            : "Archives access to this workspace after a cancellation window. "
        }${
          membersLosingAccess && membersLosingAccess > 0
            ? `${membersLosingAccess} other member${membersLosingAccess === 1 ? "" : "s"} will lose access. `
            : ""
        }Evidence is never deleted by workspace closure — it stays governed by retention and legal-hold rules.`}
      </ProovraText>

      {notice ? <ProovraText variant="bodySm">{notice}</ProovraText> : null}

      {inFlight ? (
        <View style={{ gap: theme.space.s1 }} testID={`workspace-closure-status-${status}`}>
          <ProovraText variant="bodySm" weight="semibold">
            {`${closureStatusLabel(status)}${
              status === "COOLING_OFF" && state.effectiveAtIso
                ? ` — closes after ${formatUserDateTime(state.effectiveAtIso)} unless cancelled.`
                : ""
            }`}
          </ProovraText>
          {status === "BLOCKED"
            ? requestBlockers.map((b) => (
                <ProovraText key={b.code} variant="label" color={muted}>
                  {`• ${b.message}`}
                </ProovraText>
              ))
            : null}
          {hasOpenClosure(state) && state.requestId ? (
            <ProovraButton
              label="Cancel closure request"
              variant="secondary"
              fullWidth={false}
              loading={busy}
              onPress={() => void cancelClosure(state.requestId as string)}
            />
          ) : null}
        </View>
      ) : (
        <View style={{ gap: theme.space.s1 }}>
          {state.blockers.map((b) => (
            <ProovraText key={b.code} variant="label" color={muted}>
              {`• ${b.count !== null ? `${b.message} (${b.count})` : b.message}`}
            </ProovraText>
          ))}
          {!showForm ? (
            canRequestClosure(state) ? (
              <ProovraButton
                label="Close this workspace…"
                variant="ghost"
                fullWidth={false}
                disabled={busy}
                onPress={() => setShowForm(true)}
              />
            ) : null
          ) : (
            <View style={{ gap: theme.space.s2 }}>
              <ProovraFormField label={state.confirmationPhrase ? `Type ${state.confirmationPhrase} to confirm.` : "Type the confirmation phrase"}>
                <ProovraInput
                  value={phrase}
                  onChangeText={setPhrase}
                  placeholder={state.confirmationPhrase ?? ""}
                  autoCapitalize="none"
                  autoComplete="off"
                  accessibilityLabel="Closure confirmation phrase"
                />
              </ProovraFormField>
              {state.confirmationPhrase ? null : (
                <ProovraText variant="label" color={muted}>
                  The confirmation phrase could not be read. Try again in a moment.
                </ProovraText>
              )}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
                <ProovraButton
                  label="Request closure"
                  variant="danger"
                  fullWidth={false}
                  loading={busy}
                  disabled={!closurePhraseMatches(state, phrase)}
                  onPress={() => void requestClosure()}
                />
                <ProovraButton
                  label="Keep this workspace"
                  variant="ghost"
                  fullWidth={false}
                  disabled={busy}
                  onPress={() => {
                    setShowForm(false);
                    setPhrase("");
                    setError(null);
                  }}
                />
              </View>
            </View>
          )}
        </View>
      )}

      {canReopenWorkspace(state) ? (
        <View
          testID="workspace-reopen"
          style={{ gap: theme.space.s1, borderTopWidth: 1, borderTopColor: theme.color.border.subtle, paddingTop: theme.space.s3 }}
        >
          <ProovraText variant="bodySm" weight="semibold">
            Reopen this workspace
          </ProovraText>
          <ProovraText variant="label" color={muted}>
            Restores your owner access so you can work in it again. Other members, API credentials and webhooks are NOT
            restored — re-invite people and re-issue credentials deliberately.
          </ProovraText>
          <ProovraButton label="Reopen workspace" variant="secondary" fullWidth={false} loading={reopenBusy} onPress={() => void reopen()} />
          {reopenBusy || reopenError || reopenNotice ? (
            <ProovraText variant="label" color={reopenError ? theme.color.status.risk.fg : muted}>
              {reopenBusy ? "Reopening…" : reopenError ?? reopenNotice}
            </ProovraText>
          ) : null}
        </View>
      ) : null}

      {error ? (
        <ProovraText variant="label" color={theme.color.status.risk.fg}>
          {error}
        </ProovraText>
      ) : null}

      <StepUpSheet
        challenge={stepUp.challenge}
        title="Confirm closing this workspace."
        busy={busy}
        onSubmit={(proof) => {
          setBusy(true);
          void stepUp.retry(proof, onRequestError).finally(() => setBusy(false));
        }}
        onCancel={stepUp.dismiss}
      />
    </ProovraCard>
  );
}
