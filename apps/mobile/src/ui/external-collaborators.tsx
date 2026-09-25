/**
 * EXTERNAL COLLABORATORS (T-14) — the touch port of the web
 * TeamAccessReviewCard: each outsider with case access expands to their
 * grants, and each grant can be revoked (confirmed first, success decided by a
 * reread). A 403 is the admin gate, never an empty list.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { formatUserDate } from "../lib/date";
import {
  ACCESS_REVIEW_EMPTY,
  ACCESS_REVIEW_FOOTNOTE,
  ACCESS_REVIEW_FORBIDDEN,
  buildAccessReviewPath,
  buildExternalGrantPath,
  collaboratorLabel,
  grantCaseLabel,
  parseExternalCollaborators,
  revokeAcceptedOutcome,
  revokeConfirmCopy,
  revokeRefusedMessage,
  type ExternalCollaborator,
  type ExternalGrant,
  type RevokeOutcome,
} from "../product/access-review";
import { theme } from "../theme/theme";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraText } from "./index";
import { ProovraConfirmSheet } from "./patterns";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; list: ExternalCollaborator[] }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

export function ExternalCollaboratorsCard({ teamId }: { teamId: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pending, setPending] = useState<{ person: ExternalCollaborator; grant: ExternalGrant } | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<RevokeOutcome | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<ExternalCollaborator[] | null> => {
    try {
      const list = parseExternalCollaborators(await apiFetch(buildAccessReviewPath(teamId)));
      if (alive.current) setState({ kind: "ready", list });
      return list;
    } catch (err) {
      if (!alive.current) return null;
      const status = (err as { statusCode?: number } | null)?.statusCode;
      if (status === 403 || status === 404) setState({ kind: "forbidden" });
      else setState({ kind: "error", message: toSafeUserError(err, { message: "Could not load external collaborators." }).message });
      return null;
    }
  }, [teamId]);

  useEffect(() => {
    setState({ kind: "loading" });
    setExpanded(null);
    setOutcome(null);
    void load();
  }, [load]);

  const revoke = useCallback(async () => {
    const target = pending;
    if (!target || revokingId) return;
    const who = collaboratorLabel(target.person);
    const where = grantCaseLabel(target.grant);
    setRevokingId(target.grant.grantId);
    setOutcome(null);
    let written = false;
    try {
      await apiFetch(buildExternalGrantPath(teamId, target.grant.grantId), { method: "DELETE" });
      written = true;
      const reread = await load();
      if (alive.current) setOutcome(revokeAcceptedOutcome(reread, target.grant.grantId, who, where));
    } catch (err) {
      if (!alive.current || written) return;
      const e = err as { statusCode?: number; code?: string } | null;
      const status = typeof e?.statusCode === "number" ? e.statusCode : null;
      if (status === 403) {
        setState({ kind: "forbidden" });
      } else {
        const refused = revokeRefusedMessage(status, typeof e?.code === "string" ? e.code : null, who, where);
        if (refused) await load();
        if (alive.current) {
          setOutcome({ tone: "danger", message: refused ?? toSafeUserError(err, { message: "The access could not be removed. Nothing was changed." }).message });
        }
      }
    } finally {
      if (alive.current) {
        setRevokingId(null);
        setPending(null);
      }
    }
  }, [pending, revokingId, teamId, load]);

  const copy = pending ? revokeConfirmCopy(collaboratorLabel(pending.person), grantCaseLabel(pending.grant)) : null;

  return (
    <ProovraCard testID="external-collaborators">
      <View style={{ gap: theme.space.s3 }}>
        {state.kind === "ready" ? (
          <ProovraBadge label={`${state.list.length} external`} tone={state.list.length > 0 ? "pending" : "neutral"} />
        ) : null}
        {state.kind === "loading" ? (
          <ProovraText variant="bodySm" color={theme.color.ink.muted}>Loading external collaborators…</ProovraText>
        ) : null}
        {state.kind === "error" ? (
          <View style={{ gap: theme.space.s2 }}>
            <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{state.message}</ProovraText>
            <ProovraButton
              label="Try again"
              variant="secondary"
              fullWidth={false}
              onPress={() => {
                setState({ kind: "loading" });
                void load();
              }}
            />
          </View>
        ) : null}
        {state.kind === "forbidden" ? (
          <View style={{ gap: theme.space.s1 }} testID="external-collaborators-gate">
            <ProovraText variant="bodySm" weight="semibold">{ACCESS_REVIEW_FORBIDDEN.headline}</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.secondary}>{ACCESS_REVIEW_FORBIDDEN.reason}</ProovraText>
          </View>
        ) : null}
        {outcome ? (
          <ProovraText
            variant="bodySm"
            color={outcome.tone === "ok" ? theme.color.status.verified.fg : theme.color.status.risk.fg}
          >
            {outcome.message}
          </ProovraText>
        ) : null}
        {state.kind === "ready" ? (
          state.list.length === 0 ? (
            <ProovraText variant="bodySm" color={theme.color.ink.muted}>{ACCESS_REVIEW_EMPTY}</ProovraText>
          ) : (
            state.list.map((person) => {
              const open = expanded === person.userId;
              const who = collaboratorLabel(person);
              return (
                <View key={person.userId} style={{ gap: theme.space.s2, paddingVertical: theme.space.s2 }}>
                  <ProovraText variant="bodySm" weight="semibold">{who}</ProovraText>
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    {[
                      person.email && person.displayName ? person.email : null,
                      person.firstGrantedAtIso ? `First granted ${formatUserDate(person.firstGrantedAtIso)}` : null,
                      person.grants.length === 1 ? "1 case" : `${person.grants.length} cases`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </ProovraText>
                  <View style={{ flexDirection: "row", gap: theme.space.s2, alignItems: "center", flexWrap: "wrap" }}>
                    <ProovraBadge label="Case-scoped" tone="pending" />
                    <ProovraButton
                      label={open ? "Hide cases" : "Show cases"}
                      accessibilityLabel={open ? "Hide cases" : `Show cases for ${who}`}
                      variant="ghost"
                      fullWidth={false}
                      onPress={() => setExpanded(open ? null : person.userId)}
                    />
                  </View>
                  {open
                    ? person.grants.map((grant) => (
                        <View key={grant.grantId} style={{ flexDirection: "row", alignItems: "center", gap: theme.space.s2 }} testID={`external-grant-${grant.grantId}`}>
                          <View style={{ flex: 1 }}>
                            <ProovraText variant="bodySm" weight="semibold">{grantCaseLabel(grant)}</ProovraText>
                            {grant.grantedAtIso ? (
                              <ProovraText variant="label" color={theme.color.ink.muted}>{`granted ${formatUserDate(grant.grantedAtIso)}`}</ProovraText>
                            ) : null}
                          </View>
                          <ProovraButton
                            label="Revoke access"
                            accessibilityLabel={`Revoke ${who}'s access to ${grantCaseLabel(grant)}`}
                            variant="danger"
                            fullWidth={false}
                            loading={revokingId === grant.grantId}
                            disabled={revokingId !== null}
                            onPress={() => setPending({ person, grant })}
                          />
                        </View>
                      ))
                    : null}
                </View>
              );
            })
          )
        ) : null}
        {state.kind === "ready" ? (
          <ProovraText variant="label" color={theme.color.ink.secondary}>{ACCESS_REVIEW_FOOTNOTE}</ProovraText>
        ) : null}
      </View>
      <ProovraConfirmSheet
        visible={pending !== null}
        title={copy?.title ?? ""}
        consequence={copy?.body}
        confirmLabel={copy?.confirm ?? "Revoke access"}
        tone="danger"
        busy={revokingId !== null}
        onConfirm={() => void revoke()}
        onCancel={() => setPending(null)}
      />
    </ProovraCard>
  );
}
