/**
 * WORKSPACE OWNERSHIP TRANSFER — the native port of
 * `apps/web/app/(app)/teams/[id]/components/WorkspaceOwnershipTransferCard.tsx`.
 *
 *   GET  /v1/teams/:id/members?eligible=ownership_transfer&q&cursor&limit
 *   POST /v1/teams/:id/transfer-ownership  { newOwnerUserId, stepUp? }
 *
 * D46 — the candidates come from the SERVER's eligible list (ACTIVE, not the
 * owner), searched and paged there. The previous native sheet filtered the
 * roster page on screen, so on a workspace larger than one page every eligible
 * member after it could never be offered.
 *
 * Touch adaptation: the web's <select> is a list of rows with the chosen one
 * marked; the explicit confirmation step and the step-up are unchanged.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { theme } from "../theme/theme";
import { withStepUp } from "../product/step-up";
import {
  buildTransferCandidatesPath,
  buildWorkspaceTransferBody,
  buildWorkspaceTransferPath,
  parseTransferCandidates,
  transferDenialCopy,
  transferOutcome,
  type TransferCandidate,
} from "../product/workspace-people";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraFormField, ProovraInput, ProovraListRow, ProovraText } from "./index";
import { StepUpSheet, useStepUp } from "./step-up-sheet";

type CandidateList =
  | { kind: "loading" }
  | { kind: "ready"; rows: TransferCandidate[]; nextCursor: string | null; total: number }
  | { kind: "failed"; message: string };

export function WorkspaceOwnershipTransferCard({
  teamId,
  teamName,
  currentUserId,
  onTransferred,
}: {
  teamId: string;
  teamName: string;
  currentUserId: string | null;
  /** Receives the outcome sentence; the parent keeps it, because a transfer demotes the actor and unmounts this card. */
  onTransferred: (notice: string) => void | Promise<void>;
}) {
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [list, setList] = useState<CandidateList>({ kind: "loading" });
  const [hasLoaded, setHasLoaded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [target, setTarget] = useState<TransferCandidate | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const stepUp = useStepUp();

  useEffect(() => {
    const t = setTimeout(() => setQuery(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    const mine = ++seq.current;
    let live = true;
    setList({ kind: "loading" });
    apiFetch(buildTransferCandidatesPath(teamId, query, null))
      .then((d) => {
        if (!live || mine !== seq.current) return;
        setHasLoaded(true);
        setList({ kind: "ready", ...parseTransferCandidates(d, currentUserId) });
      })
      .catch((err) => {
        if (!live || mine !== seq.current) return;
        setList({
          kind: "failed",
          message: toSafeUserError(err, { message: "The members who can take ownership could not be loaded." }).message,
        });
      });
    return () => {
      live = false;
    };
  }, [teamId, query, currentUserId, reloadKey]);

  const loadMore = useCallback(async () => {
    if (list.kind !== "ready" || !list.nextCursor || loadingMore) return;
    const mine = seq.current;
    setLoadingMore(true);
    try {
      const page = parseTransferCandidates(
        await apiFetch(buildTransferCandidatesPath(teamId, query, list.nextCursor)),
        currentUserId,
      );
      if (mine !== seq.current) return;
      setList((prev) =>
        prev.kind === "ready" ? { kind: "ready", rows: [...prev.rows, ...page.rows], nextCursor: page.nextCursor, total: page.total } : prev,
      );
    } catch (err) {
      setError(toSafeUserError(err, { message: "More members could not be loaded. Try again." }).message);
    } finally {
      setLoadingMore(false);
    }
  }, [list, loadingMore, teamId, query, currentUserId]);

  const fail = useCallback((err: unknown) => setError(transferDenialCopy(err, toSafeUserError(err).message || null)), []);

  const transfer = useCallback(async () => {
    const chosen = target;
    if (!chosen) return;
    setError(null);
    setBusy(true);
    await stepUp.start(async (proof) => {
      await apiFetch(buildWorkspaceTransferPath(teamId), {
        method: "POST",
        body: JSON.stringify(withStepUp(buildWorkspaceTransferBody(chosen.userId), proof)),
      });
      setConfirming(false);
      setTarget(null);
      await onTransferred(transferOutcome(chosen.label, teamName));
    }, fail);
    setBusy(false);
  }, [target, stepUp, teamId, teamName, onTransferred, fail]);

  const rows = list.kind === "ready" ? list.rows : [];
  // Keep the chosen member selectable after a search that no longer lists them.
  const options = target && !rows.some((r) => r.userId === target.userId) ? [target, ...rows] : rows;
  const nobodyEligible = list.kind === "ready" && list.total === 0 && query === "" && !target;

  return (
    <ProovraCard testID="workspace-transfer-card">
      <ProovraText variant="h3" weight="semibold">
        Transfer ownership
      </ProovraText>
      <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
        Hand this workspace to another active member. They become the owner and the billing owner; you stay a member.
        Evidence, cases and audit history are unaffected.
      </ProovraText>

      {list.kind === "loading" && !hasLoaded ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>
          Loading the members who can take ownership…
        </ProovraText>
      ) : list.kind === "failed" ? (
        <View style={{ gap: theme.space.s1 }}>
          <ProovraText variant="label" color={theme.color.status.risk.fg}>
            {list.message}
          </ProovraText>
          <ProovraButton label="Try again" variant="ghost" fullWidth={false} disabled={busy} onPress={() => setReloadKey((k) => k + 1)} />
        </View>
      ) : nobodyEligible ? (
        <ProovraText variant="label" color={theme.color.ink.muted}>
          Invite another member first — ownership can only move to someone who is already an active member of this
          workspace.
        </ProovraText>
      ) : (
        <View style={{ gap: theme.space.s2 }}>
          <ProovraFormField label="Find a member">
            <ProovraInput
              value={searchInput}
              onChangeText={setSearchInput}
              placeholder="Search by name or email"
              autoCapitalize="none"
              editable={!busy}
              accessibilityLabel="Find a member"
            />
          </ProovraFormField>
          <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>
            New owner
          </ProovraText>
          {target ? null : (
            <ProovraText variant="label" color={theme.color.ink.muted}>
              Select the new owner…
            </ProovraText>
          )}
          {options.map((c) => {
            const selected = target?.userId === c.userId;
            return (
              <ProovraListRow
                key={c.userId}
                title={c.label}
                onPress={
                  busy
                    ? undefined
                    : () => {
                        setTarget(c);
                        setConfirming(false);
                      }
                }
                trailing={selected ? <ProovraBadge label="Selected" tone="info" /> : undefined}
              />
            );
          })}
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {list.kind === "loading"
              ? "Searching…"
              : list.kind === "ready" && list.total === 0
                ? "No active member matches that search."
                : list.kind === "ready"
                  ? `Showing ${list.rows.length} of ${list.total} ${query ? "matching " : ""}member${list.total === 1 ? "" : "s"} who can take ownership`
                  : ""}
          </ProovraText>
          {list.kind === "ready" && list.nextCursor ? (
            <ProovraButton
              label="Show more members"
              variant="ghost"
              fullWidth={false}
              loading={loadingMore}
              disabled={busy}
              onPress={() => void loadMore()}
            />
          ) : null}

          {!confirming ? (
            <ProovraButton
              label="Transfer ownership…"
              variant="secondary"
              fullWidth={false}
              disabled={busy || !target}
              onPress={() => {
                setError(null);
                setConfirming(true);
              }}
            />
          ) : (
            <View
              testID="workspace-transfer-confirm"
              style={{
                gap: theme.space.s2,
                padding: theme.space.s3,
                borderRadius: theme.radius.md,
                borderWidth: 1,
                borderColor: theme.color.border.subtle,
              }}
            >
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                {`Transfer ${teamName} to ${target?.label ?? "the selected member"}? They gain owner-only controls, including closing this workspace, and billing ownership moves with them. You can only get it back if they transfer it to you.`}
              </ProovraText>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
                <ProovraButton
                  label="Confirm transfer"
                  variant="danger"
                  fullWidth={false}
                  loading={busy}
                  disabled={!target}
                  onPress={() => void transfer()}
                />
                <ProovraButton label="Keep ownership" variant="ghost" fullWidth={false} disabled={busy} onPress={() => setConfirming(false)} />
              </View>
            </View>
          )}
        </View>
      )}

      {busy || error ? (
        <ProovraText
          variant="label"
          color={error ? theme.color.status.risk.fg : theme.color.ink.muted}
        >
          {busy ? "Transferring ownership…" : error}
        </ProovraText>
      ) : null}

      <StepUpSheet
        challenge={stepUp.challenge}
        title="Confirm transferring this workspace."
        busy={busy}
        onSubmit={(proof) => {
          setBusy(true);
          void stepUp.retry(proof, fail).finally(() => setBusy(false));
        }}
        onCancel={stepUp.dismiss}
      />
    </ProovraCard>
  );
}
