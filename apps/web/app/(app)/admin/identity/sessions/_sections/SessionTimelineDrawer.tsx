"use client";

/**
 * Phase P1.1 — bounded session identity timeline drawer.
 *
 * PHASE 12B: moved out of the sessions page verbatim in behaviour so the
 * page can stay an orchestrator. Reads
 *
 *   GET /v1/identity/sessions/:id/timeline?teamId
 *
 * This is NOT surveillance: only the bounded identity-event allowlist is
 * surfaced (login, MFA, step-up, quarantine, revoke). Page views, mouse
 * activity and evidence-content reads are never included, and IP / UA /
 * device telemetry is omitted from the timeline entirely.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../../lib/api";
import { useTenantGuard } from "../../../../../../lib/platform-context";
import { Badge } from "../../../../../../components/ui/Badge";
import { Button } from "../../../../../../components/ui/Button";
import {
  classifyError,
  sectionMuted,
  type SectionState,
} from "../../../security/_sections/section-state";
import { formatDateTime, TOKENS } from "../../ui-tokens";

type IdentityTimelineEvent = {
  id: string;
  occurredAtUtc: string;
  eventType: string;
  severity: "INFO" | "WARNING" | "HIGH";
  summary: string;
};

type IdentitySessionTimeline = {
  sessionId: string;
  teamId: string;
  session: {
    issuedAtUtc: string;
    expiresAtUtc: string | null;
    lastSeenAtUtc: string | null;
    revokedAtUtc: string | null;
    revocationReason: string | null;
    ssoConnectionId: string | null;
  };
  events: ReadonlyArray<IdentityTimelineEvent>;
  truncated: boolean;
};

export function SessionTimelineDrawer({
  teamId,
  sessionId,
  onClose,
}: {
  teamId: string;
  sessionId: string;
  onClose: () => void;
}) {
  const { stamp, isStale } = useTenantGuard();
  const [state, setState] = useState<SectionState<IdentitySessionTimeline>>({
    kind: "loading",
  });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const captured = stamp();
    try {
      const res = (await apiFetch(
        `/v1/identity/sessions/${encodeURIComponent(
          sessionId,
        )}/timeline?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as { timeline?: IdentitySessionTimeline } | null;
      if (isStale(captured)) return;
      if (!res?.timeline) {
        setState({
          kind: "error",
          message: "The server did not return a timeline for that session.",
        });
        return;
      }
      setState({ kind: "ready", data: res.timeline });
    } catch (err) {
      if (isStale(captured)) return;
      setState(
        classifyError<IdentitySessionTimeline>(
          err,
          "We couldn't load this session's timeline.",
        ),
      );
    }
  }, [teamId, sessionId, stamp, isStale]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div
      role="dialog"
      aria-label="Session identity timeline"
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        height: "100vh",
        width: "min(560px, 100vw)",
        background: TOKENS.surface,
        borderInlineStart: `1px solid ${TOKENS.border}`,
        boxShadow: "0 0 40px rgba(15, 23, 42, 0.1)",
        zIndex: 50,
        overflowY: "auto",
        padding: 20,
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <h2 style={{ fontSize: 16, margin: 0 }}>Session timeline</h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </header>

      <p style={sectionMuted}>
        Bounded reconstruction of the identity events in this session&apos;s life:
        sign-in, second factor, step-up, quarantine, revoke. Page views, mouse
        activity and evidence reads are never included.
      </p>

      {state.kind === "loading" ? (
        <p style={sectionMuted}>Reading the timeline…</p>
      ) : null}

      {state.kind === "denied" ? (
        <div style={{ marginTop: 12 }}>
          <Badge tone="neutral">No access</Badge>
          <p style={{ ...sectionMuted, marginTop: 6 }}>{state.message}</p>
          <p style={sectionMuted}>
            This is a refusal, not an empty timeline. Ask a workspace owner or
            admin for identity-operations access.
          </p>
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div style={{ marginTop: 12 }}>
          <Badge tone="risk">Could not load</Badge>
          <p style={{ ...sectionMuted, marginTop: 6 }}>{state.message}</p>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : null}

      {state.kind === "ready" ? (
        <>
          <section style={{ marginTop: 12 }}>
            <h3 style={{ fontSize: 13, fontWeight: 700, margin: "0 0 6px" }}>Session</h3>
            <dl style={{ margin: 0, fontSize: 12.5 }}>
              <Row label="Signed in" value={formatDateTime(state.data.session.issuedAtUtc)} />
              <Row label="Expires" value={formatDateTime(state.data.session.expiresAtUtc)} />
              <Row
                label="Last seen"
                value={formatDateTime(state.data.session.lastSeenAtUtc)}
              />
              {state.data.session.revokedAtUtc ? (
                <Row
                  label="Revoked"
                  value={`${formatDateTime(state.data.session.revokedAtUtc)} (${
                    state.data.session.revocationReason ?? "unspecified"
                  })`}
                />
              ) : null}
              {state.data.session.ssoConnectionId ? (
                <Row
                  label="Identity provider"
                  value={`${state.data.session.ssoConnectionId.slice(0, 8)}…`}
                />
              ) : null}
            </dl>
          </section>

          <section style={{ marginTop: 16 }}>
            <h3 style={{ fontSize: 13, fontWeight: 700, margin: "0 0 6px" }}>
              Identity events ({state.data.events.length}
              {state.data.truncated ? " of 200+" : ""})
            </h3>
            {state.data.events.length === 0 ? (
              <p style={sectionMuted}>
                No bounded identity events were recorded for this session.
              </p>
            ) : (
              <ol
                style={{
                  margin: 0,
                  padding: 0,
                  listStyle: "none",
                  borderInlineStart: `2px solid ${TOKENS.border}`,
                }}
              >
                {state.data.events.map((e) => (
                  <li
                    key={e.id}
                    style={{
                      marginInlineStart: 12,
                      paddingInlineStart: 12,
                      paddingBottom: 12,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        alignItems: "center",
                        marginBottom: 2,
                      }}
                    >
                      <Badge
                        tone={
                          e.severity === "HIGH"
                            ? "risk"
                            : e.severity === "WARNING"
                              ? "pending"
                              : "info"
                        }
                      >
                        {e.severity}
                      </Badge>
                      <span style={sectionMuted}>{e.eventType}</span>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{e.summary}</div>
                    <div style={sectionMuted}>{formatDateTime(e.occurredAtUtc)}</div>
                  </li>
                ))}
              </ol>
            )}
            {state.data.truncated ? (
              <p style={{ ...sectionMuted, marginTop: 8 }}>
                More than 200 events were recorded for this session — older ones
                are not shown. Use the Audit Center for the full history.
              </p>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: 8, padding: "3px 0" }}>
      <dt style={{ ...sectionMuted, minWidth: 130 }}>{label}</dt>
      <dd style={{ margin: 0 }}>{value}</dd>
    </div>
  );
}

export default SessionTimelineDrawer;
