"use client";

/**
 * Phase 4 (Enterprise Administration) — Seats card.
 *
 * MEMBERS RE-AUDIT ENT-05 / DEFECT 14 — this card reads the CANONICAL seat
 * authority, and nothing else.
 *
 * It used to sum each workspace's raw `includedSeats`, compare that with the
 * ORGANIZATION's member count, and OR in the persisted `Team.overSeatLimit`
 * flag written by the legacy owner-inclusive formula. None of those is what
 * the member gate decides with, so an Enterprise workspace with a 10-seat
 * contract, ten members and its owner was shown "over its seat limit" while
 * the gate admitted it.
 *
 * Every figure is now the per-workspace answer of `resolveWorkspaceSeatState`
 * (services/api/src/services/billing/workspace-seats.service.ts), projected by
 * GET /v1/orgs/:id/workspaces as `billing.seats`:
 *   - used       ACTIVE members other than the workspace owner;
 *   - limit      the ACTIVE Enterprise contract's seat count, or null when
 *                nothing bounds the workspace as a whole (capacity is then per
 *                Collaboration Team);
 *   - overLimit  the gate's own comparison.
 * Pending invitations consume no seat, so they are not projected here.
 *
 * No self-serve checkout: over-limit surfaces a contact-sales CTA.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch, ApiError } from "../../../../../../lib/api";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";

export interface CanonicalWorkspaceSeats {
  used: number;
  limit: number | null;
  remaining: number | null;
  overLimit: boolean;
  featureIncluded: boolean;
  source: "PLAN_CATALOG" | "ENTERPRISE_CONTRACT";
}

interface WorkspacesResponse {
  callerCanSeeBilling: boolean;
  workspaces: Array<{
    workspaceId: string;
    name: string;
    billing?: {
      billingOwnerUserId: string | null;
      seats?: CanonicalWorkspaceSeats;
    };
  }>;
}

interface WorkspaceSeatRow {
  workspaceId: string;
  name: string;
  seats: CanonicalWorkspaceSeats;
}

interface SeatsPosture {
  /** ACTIVE non-owner members across the organization's workspaces. */
  usedSeats: number;
  /** Sum of the contract ceilings, or null when no workspace is bounded. */
  contractSeats: number | null;
  /** Remaining under those ceilings, or null when unbounded. */
  remainingSeats: number | null;
  overWorkspaces: WorkspaceSeatRow[];
  billingOwnerUserIds: string[];
  status: "ok" | "over";
}

function postureFrom(ws: WorkspacesResponse): SeatsPosture {
  const rows: WorkspaceSeatRow[] = ws.workspaces.flatMap((w) =>
    w.billing?.seats
      ? [{ workspaceId: w.workspaceId, name: w.name, seats: w.billing.seats }]
      : [],
  );
  const bounded = rows.filter((r) => r.seats.limit !== null);
  const usedSeats = rows.reduce((n, r) => n + r.seats.used, 0);
  const contractSeats =
    bounded.length > 0
      ? bounded.reduce((n, r) => n + (r.seats.limit ?? 0), 0)
      : null;
  const remainingSeats =
    bounded.length > 0
      ? bounded.reduce((n, r) => n + (r.seats.remaining ?? 0), 0)
      : null;
  const overWorkspaces = rows.filter((r) => r.seats.overLimit);
  const billingOwnerUserIds = Array.from(
    new Set(
      ws.workspaces
        .map((w) => w.billing?.billingOwnerUserId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  return {
    usedSeats,
    contractSeats,
    remainingSeats,
    overWorkspaces,
    billingOwnerUserIds,
    status: overWorkspaces.length > 0 ? "over" : "ok",
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
      const ws = (await apiFetch(
        `/v1/orgs/${orgId}/workspaces`,
      )) as WorkspacesResponse;
      if (!ws.callerCanSeeBilling) {
        setState({ kind: "no-billing-visibility" });
        return;
      }
      setState({ kind: "ready", posture: postureFrom(ws) });
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
          Members across this organization&apos;s workspaces, against the seats
          your contract includes. A workspace owner does not use a seat, and a
          pending invitation uses none until it is accepted. Enterprise seat
          changes go through your account team — no self-serve checkout.
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
          You don&apos;t have billing visibility for this organization. Ask an
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
    usedSeats,
    contractSeats,
    remainingSeats,
    overWorkspaces,
    billingOwnerUserIds,
    status,
  } = posture;

  return (
    <div
      data-testid="seats-body"
      data-seat-status={status}
      data-included-seats={contractSeats ?? ""}
      data-used-seats={usedSeats}
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
        <Stat
          label="Contract seats"
          value={contractSeats ?? "Not capped"}
          testId="seats-included"
        />
        <Stat label="Used" value={usedSeats} testId="seats-used" />
        {remainingSeats !== null ? (
          <Stat
            label="Remaining"
            value={remainingSeats}
            testId="seats-remaining"
          />
        ) : null}
      </div>

      {status === "over" ? (
        <Banner tone="danger" testId="seats-over-banner">
          {overWorkspaces.map((w) => (
            <div key={w.workspaceId} data-testid="seats-over-workspace">
              <strong>{w.name}</strong> is over its contract seat limit (
              {w.seats.used} used / {w.seats.limit} included).
            </div>
          ))}
          Contact your account team to expand seats.
        </Banner>
      ) : contractSeats === null ? (
        <div
          data-testid="seats-ok"
          style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}
        >
          No organization-wide seat ceiling applies. Membership capacity is set
          per Collaboration Team.
        </div>
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
}: {
  label: string;
  value: number | string;
  testId: string;
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
