"use client";

/**
 * PHASE 12 VERTICAL C — Security claim verification.
 *
 * Consumes two canonical operations that had no product consumer:
 *
 *   GET  /v1/trust/security-claims       — per-control documented /
 *                                          implemented / references-resolve
 *                                          verdict with a confidence band.
 *   POST /v1/trust/security-claims/scan  — re-run the checks.
 *
 * The confidence band is computed SERVER-SIDE. This surface renders the
 * verdict it was given and never derives, upgrades, or rounds one — a
 * security claim the platform cannot substantiate must read as
 * unsubstantiated here.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../../../../lib/api";
import { formatUserDateTime } from "../../../../../../../lib/date";
import { useTenantGuard } from "../../../../../../../lib/platform-context";
import { Button } from "../../../../../../../components/ui/Button";
import { Card } from "../../../../../../../components/ui/Card";
import { Badge } from "../../../../../../../components/ui/Badge";
import { EmptyState } from "../../../../../../../components/ui/EmptyState";
import {
  DataTable,
  type DataTableColumn,
} from "../../../../../../../components/ui/DataTable";
import {
  classifyTrustPhase,
  mutedStyle,
  type TrustFailure,
} from "./_shared";

type SecurityClaimCheck = {
  controlKey: string;
  documented: boolean;
  implemented: boolean;
  implementationReferencesOk: boolean;
  confidence: string;
  evidencePaths: string[];
  limitation: string | null;
  ownerUserId: string | null;
  lastVerifiedAtUtc: string;
};

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; checks: SecurityClaimCheck[] }
  | TrustFailure;

function confidenceTone(confidence: string): "verified" | "governance" | "risk" | "neutral" {
  const c = confidence.toUpperCase();
  if (c === "HIGH" || c === "VERIFIED") return "verified";
  if (c === "MEDIUM" || c === "PARTIAL") return "governance";
  if (c === "LOW" || c === "NONE" || c === "UNSUBSTANTIATED") return "risk";
  return "neutral";
}

export function SecurityClaimsSection() {
  const { stamp, isStale } = useTenantGuard();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const captured = stamp();
    setPhase({ kind: "loading" });
    try {
      const res = (await apiFetch("/v1/trust/security-claims", {
        method: "GET",
      })) as { checks?: SecurityClaimCheck[] };
      if (isStale(captured)) return;
      setPhase({ kind: "ready", checks: res.checks ?? [] });
    } catch (err) {
      if (isStale(captured)) return;
      setPhase(
        classifyTrustPhase(err, {
          deniedTitle: "You can't review security claims",
          deniedDetail:
            "Your role in this workspace does not allow reading the security-claim register. Nothing was loaded and nothing was changed.",
          errorMessage: "Could not load the security-claim register.",
        }),
      );
    }
  }, [stamp, isStale]);

  useEffect(() => {
    void load();
  }, [load]);

  const runScan = useCallback(async () => {
    const captured = stamp();
    setScanning(true);
    setNote(null);
    try {
      await apiFetch("/v1/trust/security-claims/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (isStale(captured)) return;
      setNote("Security claims re-checked.");
      await load();
    } catch (err) {
      if (isStale(captured)) return;
      const failure = classifyTrustPhase(err, {
        deniedTitle: "You can't re-check security claims",
        deniedDetail:
          "Re-checking security claims requires trust-governance management in this workspace.",
        errorMessage: "Could not re-check the security claims.",
      });
      setNote(failure.detail);
    } finally {
      setScanning(false);
    }
  }, [stamp, isStale, load]);

  const columns: DataTableColumn<SecurityClaimCheck>[] = [
    {
      key: "control",
      header: "Control",
      render: (c) => (
        <div style={{ fontSize: 12.5 }}>
          <div style={{ fontWeight: 600 }}>
            {c.controlKey.toLowerCase().replace(/_/g, " ")}
          </div>
          {c.limitation ? (
            <div style={mutedStyle}>{c.limitation}</div>
          ) : null}
        </div>
      ),
    },
    {
      key: "confidence",
      header: "How well substantiated",
      render: (c) => (
        <span data-claim-confidence={c.confidence}>
          <Badge tone={confidenceTone(c.confidence)} subtle>
            {c.confidence.toLowerCase()}
          </Badge>
        </span>
      ),
    },
    {
      key: "documented",
      header: "Written down",
      render: (c) => (
        <span style={mutedStyle}>{c.documented ? "Yes" : "Not yet"}</span>
      ),
    },
    {
      key: "implemented",
      header: "Built",
      render: (c) => (
        <span style={mutedStyle}>{c.implemented ? "Yes" : "Not yet"}</span>
      ),
    },
    {
      key: "refs",
      header: "Evidence resolves",
      render: (c) => (
        <span style={mutedStyle}>
          {c.implementationReferencesOk
            ? `${c.evidencePaths.length} reference${c.evidencePaths.length === 1 ? "" : "s"}`
            : "Some references missing"}
        </span>
      ),
    },
    {
      key: "checked",
      header: "Last checked",
      render: (c) => (
        <span style={mutedStyle}>{formatUserDateTime(c.lastVerifiedAtUtc)}</span>
      ),
    },
  ];

  return (
    <Card
      variant="admin"
      padding="comfortable"
      title="Security claims"
      data-testid="trust-security-claims"
    >
      <p style={{ ...mutedStyle, marginTop: 0, maxWidth: 720 }}>
        Each security control the Trust Center describes, and how strongly the
        platform can currently back it. The verdict is decided by the server
        from the control&apos;s own evidence — this page reports it, it does
        not grade it.
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
        <Button
          variant="primary"
          size="sm"
          loading={scanning}
          disabled={scanning}
          onClick={() => void runScan()}
          data-testid="trust-security-claims-scan"
        >
          Re-check claims
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={scanning}
          onClick={() => void load()}
        >
          Refresh
        </Button>
      </div>

      {note ? (
        <p style={{ ...mutedStyle, margin: "0 0 12px" }} data-testid="trust-security-claims-note">
          {note}
        </p>
      ) : null}

      {phase.kind === "loading" ? (
        <p style={mutedStyle} data-testid="trust-security-claims-loading">
          Reading the security-claim register…
        </p>
      ) : null}

      {phase.kind === "denied" ? (
        <Card
          variant="status"
          tone="risk"
          padding="comfortable"
          data-testid="trust-security-claims-denied"
        >
          <strong style={{ fontSize: 14 }}>{phase.title}</strong>
          <p style={{ ...mutedStyle, marginTop: 6, marginBottom: 0, maxWidth: 620 }}>
            {phase.detail}
          </p>
        </Card>
      ) : null}

      {phase.kind === "error" ? (
        <Card
          variant="status"
          tone="risk"
          padding="comfortable"
          data-testid="trust-security-claims-error"
        >
          <strong style={{ fontSize: 14 }}>That didn&apos;t load</strong>
          <p style={{ ...mutedStyle, marginTop: 6, marginBottom: 10 }}>{phase.detail}</p>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </Card>
      ) : null}

      {phase.kind === "ready" ? (
        <DataTable
          columns={columns}
          rows={phase.checks}
          getRowId={(c) => c.controlKey}
          density="compact"
          ariaLabel="Security claim verification"
          emptyState={
            <EmptyState
              compact
              title="No security claims checked yet"
              purpose="Run a check to record, per control, whether it is documented, built, and backed by evidence that still resolves."
            />
          }
        />
      ) : null}
    </Card>
  );
}
