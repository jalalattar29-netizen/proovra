"use client";

/**
 * Platform Control Center — Feature Usage / Adoption (item H).
 *
 * READ-ONLY platform-admin surface wrapped in the `platform.admin`
 * PageRouteGate. Adoption is DERIVED from real entity counts by the
 * /v1/admin/adoption endpoint. There is deliberately NO single fabricated
 * roll-up number — each capability row shows only what is honestly derivable
 * from its backing table. Capabilities with no backing model render "Not
 * measured" across every cell. Null cells render an em-dash. Errors surface
 * via toSafeUserError (the only sanctioned display path). Renders through the
 * shared PageShell only; no legacy marketing shell.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  PageShell,
  PageHeader,
  PageSection,
  DataTable,
  useToast,
} from "../../../../components/ui";
import type { DataTableColumn } from "../../../../components/ui";
import { Badge } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { ResultCount } from "../../../../components/ui/ResultCount";
import { Button } from "../../../../components/ui/Button";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { formatUserDateTime } from "../../../../lib/date";


type CapabilityAdoption = {
  key: string;
  label: string;
  source: string;
  enabled: number | null;
  used: boolean | null;
  neverUsed: boolean | null;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
  usageCount: number | null;
  measured: boolean;
  reason: string | null;
};

type AdoptionReport = {
  generatedAt: string;
  hasCompositeScore: false;
  capabilities: CapabilityAdoption[];
};

/** Muted "Not measured" cell — the single honest signal for absent data. */
function NotMeasured() {
  return <span style={{ color: "var(--ink-muted)" }}>Not measured</span>;
}

/** Muted em-dash for a genuinely null-but-measured cell. */
function Dash() {
  return <span style={{ color: "var(--ink-muted)" }}>—</span>;
}

function numberOrNull(value: number | null) {
  if (value == null) return null;
  return new Intl.NumberFormat().format(value);
}

export default function AdminAdoptionPage() {
  return (
    <PageRouteGate routeId="platform.adoption">
      <AdminAdoptionInner />
    </PageRouteGate>
  );
}

function AdminAdoptionInner() {
  const { addToast } = useToast();
  const [report, setReport] = useState<AdoptionReport | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data: AdoptionReport = await apiFetch("/v1/admin/adoption");
      setReport(data ?? null);
    } catch (err) {
      const message = toSafeUserError(err, {
        message: "We couldn't load the feature-adoption aggregate.",
      }).message;
      addToast(message, "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns = useMemo<DataTableColumn<CapabilityAdoption>[]>(
    () => [
      {
        key: "label",
        header: "Capability",
        render: (row) => (
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 650 }}>{row.label}</div>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--ink-muted)",
                marginTop: 2,
                overflowWrap: "anywhere",
              }}
            >
              {row.source}
            </div>
          </div>
        ),
      },
      {
        key: "enabled",
        header: "Enabled",
        align: "right",
        render: (row) => {
          if (!row.measured) return <NotMeasured />;
          const formatted = numberOrNull(row.enabled);
          return formatted ?? <Dash />;
        },
      },
      {
        key: "used",
        header: "Used",
        render: (row) => {
          if (!row.measured || row.used == null) return <NotMeasured />;
          return (
            <Badge tone={row.used ? "verified" : "neutral"} subtle>
              {row.used ? "Used" : "Not used"}
            </Badge>
          );
        },
      },
      {
        key: "neverUsed",
        header: "Never used",
        /* NEVER USED IS NOT A WARNING, AND IT IS NOT A SECOND COLUMN.
           This rendered an AMBER badge, and 15 of the 17 capabilities are
           unused in a fresh workspace — so the page read as fifteen cautions.
           Nothing is wrong: a capability nobody has reached for yet is a fact
           about adoption, which is what this page measures. Amber here is the
           same defect the phase removed from the Control Center's coloured
           zeros.

           It is also the same answer the column to its left already gives:
           "Used"/"Not used" beside "Never used" is one fact in two badges.
           This column now carries what the other cannot — WHETHER the
           distinction has ever been true, as plain neutral text. */
        render: (row) => {
          if (!row.measured || row.neverUsed == null) return <NotMeasured />;
          return row.neverUsed ? (
            <span className="adm-muted">Never</span>
          ) : (
            <Dash />
          );
        },
      },
      {
        key: "firstUsedAt",
        header: "First used",
        nowrap: true,
        render: (row) => {
          if (!row.measured) return <NotMeasured />;
          if (!row.firstUsedAt) return <Dash />;
          return (
            <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>
              {formatUserDateTime(row.firstUsedAt)}
            </span>
          );
        },
      },
      {
        key: "lastUsedAt",
        header: "Last used",
        nowrap: true,
        render: (row) => {
          if (!row.measured) return <NotMeasured />;
          if (!row.lastUsedAt) return <Dash />;
          return (
            <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>
              {formatUserDateTime(row.lastUsedAt)}
            </span>
          );
        },
      },
      {
        key: "usageCount",
        header: "Count",
        align: "right",
        render: (row) => {
          if (!row.measured) return <NotMeasured />;
          const formatted = numberOrNull(row.usageCount);
          return formatted ?? <Dash />;
        },
      },
    ],
    [],
  );

  return (
    <PageShell width="full" data-testid="admin-adoption">
      <PageHeader
        eyebrow="Platform admin"
        title="Feature usage / adoption"
        subtitle="Read-only feature adoption, DERIVED from real entity counts across every workspace. There is no adoption model in the platform, so no capability is rolled up into a single invented number — each row shows only what is honestly derivable from its backing table. Capabilities with no backing model are marked 'Not measured', never estimated."
        secondaryActions={
          <Button variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
        }
      />


      <PageSection
        title="Capability adoption"
        description="Each row is derived from a single real backing table. 'Enabled' counts orgs/teams/rows with the capability active; 'Used' / 'Count' come from live row counts. Absent signals show 'Not measured' — never estimated."
      >
        <DataTable
          ariaLabel="Feature adoption by capability"
          columns={columns}
          rows={report?.capabilities ?? []}
          getRowId={(row) => row.key}
          loading={loading}
          emptyState={
            <EmptyState variant="inline"
              framed
              title="No adoption data"
              purpose="Feature adoption is derived from live records. Once workspaces configure capabilities and capture evidence, each capability's real counts appear here. Nothing on this page is estimated."
              data-testid="admin-adoption-empty"
            />
          }
        />
        {/* One row per KNOWN capability — a compiled-in catalogue, not a
            growing table. Declared in scripts/admin-complete-lists.mjs and
            proved API-side, which is what earns the bare length here. */}
        <ResultCount
          shown={report?.capabilities.length ?? 0}
          complete
          noun="capability"
          pluralNoun="capabilities"
          loading={loading}
          data-testid="admin-adoption-count"
        />
      </PageSection>
    </PageShell>
  );
}
