"use client";

/**
 * Phase 8 Enterprise Production Readiness — SCOPE A (Bulk Invite) +
 * SCOPE B (CSV Import). Org admin / Bulk invite tab.
 *
 * Paste emails OR upload a CSV, pick a default role, PREVIEW (dry-run
 * against /validate — creates nothing) to see per-row outcomes + a seat
 * preview, then SEND INVITES (execute) with a truthful partial-success
 * summary. "Resend failed" re-sends the batch's still-pending invites.
 *
 * Backend (services/api/src/routes/organizations-bulk-invite.routes.ts):
 *   POST /v1/orgs/:id/invites/bulk/validate   — dry run.
 *   POST /v1/orgs/:id/invites/bulk            — execute.
 *   POST /v1/orgs/:id/invites/bulk/resend     — resend pending in a batch.
 *   GET  /v1/orgs/:id/invites/csv-template    — CSV template download.
 *   POST /v1/orgs/:id/invites/csv             — CSV parse → dry-run/execute.
 *
 * Bulk invite creates ONLY org membership/role state (never evidence
 * access). Gating: backend enforces ORG_ADMIN+; the web surface is
 * ENTERPRISE-tier (/organizations path prefix) and org-membership gated by
 * the admin shell + PageRouteGate.
 *
 * Constitutional checks satisfied:
 *   - Wrapped in <PageRouteGate routeId="account.organization_admin_bulk_invite">.
 *   - toSafeUserError / notifyApiError is the ONLY error-display path.
 *   - Shared design system (PageSection / DataTable + Card / Button / Badge).
 *   - Strong TypeScript types throughout.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../../../lib/api";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";
import { notifyApiError } from "../../../../../../lib/feedback/notify";
import { useToast } from "../../../../../../components/ui";
import { PageSection, DataTable } from "../../../../../../components/ui";
import type { DataTableColumn } from "../../../../../../components/ui";
import { Card } from "../../../../../../components/ui/Card";
import { Badge } from "../../../../../../components/ui/Badge";
import { Button } from "../../../../../../components/ui/Button";
import { EmptyState } from "../../../../../../components/ui/EmptyState";
import {
  ALL_ORG_ROLES,
  ORG_ROLE_LABEL,
  type OrgRole,
} from "../_lib/orgRoles";

// ---------------------------------------------------------------------------
// Wire types — mirror organizations-bulk-invite.routes.ts.
// ---------------------------------------------------------------------------

type SeatPreview = {
  used: number;
  included: number;
  afterInvite: number;
  hasSeatCap: boolean;
};

type TruncationNote = {
  received: number;
  accepted: number;
  note: string;
} | null;

type ValidateRow = {
  line: number | null;
  email: string;
  role: OrgRole;
  outcome: string;
  reason: string | null;
};

type ExecuteRow = ValidateRow & { inviteId: string | null };

type ValidateResponse = {
  organizationId: string;
  dryRun: true;
  summary: Record<string, number>;
  seatPreview: SeatPreview;
  truncated: TruncationNote;
  rows: ValidateRow[];
};

type ExecuteResponse = {
  organizationId: string;
  batchId: string;
  dryRun: false;
  summary: Record<string, number>;
  seatPreview: SeatPreview;
  truncated: TruncationNote;
  rows: ExecuteRow[];
};

type ResendResponse = {
  organizationId: string;
  batchId: string | null;
  summary: Record<string, number>;
  rows: Array<{ inviteId: string; outcome: string; reason: string | null }>;
};

// ---------------------------------------------------------------------------
// Outcome → badge tone (honest colouring: green invite, red hard-fail,
// amber policy/seat, neutral duplicate/skip).
// ---------------------------------------------------------------------------
function outcomeTone(
  outcome: string,
): "verified" | "risk" | "pending" | "neutral" {
  switch (outcome) {
    case "WOULD_INVITE":
    case "INVITED":
    case "RESENT":
      return "verified";
    case "INVALID_EMAIL":
    case "FAILED":
      return "risk";
    case "ROLE_TOO_HIGH":
    case "DOMAIN_NOT_ALLOWED":
    case "SEAT_LIMIT_EXCEEDED":
      return "pending";
    default:
      return "neutral";
  }
}

// ---------------------------------------------------------------------------
// Parse a pasted textarea into {email, role?} rows. One entry per line;
// `email,role` or `email role` tolerated. Role validation happens server-side.
// ---------------------------------------------------------------------------
function parsePasted(text: string): Array<{ email: string; role?: string }> {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((line) => {
      const parts = line.split(/[,\s]+/).filter(Boolean);
      return { email: parts[0] ?? "", role: parts[1] };
    })
    .filter((r) => r.email.length > 0);
}

const inputStyle = {
  display: "block",
  width: "100%",
  minHeight: 40,
  padding: "0 12px",
  fontSize: 13.5,
  color: "var(--ink-primary, #0f172a)",
  background: "var(--surface-card, #ffffff)",
  border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
  borderRadius: "var(--radius-md, 8px)",
  outline: "none",
} as const;

const subtleText = { fontSize: 12.5, color: "var(--ink-muted, #94a3b8)" } as const;

export default function OrganizationAdminBulkInvitePage() {
  return (
    <PageRouteGate routeId="account.organization_admin_bulk_invite">
      <BulkInviteTab />
    </PageRouteGate>
  );
}

function BulkInviteTab() {
  const params = useParams<{ id: string }>();
  const orgId = params?.id ?? "";
  const { addToast } = useToast();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [pasted, setPasted] = useState("");
  const [csvText, setCsvText] = useState<string | null>(null);
  const [csvName, setCsvName] = useState<string | null>(null);
  const [defaultRole, setDefaultRole] = useState<OrgRole>("ORG_MEMBER");

  const [busy, setBusy] = useState<"preview" | "send" | "resend" | null>(null);
  const [preview, setPreview] = useState<ValidateResponse | null>(null);
  const [result, setResult] = useState<ExecuteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Rows currently entered (paste OR csv-derived count for the CTA state).
  const pastedRows = useMemo(() => parsePasted(pasted), [pasted]);
  const hasInput = csvText !== null ? true : pastedRows.length > 0;

  const buildBody = useCallback(() => {
    if (csvText !== null) {
      return { mode: "csv" as const, csv: csvText, defaultRole };
    }
    return { mode: "rows" as const, rows: pastedRows, defaultRole };
  }, [csvText, pastedRows, defaultRole]);

  const runPreview = useCallback(async () => {
    setBusy("preview");
    setError(null);
    setResult(null);
    try {
      const body = buildBody();
      const data =
        body.mode === "csv"
          ? ((await apiFetch(`/v1/orgs/${orgId}/invites/csv?dryRun=1`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ csv: body.csv, defaultRole: body.defaultRole }),
            })) as ValidateResponse)
          : ((await apiFetch(`/v1/orgs/${orgId}/invites/bulk/validate`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ rows: body.rows, defaultRole: body.defaultRole }),
            })) as ValidateResponse);
      setPreview(data);
    } catch (err) {
      const safe = toSafeUserError(err, { message: "Failed to preview invites." });
      setError(safe.message);
      notifyApiError(addToast, err, { message: "Failed to preview invites." });
    } finally {
      setBusy(null);
    }
  }, [orgId, buildBody, addToast]);

  const runSend = useCallback(async () => {
    setBusy("send");
    setError(null);
    try {
      const body = buildBody();
      const data =
        body.mode === "csv"
          ? ((await apiFetch(`/v1/orgs/${orgId}/invites/csv`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ csv: body.csv, defaultRole: body.defaultRole }),
            })) as ExecuteResponse)
          : ((await apiFetch(`/v1/orgs/${orgId}/invites/bulk`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ rows: body.rows, defaultRole: body.defaultRole }),
            })) as ExecuteResponse);
      setResult(data);
      setPreview(null);
      const invited = data.summary.INVITED ?? 0;
      addToast(
        `Sent ${invited} invite${invited === 1 ? "" : "s"}.`,
        "success",
      );
    } catch (err) {
      const safe = toSafeUserError(err, { message: "Failed to send invites." });
      setError(safe.message);
      notifyApiError(addToast, err, { message: "Failed to send invites." });
    } finally {
      setBusy(null);
    }
  }, [orgId, buildBody, addToast]);

  const runResend = useCallback(async () => {
    if (!result?.batchId) return;
    setBusy("resend");
    setError(null);
    try {
      const data = (await apiFetch(`/v1/orgs/${orgId}/invites/bulk/resend`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchId: result.batchId }),
      })) as ResendResponse;
      const resent = data.summary.RESENT ?? 0;
      addToast(
        `Resent ${resent} pending invite${resent === 1 ? "" : "s"}.`,
        "success",
      );
    } catch (err) {
      const safe = toSafeUserError(err, { message: "Failed to resend invites." });
      setError(safe.message);
      notifyApiError(addToast, err, { message: "Failed to resend invites." });
    } finally {
      setBusy(null);
    }
  }, [orgId, result, addToast]);

  const downloadTemplate = useCallback(() => {
    // The backend also serves this at GET /v1/orgs/:id/invites/csv-template
    // (text/csv attachment); apiFetch only decodes JSON, so we emit the
    // identical template client-side to avoid a raw-fetch detour.
    triggerDownload(STATIC_TEMPLATE);
  }, []);

  const onFile = useCallback((file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCsvText(String(reader.result ?? ""));
      setCsvName(file.name);
      setPasted("");
      setPreview(null);
      setResult(null);
    };
    reader.readAsText(file);
  }, []);

  const clearCsv = useCallback(() => {
    setCsvText(null);
    setCsvName(null);
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  const previewColumns: DataTableColumn<ValidateRow>[] = useMemo(
    () => [
      { key: "line", header: "Line", render: (r) => r.line ?? "—" },
      { key: "email", header: "Email", render: (r) => r.email || "(blank)" },
      { key: "role", header: "Role", render: (r) => ORG_ROLE_LABEL[r.role] ?? r.role },
      {
        key: "outcome",
        header: "Outcome",
        render: (r) => (
          <Badge tone={outcomeTone(r.outcome)} subtle>
            {r.outcome}
          </Badge>
        ),
      },
      { key: "reason", header: "Detail", render: (r) => r.reason ?? "" },
    ],
    [],
  );

  const resultColumns: DataTableColumn<ExecuteRow>[] = useMemo(
    () => [
      { key: "line", header: "Line", render: (r) => r.line ?? "—" },
      { key: "email", header: "Email", render: (r) => r.email || "(blank)" },
      { key: "role", header: "Role", render: (r) => ORG_ROLE_LABEL[r.role] ?? r.role },
      {
        key: "outcome",
        header: "Outcome",
        render: (r) => (
          <Badge tone={outcomeTone(r.outcome)} subtle>
            {r.outcome}
          </Badge>
        ),
      },
      { key: "reason", header: "Detail", render: (r) => r.reason ?? "" },
    ],
    [],
  );

  const active = preview ?? result;

  return (
    <section
      data-testid="org-admin-bulk-invite"
      data-org-id={orgId}
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
      {/* ------------------- INPUT ------------------- */}
      <Card
        variant="summary"
        title="Bulk invite members"
        subtitle="Paste emails or upload a CSV, choose a default role, preview the per-row outcome, then send. Bulk invite grants organization membership only — never evidence access."
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-secondary, #475569)" }}>
            Paste emails (one per line; optional <code>,ROLE</code>)
            <textarea
              value={pasted}
              onChange={(e) => {
                setPasted(e.target.value);
                if (csvText !== null) clearCsv();
                setPreview(null);
                setResult(null);
              }}
              disabled={busy !== null || csvText !== null}
              placeholder={"alice@example.com\nbob@example.com,ORG_AUDITOR"}
              data-testid="bulk-invite-paste"
              rows={6}
              style={{ ...inputStyle, minHeight: 120, padding: 12, fontFamily: "monospace" }}
            />
          </label>

          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => onFile(e.target.files?.[0] ?? null)}
              disabled={busy !== null}
              data-testid="bulk-invite-csv-file"
              style={{ fontSize: 13 }}
            />
            {csvName ? (
              <span style={subtleText} data-testid="bulk-invite-csv-name">
                {csvName}{" "}
                <button
                  type="button"
                  onClick={clearCsv}
                  style={{ border: "none", background: "none", color: "var(--accent, #2563eb)", cursor: "pointer", fontSize: 12 }}
                >
                  clear
                </button>
              </span>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => downloadTemplate()}
              data-testid="bulk-invite-download-template"
            >
              Download CSV template
            </Button>
          </div>

          <div style={{ display: "flex", alignItems: "end", gap: 12, flexWrap: "wrap" }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-secondary, #475569)" }}>
              Default role
              <select
                value={defaultRole}
                onChange={(e) => setDefaultRole(e.target.value as OrgRole)}
                disabled={busy !== null}
                data-testid="bulk-invite-default-role"
                style={{ ...inputStyle, width: 220, cursor: "pointer" }}
              >
                {ALL_ORG_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ORG_ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void runPreview()}
              disabled={busy !== null || !hasInput}
              loading={busy === "preview"}
              data-testid="bulk-invite-preview"
            >
              Preview
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => void runSend()}
              disabled={busy !== null || !hasInput}
              loading={busy === "send"}
              data-testid="bulk-invite-send"
            >
              Send invites
            </Button>
          </div>

          {error ? (
            <div
              role="alert"
              data-state="error"
              style={{
                padding: "8px 12px",
                border: "1px solid var(--status-risk-border, #fecaca)",
                background: "var(--status-risk-bg, #fef2f2)",
                color: "var(--status-risk-fg, #991b1b)",
                borderRadius: 8,
                fontSize: 13,
              }}
            >
              {error}
            </div>
          ) : null}
        </div>
      </Card>

      {/* ------------------- SEAT + SUMMARY ------------------- */}
      {active ? (
        <Card variant="admin" padding="compact" data-testid="bulk-invite-summary">
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center" }}>
            {active.seatPreview.hasSeatCap ? (
              <div style={{ fontSize: 13, color: "var(--ink-secondary, #475569)" }} data-testid="bulk-invite-seat-preview">
                Seats: <strong>{active.seatPreview.used}</strong> used /{" "}
                <strong>{active.seatPreview.included}</strong> included ·{" "}
                after invite <strong>{active.seatPreview.afterInvite}</strong>
              </div>
            ) : (
              <div style={subtleText}>No seat cap configured for this org.</div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {Object.entries(active.summary).map(([outcome, count]) => (
                <Badge key={outcome} tone={outcomeTone(outcome)} subtle>
                  {outcome}: {count}
                </Badge>
              ))}
            </div>
          </div>
          {active.truncated ? (
            <div
              role="alert"
              data-testid="bulk-invite-truncation"
              style={{ marginTop: 10, fontSize: 12.5, color: "var(--status-warn-fg, #92400e)" }}
            >
              {active.truncated.note}
            </div>
          ) : null}
          {result?.batchId ? (
            <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center" }}>
              <span style={subtleText}>Batch {result.batchId}</span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void runResend()}
                loading={busy === "resend"}
                disabled={busy !== null}
                data-testid="bulk-invite-resend-failed"
              >
                Resend failed
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* ------------------- PER-ROW OUTCOMES ------------------- */}
      {preview ? (
        <PageSection title="Preview (dry run — nothing was created)">
          <div data-testid="bulk-invite-preview-table">
            <DataTable
              ariaLabel="Bulk invite preview"
              columns={previewColumns}
              rows={preview.rows}
              getRowId={(r, i) => `${r.email}-${i}`}
              emptyState={<EmptyState title="No rows to invite" purpose="Add emails or upload a CSV." />}
            />
          </div>
        </PageSection>
      ) : null}

      {result ? (
        <PageSection title="Results">
          <div data-testid="bulk-invite-result-table">
            <DataTable
              ariaLabel="Bulk invite results"
              columns={resultColumns}
              rows={result.rows}
              getRowId={(r, i) => `${r.email}-${i}`}
              emptyState={<EmptyState title="No rows processed" purpose="Nothing to send." />}
            />
          </div>
        </PageSection>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Client-side static CSV template fallback (kept in lock-step with the
// backend GET /v1/orgs/:id/invites/csv-template body).
// ---------------------------------------------------------------------------
const STATIC_TEMPLATE =
  "email,role\r\nalice@example.com,ORG_MEMBER\r\nbob@example.com,ORG_AUDITOR\r\n";

function triggerDownload(csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "proovra-bulk-invite-template.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
