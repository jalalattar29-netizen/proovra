"use client";

/**
 * Phase C4/D6 (UI) — Validated citation chip. Renders ONLY server-approved
 * citations (the backend already dropped invalid/stale/cross-tenant/invented
 * ones). Uses the server-generated `route` — never a model URL. If a route is
 * missing it renders as plain text ("source unavailable"), never a broken link.
 *
 * PRESENTATION AUTHORITY. This component is shared by four copilot surfaces
 * (evidence detail, case, reviewer ops, operations intelligence), so its
 * styling lives in the shared `app-primitives.css` authority as
 * `.app-copilot-citation*` — never in a route stylesheet, which would leave
 * the other three consumers unstyled. No inline style remains here: every
 * declaration was static, so none of it needed to be computed in JS.
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
    <span className="app-chip app-copilot-citation">
      <span className="app-chip__tag app-copilot-citation__type">{typeLabel}</span>
      <span className="app-copilot-citation__label">{label}</span>
    </span>
  );

  if (!linkable) {
    return (
      <span title="Source no longer available" className="app-copilot-citation--unavailable">
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
    return <span className="app-copilot-citation-empty">No validated sources.</span>;
  }
  return (
    <div className="app-copilot-citation-list">
      {citations.map((c) => (
        <CopilotCitation key={`${c.type}:${c.objectId}:${c.objectVersion ?? ""}`} citation={c} />
      ))}
    </div>
  );
}
