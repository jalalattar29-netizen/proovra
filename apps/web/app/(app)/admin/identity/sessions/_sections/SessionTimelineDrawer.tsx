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
 *
 * PHASE 7: the panel itself was a hand-rolled `role="dialog"` — `right: 0`
 * that did not mirror under RTL, no scrim, no focus move, no focus trap, no
 * focus return and no Escape. It is now `AdmOverlay`, which is the one
 * implementation the console's four panels share, and the body is composed
 * from the canonical surfaces rather than from the legacy token objects.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../../lib/api";
import { useTenantGuard } from "../../../../../../lib/platform-context";
import { Badge } from "../../../../../../components/ui/Badge";
import { Button } from "../../../../../../components/ui/Button";
import {
  AdmFacts,
  AdmInline,
  AdmOverlay,
  AdmSkeleton,
} from "../../../../../../components/admin/AdminSurfaces";
import {
  classifyError,
  type SectionState,
} from "../../../security/_sections/section-state";
import { formatCellDateTime } from "../../../../../../lib/date";

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

/** The API's three levels, mapped to the console's severity vocabulary. */
const SEVERITY: Record<
  IdentityTimelineEvent["severity"],
  "critical" | "warning" | "unknown"
> = {
  HIGH: "critical",
  WARNING: "warning",
  INFO: "unknown",
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
    <AdmOverlay
      title="Session timeline"
      subtitle="Sign-in, second factor, step-up, quarantine and revoke — in order. Page views, mouse activity and evidence reads are never recorded here."
      onClose={onClose}
      testId="session-timeline-drawer"
    >
      {state.kind === "loading" ? <AdmSkeleton shape="row" count={4} /> : null}

      {state.kind === "denied" ? (
        <AdmInline state="unavailable" label="No access">
          {state.message} This is a refusal, not an empty timeline — ask a
          workspace owner or admin for identity-operations access.
        </AdmInline>
      ) : null}

      {state.kind === "error" ? (
        <AdmInline
          state="error"
          action={
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          }
        >
          {state.message}
        </AdmInline>
      ) : null}

      {state.kind === "ready" ? (
        <>
          <section>
            <h3 className="adm-card__title">Session</h3>
            <AdmFacts
              items={[
                {
                  label: "Signed in",
                  value: formatCellDateTime(state.data.session.issuedAtUtc),
                },
                {
                  label: "Expires",
                  value: formatCellDateTime(state.data.session.expiresAtUtc),
                },
                {
                  label: "Last seen",
                  value: formatCellDateTime(state.data.session.lastSeenAtUtc),
                },
                ...(state.data.session.revokedAtUtc
                  ? [
                      {
                        label: "Revoked",
                        value: `${formatCellDateTime(
                          state.data.session.revokedAtUtc,
                        )} (${
                          state.data.session.revocationReason ?? "unspecified"
                        })`,
                      },
                    ]
                  : []),
                ...(state.data.session.ssoConnectionId
                  ? [
                      {
                        label: "Identity provider",
                        value: (
                          <span className="adm-mono">
                            {state.data.session.ssoConnectionId}
                          </span>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </section>

          <section>
            <h3 className="adm-card__title">
              Identity events ({state.data.events.length}
              {state.data.truncated ? " of 200+" : ""})
            </h3>
            {state.data.events.length === 0 ? (
              <AdmInline state="empty" label="No identity events">
                Nothing in the bounded allowlist was recorded for this session.
              </AdmInline>
            ) : (
              <ol className="adm-timeline">
                {state.data.events.map((e) => (
                  <li key={e.id} data-severity={SEVERITY[e.severity]}>
                    <div className="adm-timeline__meta">
                      {/* The marker's colour is a scan aid, not the signal:
                          severity is stated in words so it survives greyscale,
                          colour-blindness and a screen reader. */}
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
                      <span className="adm-timeline__kind">{e.eventType}</span>
                    </div>
                    <div className="adm-timeline__summary">{e.summary}</div>
                    <div className="adm-timeline__when">
                      {formatCellDateTime(e.occurredAtUtc)}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {state.data.truncated ? (
              <p className="adm-note">
                More than 200 events were recorded for this session — older ones
                are not shown. Use the Audit Center for the full history.
              </p>
            ) : null}
          </section>
        </>
      ) : null}
    </AdmOverlay>
  );
}

export default SessionTimelineDrawer;
