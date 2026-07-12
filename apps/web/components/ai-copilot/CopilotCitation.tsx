"use client";

/**
 * Phase C4/D6 (UI) — Validated citation chip. Renders ONLY server-approved
 * citations (the backend already dropped invalid/stale/cross-tenant/invented
 * ones). Uses the server-generated `route` — never a model URL. If a route is
 * missing it renders as plain text ("source unavailable"), never a broken link.
 */
import Link from "next/link";

export type CopilotCitationData = {
  type: string;
  objectId: string;
  displayLabel: string;
  route: string;
  objectVersion: number | null;
};

const TYPE_LABEL: Record<string, string> = {
  EVIDENCE_RECORD: "Evidence",
  CASE: "Case",
  CUSTODY_EVENT: "Custody",
  VERIFICATION_SIGNAL: "Signal",
  REVIEW_ASSIGNMENT: "Assignment",
  REVIEW_DECISION: "Decision",
  REPORT: "Report",
  VERIFICATION_PACKAGE: "Package",
  POLICY: "Policy",
  WORKFLOW_STATUS: "Workflow",
};

const SAFE_ROUTE = /^\/[a-z0-9/_:.[\]-]*$/i;

export function CopilotCitation({ citation }: { citation: CopilotCitationData }) {
  const typeLabel = TYPE_LABEL[citation.type] ?? "Source";
  const label =
    citation.displayLabel +
    (citation.objectVersion != null ? ` · v${citation.objectVersion}` : "");
  const linkable = Boolean(citation.route) && SAFE_ROUTE.test(citation.route);

  const inner = (
    <span className="app-chip" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <span className="app-chip__tag" style={{ fontWeight: 600, opacity: 0.7 }}>{typeLabel}</span>
      <span>{label}</span>
    </span>
  );

  if (!linkable) {
    return (
      <span title="Source no longer available" style={{ opacity: 0.6 }}>
        {inner}
      </span>
    );
  }
  return (
    <Link href={citation.route} className="app-link" title={`View ${typeLabel} source`}>
      {inner}
    </Link>
  );
}

export function CopilotCitationList({ citations }: { citations: CopilotCitationData[] }) {
  if (!citations || citations.length === 0) {
    return <span style={{ opacity: 0.6, fontSize: 12 }}>No validated sources.</span>;
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {citations.map((c) => (
        <CopilotCitation key={`${c.type}:${c.objectId}:${c.objectVersion ?? ""}`} citation={c} />
      ))}
    </div>
  );
}
