"use client";

/**
 * PHASE 12B — Invitation governance for a provisioned Organization.
 *
 * Closes the enterprise-provisioning journey end to end. Provisioning already
 * commits a DURABLE delivery outbox row per invitation and a worker drains it
 * with retry + token rotation; what was missing was the operator's view of that
 * durable state and the ability to act on it:
 *
 *   * list every pending invitation with its REAL delivery state
 *     (queued / sent / failed / stopped + attempt count),
 *   * RESEND — which actually re-delivers: the server rotates the invitation
 *     token (killing the previously emailed link, so a duplicate delivery can
 *     never leave two working acceptance URLs) and returns the fresh
 *     acceptance URL exactly once,
 *   * REVOKE — confirmed, and honest about what it does to a link already in
 *     someone's inbox,
 *   * open the invited Organization's own context rather than making the
 *     operator hunt for it.
 *
 * The Organization id is never free-typed in the happy path: it is seeded from
 * the server's own provisioning result. A 403/404 is rendered as an explicit
 * denial — a platform operator is not automatically an administrator of a
 * customer Organization, and pretending "no invitations" would be a lie.
 */

import { useCallback, useEffect, useState } from "react";

import { ResultCount } from "../../../../../components/ui/ResultCount";
import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { notifyApiError } from "../../../../../lib/feedback/notify";
import { useToast } from "../../../../../components/ui";
import { useTenantGuard } from "../../../../../lib/platform-context";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import { Card } from "../../../../../components/ui/Card";
import { Button } from "../../../../../components/ui/Button";
import { Badge } from "../../../../../components/ui/Badge";
import { EmptyState } from "../../../../../components/ui/EmptyState";
import {
  DataTable,
  type DataTableColumn,
} from "../../../../../components/ui/DataTable";

type DeliveryState = {
  deliveryId: string;
  status: "PENDING" | "SENT" | "FAILED" | "CANCELLED";
  attempts: number;
  lastError: string | null;
};

type PendingInvite = {
  inviteId: string;
  email: string;
  role: string;
  invitedByUserId: string | null;
  expiresAt: string;
  lastResentAt: string | null;
  resendCount: number;
  createdAt: string;
  delivery: DeliveryState | null;
};

type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "denied"; title: string; detail: string }
  | { kind: "error"; detail: string }
  | { kind: "ready"; invites: PendingInvite[]; totalPending: number };

const mutedStyle = {
  fontSize: 12.5,
  lineHeight: 1.55,
  color: "var(--ink-secondary)",
} as const;

const monoStyle = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12,
} as const;

const inputStyle = {
  padding: "10px 12px",
  border: "1px solid var(--border-default)",
  borderRadius: 10,
  fontSize: 14,
  background: "var(--surface-card)",
  color: "var(--ink-primary)",
  width: "100%",
  outline: "none",
} as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function deliveryTone(status: DeliveryState["status"]) {
  if (status === "SENT") return "verified" as const;
  if (status === "FAILED") return "risk" as const;
  if (status === "CANCELLED") return "neutral" as const;
  return "pending" as const;
}

function deliveryLabel(d: DeliveryState | null): string {
  if (!d) return "No delivery record";
  if (d.status === "SENT") return "Email sent";
  if (d.status === "FAILED") return "Email failed";
  if (d.status === "CANCELLED") return "Delivery stopped";
  return "Queued for delivery";
}

function formatWhen(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function absoluteUrl(relativeOrAbsolute: string): string {
  if (typeof window === "undefined") return relativeOrAbsolute;
  try {
    return new URL(relativeOrAbsolute, window.location.origin).toString();
  } catch {
    return relativeOrAbsolute;
  }
}

export function InvitationGovernanceSection({
  organizationId,
  onOrganizationIdChange,
}: {
  organizationId: string;
  onOrganizationIdChange: (next: string) => void;
}) {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const { stamp, isStale } = useTenantGuard();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [busy, setBusy] = useState<string | null>(null);
  /** Fresh acceptance URL from a resend — shown ONCE, never persisted. */
  const [freshAcceptUrl, setFreshAcceptUrl] = useState<{
    inviteId: string;
    url: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const trimmedOrgId = organizationId.trim();
  const orgIdValid = UUID_RE.test(trimmedOrgId);

  const classify = useCallback((err: unknown): Phase | null => {
    const e = (err ?? {}) as {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
    };
    const status = typeof e.statusCode === "number" ? e.statusCode : e.status;
    const code = typeof e.code === "string" ? e.code.toLowerCase() : "";
    if (status === 403 || code === "forbidden" || code === "permission_denied") {
      return {
        kind: "denied",
        title: "You're not an administrator of this organization",
        detail:
          "Invitation governance is performed by an administrator of the customer organization. Provisioning it does not make you one. Nothing was loaded and nothing was changed.",
      };
    }
    if (status === 404 || code === "not_found") {
      return {
        kind: "denied",
        title: "Organization not available",
        detail:
          "No organization with that id is available to your account. Check the id returned by provisioning.",
      };
    }
    return null;
  }, []);

  const load = useCallback(async () => {
    if (!orgIdValid) {
      setPhase({ kind: "idle" });
      return;
    }
    const captured = stamp();
    setPhase({ kind: "loading" });
    try {
      const r = (await apiFetch(
        `/v1/orgs/${encodeURIComponent(trimmedOrgId)}/invites`,
        { method: "GET" },
      )) as {
        invites?: PendingInvite[];
        summary?: { totalPending?: number };
      };
      if (isStale(captured)) return;
      setPhase({
        kind: "ready",
        invites: r.invites ?? [],
        totalPending: r.summary?.totalPending ?? (r.invites ?? []).length,
      });
    } catch (err) {
      if (isStale(captured)) return;
      const denial = classify(err);
      if (denial) {
        setPhase(denial);
        return;
      }
      setPhase({
        kind: "error",
        detail: toSafeUserError(err, {
          message: "We couldn't load this organization's invitations.",
        }).message,
      });
    }
  }, [trimmedOrgId, orgIdValid, stamp, isStale, classify]);

  useEffect(() => {
    void load();
  }, [load]);

  // A freshly minted acceptance URL must not survive a target change.
  useEffect(() => {
    setFreshAcceptUrl(null);
    setCopied(false);
  }, [trimmedOrgId]);

  const resend = useCallback(
    async (invite: PendingInvite) => {
      const ok = await confirm({
        title: `Send a new invitation to ${invite.email}?`,
        description:
          "A fresh invitation email is sent and the previous link stops working immediately, so there is never more than one usable acceptance link for this person. The new link is shown here once.",
        confirmLabel: "Send new invitation",
        tone: "warning",
        testId: "invite-resend",
      });
      if (!ok) return;
      setBusy(invite.inviteId);
      setFreshAcceptUrl(null);
      setCopied(false);
      const captured = stamp();
      try {
        const r = (await apiFetch(
          `/v1/orgs/${encodeURIComponent(trimmedOrgId)}/invites/${encodeURIComponent(invite.inviteId)}/resend`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          },
        )) as { acceptUrl?: string | null; delivery?: DeliveryState | null };
        if (isStale(captured)) return;
        if (typeof r.acceptUrl === "string" && r.acceptUrl.length > 0) {
          setFreshAcceptUrl({
            inviteId: invite.inviteId,
            url: absoluteUrl(r.acceptUrl),
          });
        }
        addToast(
          r.delivery?.status === "SENT"
            ? "Invitation email sent."
            : "Invitation refreshed — delivery is queued.",
          "success",
        );
        await load();
      } catch (err) {
        if (isStale(captured)) return;
        const denial = classify(err);
        if (denial) {
          setPhase(denial);
          return;
        }
        notifyApiError(addToast, err, {
          message: "We couldn't resend this invitation.",
        });
      } finally {
        setBusy(null);
      }
    },
    [trimmedOrgId, confirm, addToast, load, stamp, isStale, classify],
  );

  const revoke = useCallback(
    async (invite: PendingInvite) => {
      const ok = await confirm({
        title: `Revoke the invitation for ${invite.email}?`,
        description:
          "The acceptance link stops working immediately, including a copy already sitting in their inbox. This cannot be undone — you would have to send a new invitation.",
        confirmLabel: "Revoke invitation",
        tone: "danger",
        testId: "invite-revoke",
      });
      if (!ok) return;
      setBusy(invite.inviteId);
      setFreshAcceptUrl(null);
      const captured = stamp();
      try {
        await apiFetch(
          `/v1/orgs/${encodeURIComponent(trimmedOrgId)}/invites/${encodeURIComponent(invite.inviteId)}`,
          { method: "DELETE" },
        );
        if (isStale(captured)) return;
        addToast("Invitation revoked.", "success");
        await load();
      } catch (err) {
        if (isStale(captured)) return;
        const denial = classify(err);
        if (denial) {
          setPhase(denial);
          return;
        }
        notifyApiError(addToast, err, {
          message: "We couldn't revoke this invitation.",
        });
      } finally {
        setBusy(null);
      }
    },
    [trimmedOrgId, confirm, addToast, load, stamp, isStale, classify],
  );

  const columns: DataTableColumn<PendingInvite>[] = [
    {
      key: "person",
      header: "Invited",
      render: (i) => (
        <div style={{ fontSize: 12.5 }}>
          <div style={{ fontWeight: 600 }}>{i.email}</div>
          <div style={mutedStyle}>{i.role.replaceAll("_", " ").toLowerCase()}</div>
        </div>
      ),
    },
    {
      key: "delivery",
      header: "Email delivery",
      render: (i) => (
        <span data-delivery-status={i.delivery?.status ?? "NONE"}>
          <Badge tone={deliveryTone(i.delivery?.status ?? "PENDING")} subtle>
            {deliveryLabel(i.delivery)}
          </Badge>
          {i.delivery && i.delivery.attempts > 1 ? (
            <span style={{ ...mutedStyle, marginInlineStart: 8 }}>
              {i.delivery.attempts} attempts
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "expires",
      header: "Link expires",
      nowrap: true,
      render: (i) => <span style={mutedStyle}>{formatWhen(i.expiresAt)}</span>,
    },
    {
      key: "resent",
      header: "Last resent",
      nowrap: true,
      render: (i) => (
        <span style={mutedStyle}>
          {i.resendCount === 0 ? "Never" : formatWhen(i.lastResentAt)}
        </span>
      ),
    },
  ];

  return (
    <Card
      variant="summary"
      padding="comfortable"
      data-section="invitation-governance"
 >
      <p style={{ ...mutedStyle, marginTop: 0, marginBottom: 16, maxWidth: 660 }}>
        Every invitation gets a durable delivery record, so a queued or failed
        email is visible here rather than silently lost. Resending sends a brand
        new link and kills the old one, so a person can never hold two working
        acceptance links.
      </p>

      <label
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          fontSize: 13,
          fontWeight: 600,
          maxWidth: 420,
          marginBottom: 16,
        }}
 >
        <span>Organization id</span>
        <input
          style={inputStyle}
          value={organizationId}
          onChange={(e) => onOrganizationIdChange(e.target.value)}
          placeholder="Filled in automatically after you provision a customer"
          data-testid="invite-governance-org-id"
        />
        {organizationId.trim().length > 0 && !orgIdValid ? (
          <span style={{ ...mutedStyle, color: "var(--status-risk-fg)" }}>
            That doesn&apos;t look like an organization id.
          </span>
        ) : null}
      </label>

      {phase.kind === "idle" ? (
        <EmptyState variant="inline"
          title="No organization selected"
          purpose="Provision a customer above — its organization id is filled in here automatically — or paste the id of an existing organization to govern its invitations."
        />
      ) : phase.kind === "loading" ? (
        <p style={mutedStyle} data-testid="invite-governance-loading">
          Loading invitations…
        </p>
      ) : phase.kind === "denied" ? (
        <Card
          variant="status"
          tone="risk"
          padding="comfortable"
          data-testid="invite-governance-denied"
 >
          <strong style={{ fontSize: 14 }}>{phase.title}</strong>
          <p style={{ ...mutedStyle, marginTop: 6, marginBottom: 0, maxWidth: 620 }}>
            {phase.detail}
          </p>
        </Card>
      ) : phase.kind === "error" ? (
        <Card
          variant="status"
          tone="risk"
          padding="comfortable"
          data-testid="invite-governance-error"
 >
          <strong style={{ fontSize: 14 }}>Invitations didn&apos;t load</strong>
          <p style={{ ...mutedStyle, marginTop: 6, marginBottom: 10 }}>
            {phase.detail}
          </p>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </Card>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
              marginBottom: 10,
            }}
 >
            <span style={mutedStyle} data-testid="invite-governance-count">
              {phase.totalPending} pending invitation
              {phase.totalPending === 1 ? "" : "s"}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <Button variant="secondary" size="sm" onClick={() => void load()}>
                Refresh
              </Button>
              <a
                href={`/organizations/${encodeURIComponent(trimmedOrgId)}`}
                style={{ textDecoration: "none" }}
                data-testid="invite-governance-open-org"
 >
                <Button variant="secondary" size="sm">
                  Open this organization
                </Button>
              </a>
            </div>
          </div>

          {freshAcceptUrl ? (
            <Card
              variant="status"
              tone="verified"
              padding="comfortable"
              style={{ marginBottom: 12 }}
              data-testid="invite-fresh-accept-url"
 >
              <strong style={{ fontSize: 13 }}>New acceptance link</strong>
              <p style={{ ...mutedStyle, marginTop: 6, marginBottom: 8 }}>
                Shown once. The previous link for this person no longer works.
              </p>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  readOnly
                  style={{ ...inputStyle, ...monoStyle, maxWidth: 480 }}
                  value={freshAcceptUrl.url}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    try {
                      if (typeof navigator !== "undefined" && navigator.clipboard) {
                        await navigator.clipboard.writeText(freshAcceptUrl.url);
                        setCopied(true);
                      }
                    } catch {
                      setCopied(false);
                    }
                  }}
 >
                  {copied ? "Copied" : "Copy link"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFreshAcceptUrl(null);
                    setCopied(false);
                  }}
 >
                  Dismiss
                </Button>
              </div>
            </Card>
          ) : null}

          <DataTable
            columns={columns}
            rows={phase.invites}
            getRowId={(i) => i.inviteId}
            ariaLabel="Pending organization invitations"
            emptyState={
              <EmptyState variant="inline"
                title="No pending invitations"
                purpose="Everyone invited to this organization has either accepted or had their invitation revoked or expired."
              />
            }
            rowActions={(i) => (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy === i.inviteId}
                  onClick={() => void resend(i)}
 >
                  Resend
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy === i.inviteId}
                  onClick={() => void revoke(i)}
 >
                  Revoke
                </Button>
              </div>
            )}
          />
          {/* `totalPending` is the server's own count of the pending queue,
              which the page received all along and never showed. */}
          <ResultCount
            shown={phase.invites.length}
            total={phase.totalPending}
            noun="pending invitation"
            data-testid="admin-provisioning-invites-count"
          />
        </>
      )}
    </Card>
  );
}
