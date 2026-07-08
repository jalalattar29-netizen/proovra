"use client";

/**
 * Phase 4 (Enterprise Administration) — Seats card.
 *
 * Read-only seat posture for the org. Reuses ALREADY-exposed endpoints:
 *   - GET /v1/orgs/:id            → summary.memberCount (used) + pendingInvite.
 *   - GET /v1/orgs/:id/workspaces → per-workspace billing (includedSeats,
 *                                   overSeatLimit, billingOwnerUserId) for
 *                                   ORG_ADMIN+/ORG_BILLING_ADMIN callers.
 *
 * No self-serve checkout: over-limit surfaces a contact-sales CTA. All seat
 * math lives in the unit-tested `seatsModel.ts`. This component only fetches
 * + presents; the only mutations in this surface remain member/invite ones on
 * the parent page.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch, ApiError } from "../../../../../../lib/api";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";
import { deriveSeatsPosture, type SeatsPosture } from "./seatsModel";

interface WorkspacesResponse {
  callerCanSeeBilling: boolean;
  workspaces: Array<{
    workspaceId: string;
    name: string;
    billing?: {
      includedSeats: number | null;
      overSeatLimit: boolean | null;
      billingOwnerUserId: string | null;
    };
  }>;
}

interface OrgSummaryResponse {
  summary: {
    memberCount: number;
    pendingInviteCount: number;
  };
}

type State =
  | { kind: "loading" }
  | { kind: "no-billing-visibility" }
  | { kind: "ready"; posture: SeatsPosture }
  | { kind: "error"; message: string };

const CONTACT_SALES_HREF = "mailto:sales@proovra.com?subject=Enterprise%20seat%20expansion";

export function SeatsCard({ orgId }: { orgId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!orgId) return;
    setState({ kind: "loading" });
    try {
      const [ws, org] = await Promise.all([
        apiFetch(`/v1/orgs/${orgId}/workspaces`) as Promise<WorkspacesResponse>,
        apiFetch(`/v1/orgs/${orgId}`) as Promise<OrgSummaryResponse>,
      ]);
      if (!ws.callerCanSeeBilling) {
        setState({ kind: "no-billing-visibility" });
        return;
      }
      const posture = deriveSeatsPosture({
        workspaces: ws.workspaces.map((w) => ({
          includedSeats: w.billing?.includedSeats ?? null,
          overSeatLimit: w.billing?.overSeatLimit ?? null,
          billingOwnerUserId: w.billing?.billingOwnerUserId ?? null,
        })),
        memberCount: org.summary.memberCount,
        pendingInviteCount: org.summary.pendingInviteCount,
      });
      setState({ kind: "ready", posture });
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 403) {
        setState({ kind: "no-billing-visibility" });
        return;
      }
      setState({
        kind: "error",
        message: toSafeUserError(err, { message: "Failed to load seats." })
          .message,
      });
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section
      data-section="seats-card"
      data-testid="org-admin-seats-card"
      style={{
        padding: "1rem 1.1rem",
        border: "1px solid rgba(127,127,127,0.3)",
        borderRadius: 8,
        marginBottom: "1rem",
      }}
    >
      <header style={{ marginBottom: "0.5rem" }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Seats</h2>
        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>
          Included vs. used seats across this organization's workspaces.
          Enterprise seat changes go through your account team — no self-serve
          checkout.
        </div>
      </header>

      {state.kind === "loading" ? (
        <div data-state="loading" style={{ fontSize: 13, opacity: 0.7 }}>
          Loading…
        </div>
      ) : state.kind === "no-billing-visibility" ? (
        <div
          data-state="no-billing-visibility"
          style={{ fontSize: 13, opacity: 0.8 }}
        >
          You don't have billing visibility for this organization. Ask an
          organization owner, admin, or billing admin.
        </div>
      ) : state.kind === "error" ? (
        <div data-state="error" role="alert" style={{ fontSize: 13 }}>
          {state.message}
        </div>
      ) : (
        <SeatsBody posture={state.posture} />
      )}
    </section>
  );
}

function SeatsBody({ posture }: { posture: SeatsPosture }) {
  const {
    includedSeats,
    usedSeats,
    pendingSeats,
    projectedSeats,
    remainingSeats,
    status,
    billingOwnerUserIds,
    projectedOverLimit,
  } = posture;

  return (
    <div
      data-testid="seats-body"
      data-seat-status={status}
      data-included-seats={includedSeats}
      data-used-seats={usedSeats}
      data-pending-seats={pendingSeats}
      data-over-seat-limit={status === "over" ? "true" : "false"}
    >
      <div
        style={{
          display: "flex",
          gap: 20,
          flexWrap: "wrap",
          marginBottom: 10,
        }}
      >
        <Stat label="Included" value={includedSeats} testId="seats-included" />
        <Stat label="Used" value={usedSeats} testId="seats-used" />
        <Stat
          label="Pending invites"
          value={pendingSeats}
          testId="seats-pending"
        />
        <Stat
          label="Remaining"
          value={remainingSeats}
          testId="seats-remaining"
          tone={remainingSeats < 0 ? "danger" : "default"}
        />
      </div>

      {status === "over" ? (
        <Banner tone="danger" testId="seats-over-banner">
          This organization is <strong>over its seat limit</strong> ({usedSeats}{" "}
          used / {includedSeats} included). Contact your account team to expand
          seats.
        </Banner>
      ) : projectedOverLimit ? (
        <Banner tone="warning" testId="seats-projected-banner">
          Accepting all {pendingSeats} pending invite
          {pendingSeats === 1 ? "" : "s"} would reach {projectedSeats} seats and{" "}
          <strong>exceed the {includedSeats} included</strong>. Plan seat
          capacity before they accept.
        </Banner>
      ) : (
        <div
          data-testid="seats-ok"
          style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}
        >
          Within seat capacity. {remainingSeats} seat
          {remainingSeats === 1 ? "" : "s"} remaining.
        </div>
      )}

      {billingOwnerUserIds.length > 0 ? (
        <div
          data-testid="seats-billing-owner"
          style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}
        >
          Billing owner
          {billingOwnerUserIds.length === 1 ? "" : "s"}:{" "}
          {billingOwnerUserIds.map((id) => (
            <code key={id} style={{ marginRight: 6 }}>
              {id}
            </code>
          ))}
        </div>
      ) : null}

      {status !== "ok" ? (
        <a
          href={CONTACT_SALES_HREF}
          data-testid="seats-contact-sales"
          className="cc-quick-action"
          style={{
            display: "inline-block",
            marginTop: 10,
            padding: "0.45rem 0.9rem",
            fontSize: 13,
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Contact sales to expand seats
        </a>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  testId,
  tone = "default",
}: {
  label: string;
  value: number;
  testId: string;
  tone?: "default" | "danger";
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          opacity: 0.6,
        }}
      >
        {label}
      </span>
      <span
        data-testid={testId}
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: tone === "danger" ? "#d44" : "inherit",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function Banner({
  tone,
  testId,
  children,
}: {
  tone: "danger" | "warning";
  testId: string;
  children: React.ReactNode;
}) {
  const color = tone === "danger" ? "#d44" : "#b8860b";
  return (
    <div
      role="alert"
      data-testid={testId}
      style={{
        marginTop: 6,
        padding: "0.5rem 0.6rem",
        border: `1px solid ${color}`,
        borderRadius: 4,
        fontSize: 13,
        background:
          tone === "danger"
            ? "rgba(220,68,68,0.06)"
            : "rgba(184,134,11,0.08)",
      }}
    >
      {children}
    </div>
  );
}
