"use client";

/**
 * Phase B — Workflow Templates Center.
 *
 * Phase 0 audit confirmed this page used to advertise itself as an
 * operational workflows list with four count tiles and an instance
 * list, but Phase 22 had no producer wired in this workspace so the
 * tiles always read zero and the list was always empty. Phase B
 * reframes the surface to match what it actually administers: the
 * EvidenceWorkflowTemplate catalog (in-code seed templates plus
 * workspace overrides persisted via the workflow-template service).
 * Reviewer-side execution lives in Reviewer Operations; this page is
 * the template administration view.
 *
 * Hard invariants:
 *   - No call to the instances surface — the Phase 0 audit confirmed
 *     it has zero producers in this workspace.
 *   - No new template metadata fields are invented. The render
 *     iterates only over keys actually projected by
 *     listEffectiveWorkflowTemplates.
 *   - Non-admins see a brief explainer instead of the editor list, to
 *     match the administration-only register the page now uses.
 *
 * Phase D — surface metadata that already exists on the API
 * projection. The `/v1/workflows/templates` alias now returns the
 * canonical `projectEffectiveWorkflowTemplate` shape so the page can
 * render every field the underlying WorkflowTemplate schema already
 * carries. No new API capability, no new schema column, no extension
 * of the in-code seed catalog.
 *
 * Phase D — projected fields rendered:
 *   - slug, version, name, description, source, workspaceCategory,
 *     intakeModes, requiredStepCount/stepCount  (already rendered)
 *   - archived            -> "Active" / "Archived" status pill
 *   - planMode            -> chip in identity row
 *   - locationRequirement -> chip in identity row
 *   - allowedRoles        -> chips, or "any role" when null/empty
 *   - steps[]             -> compact list: title, purposeLabel,
 *                            acceptedKinds, required flag
 *   - rules[]             -> count chip ("N rules") when present
 *
 * Phase D — fields the task brief asked about that are NOT in the
 * EvidenceWorkflowTemplate projection (so deferred — never invented):
 *   - defaultRetentionPolicy        — not present on
 *                                     WorkflowTemplateSchema. The
 *                                     workflow-template.service.ts
 *                                     persist input has a separate
 *                                     visibilityPolicy/reviewPolicy/
 *                                     exportPolicy triple, but those
 *                                     are NOT projected back through
 *                                     projectEffectiveWorkflowTemplate.
 *   - defaultReviewerRequirements   — same as above; reviewPolicyJson
 *                                     is persisted but not returned.
 *   - sectorPolicy                  — does not exist on the schema.
 *   - defaultIntakeMode             — only the ARRAY `intakeModes`
 *                                     exists; there is no "default"
 *                                     marker on any single mode.
 *   - archivedAt                    — only the `archived: boolean`
 *                                     exists; no timestamp.
 *   - createdAt / updatedAt         — present on the DB row but NOT
 *                                     part of projectEffectiveWorkflowTemplate.
 * Extending the API or schema to surface any of these is explicitly
 * out of scope for this phase.
 */

import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../lib/api";
import { useTeamId, useActiveSpace } from "../../../lib/platform-context";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";

// Mirrors the projectEffectiveWorkflowTemplate shape returned by
// /v1/workflows/templates (Phase D). All optional fields default to
// null/empty in the projection — the page tolerates either form.
type TemplateStep = {
  id: string;
  title: string;
  description: string;
  purposeLabel: string;
  required: boolean;
  acceptedKinds: string[];
};
type TemplateSummary = {
  id: string;
  dbId: string | null;
  slug: string;
  version: number;
  name: string;
  description: string | null;
  workspaceCategory: string | null;
  locationRequirement: string;
  planMode: string;
  intakeModes: string[];
  allowedRoles: string[] | null;
  archived: boolean;
  steps: TemplateStep[];
  rules: unknown[];
  requiredStepCount: number;
  stepCount: number;
  source: string;
};

const SECTORS: ReadonlyArray<string> = [
  "GENERAL",
  "INSURANCE",
  "LEGAL",
  "JOURNALISM",
  "INVESTIGATIONS",
  "COMPLIANCE",
  "FIELD_OPERATIONS",
  "RESEARCH",
  "OTHER",
];

// Phase 38.10 — wrap in canonical PageRouteGate.
export default function WorkflowsTemplatesPage() {
  return (
    <PageRouteGate routeId="workspace.workflows">
      <WorkflowsTemplatesPageInner />
    </PageRouteGate>
  );
}

function WorkflowsTemplatesPageInner() {
  const teamId = useTeamId();
  const activeSpace = useActiveSpace();
  // Match the integrations page admin gate: OWNER/ADMIN inside an
  // organization, or anyone inside a personal space (single-occupant).
  const isAdmin =
    activeSpace?.type === "ORGANIZATION"
      ? activeSpace.roleLabel === "OWNER" ||
        activeSpace.roleLabel === "ADMIN"
      : activeSpace?.type === "PERSONAL";

  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [sector, setSector] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId || !isAdmin) return;
    let cancelled = false;
    const templatesQs = new URLSearchParams();
    templatesQs.set("teamId", teamId);
    if (sector) templatesQs.set("sector", sector);
    templatesQs.set("limit", "50");
    apiFetch(
      `/v1/workflows/templates?${templatesQs.toString()}`,
      { method: "GET" },
    )
      .then((t: { templates: TemplateSummary[] }) => {
        if (cancelled) return;
        setTemplates(t.templates ?? []);
        setError(null);
      })
      .catch((err: { message?: string }) => {
        if (cancelled) return;
        // Non-blocking error banner; still render the page chrome so
        // the operator can retry by changing the sector filter.
        setTemplates([]);
        setError(err?.message ?? "Could not load workflow templates.");
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, sector, isAdmin]);

  const sectorOptions = useMemo(() => SECTORS, []);

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={titleStyle}>Workflow Templates</h1>
        <p style={mutedStyle}>
          Reviewer workflow execution is managed in Reviewer Operations.
          This page administers the templates used when teams capture
          evidence. Templates combine platform seeds with workspace
          overrides; non-admins do not see the editor list.
        </p>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {!teamId ? (
        <p style={mutedStyle}>Switch to a workspace to view templates.</p>
      ) : !isAdmin ? (
        <p style={mutedStyle}>
          Workflow templates are managed by workspace administrators.
        </p>
      ) : (
        <section style={cardStyle}>
          <div style={cardHeaderStyle}>
            <h2 style={sectionTitleStyle}>Templates</h2>
            <div style={{ display: "flex", gap: 8 }}>
              <select
                value={sector}
                onChange={(e) => setSector(e.target.value)}
                style={selectStyle}
              >
                <option value="">All sectors</option>
                {sectorOptions.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {templates === null ? (
            <p style={mutedStyle}>Loading…</p>
          ) : templates.length === 0 ? (
            <p style={mutedStyle}>
              No templates match this sector. Templates are administered
              by platform owners and your workspace may not have local
              overrides yet.
            </p>
          ) : (
            <ul style={listStyle} data-testid="workflow-templates-list">
              {templates.map((t) => (
                <li
                  key={`${t.slug}-v${t.version}`}
                  style={rowStyle}
                  data-testid={`workflow-template-row-${t.slug}`}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={identityRowStyle}>
                      <span
                        style={{ fontWeight: 600 }}
                        data-testid={`workflow-template-name-${t.slug}`}
                      >
                        {t.name}
                      </span>
                      <span
                        style={chipStyle}
                        data-testid={`workflow-template-slug-${t.slug}`}
                      >
                        {t.slug}
                      </span>
                      <span
                        style={chipStyle}
                        data-testid={`workflow-template-version-${t.slug}`}
                      >
                        v{t.version}
                      </span>
                      <span
                        style={sourceChipStyle(t.source)}
                        data-testid={`workflow-template-source-${t.slug}`}
                      >
                        {t.source}
                      </span>
                      <span
                        style={statusChipStyle(t.archived)}
                        data-testid={`workflow-template-status-${t.slug}`}
                      >
                        {t.archived ? "Archived" : "Active"}
                      </span>
                    </div>
                    <div
                      style={mutedStyle}
                      data-testid={`workflow-template-description-${t.slug}`}
                    >
                      {t.description ?? "No description."}
                    </div>
                    <div style={mutedStyle}>
                      <span
                        data-testid={`workflow-template-step-counts-${t.slug}`}
                      >
                        {t.requiredStepCount}/{t.stepCount} required steps
                      </span>{" "}
                      ·{" "}
                      <span
                        data-testid={`workflow-template-sector-${t.slug}`}
                      >
                        sector {t.workspaceCategory ?? "unspecified"}
                      </span>{" "}
                      ·{" "}
                      <span
                        data-testid={`workflow-template-intake-modes-${t.slug}`}
                      >
                        intake{" "}
                        {t.intakeModes.length > 0
                          ? t.intakeModes.join(", ")
                          : "—"}
                      </span>
                    </div>
                    <div style={metaRowStyle}>
                      <span
                        style={metaChipStyle}
                        data-testid={`workflow-template-plan-mode-${t.slug}`}
                      >
                        plan {t.planMode}
                      </span>
                      <span
                        style={metaChipStyle}
                        data-testid={`workflow-template-location-${t.slug}`}
                      >
                        location {t.locationRequirement}
                      </span>
                      <span
                        style={metaChipStyle}
                        data-testid={`workflow-template-allowed-roles-${t.slug}`}
                      >
                        roles{" "}
                        {t.allowedRoles && t.allowedRoles.length > 0
                          ? t.allowedRoles.join(", ")
                          : "any role"}
                      </span>
                      {Array.isArray(t.rules) && t.rules.length > 0 ? (
                        <span
                          style={metaChipStyle}
                          data-testid={`workflow-template-rule-count-${t.slug}`}
                        >
                          {t.rules.length} rule
                          {t.rules.length === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </div>
                    {Array.isArray(t.steps) && t.steps.length > 0 ? (
                      <ol
                        style={stepListStyle}
                        data-testid={`workflow-template-steps-${t.slug}`}
                      >
                        {t.steps.map((step, idx) => (
                          <li
                            key={step.id ?? idx}
                            style={stepRowStyle}
                            data-testid={`workflow-template-step-${t.slug}-${step.id ?? idx}`}
                          >
                            <span style={stepIndexStyle}>{idx + 1}.</span>
                            <span style={stepTitleStyle}>{step.title}</span>
                            <span style={stepPurposeStyle}>
                              {step.purposeLabel}
                            </span>
                            {step.required ? (
                              <span style={stepRequiredStyle}>required</span>
                            ) : (
                              <span style={stepOptionalStyle}>optional</span>
                            )}
                            {Array.isArray(step.acceptedKinds) &&
                            step.acceptedKinds.length > 0 ? (
                              <span style={stepKindsStyle}>
                                {step.acceptedKinds.join(" / ")}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ol>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}

function sourceChipStyle(source: string): React.CSSProperties {
  // Workspace overrides are highlighted so admins can tell at a glance
  // whether a row is the in-code seed or a local edit.
  const isWorkspace = source === "workspace_db";
  return {
    padding: "2px 6px",
    fontSize: 10,
    fontWeight: 600,
    borderRadius: 999,
    background: isWorkspace ? "#ecfdf5" : "#f1f5f9",
    color: isWorkspace ? "#065f46" : "#334155",
    border: isWorkspace ? "1px solid #6ee7b7" : "1px solid #cbd5e1",
    marginLeft: 6,
  };
}

function statusChipStyle(archived: boolean): React.CSSProperties {
  return {
    padding: "2px 6px",
    fontSize: 10,
    fontWeight: 600,
    borderRadius: 999,
    background: archived ? "#fef2f2" : "#ecfdf5",
    color: archived ? "#7f1d1d" : "#065f46",
    border: archived ? "1px solid #fecaca" : "1px solid #6ee7b7",
    marginLeft: 6,
  };
}

const pageStyle: React.CSSProperties = {
  maxWidth: 1040,
  margin: "0 auto",
  padding: "32px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
};
const titleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  marginBottom: 4,
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginBottom: 12,
};
const mutedStyle: React.CSSProperties = { fontSize: 13, color: "#64748b" };
const cardStyle: React.CSSProperties = {
  marginTop: 24,
  padding: 20,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
};
const cardHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
  marginBottom: 12,
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  padding: "12px 8px",
  borderBottom: "1px solid #e2e8f0",
};
const identityRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 0,
};
const metaRowStyle: React.CSSProperties = {
  marginTop: 6,
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
};
const metaChipStyle: React.CSSProperties = {
  padding: "2px 6px",
  fontSize: 10,
  fontWeight: 600,
  borderRadius: 999,
  background: "#f8fafc",
  color: "#334155",
  border: "1px solid #e2e8f0",
};
const chipStyle: React.CSSProperties = {
  padding: "2px 6px",
  fontSize: 10,
  fontWeight: 600,
  borderRadius: 999,
  background: "#eff6ff",
  color: "#1e40af",
  border: "1px solid #93c5fd",
  marginLeft: 6,
};
const errorBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 8,
  fontSize: 14,
};
const selectStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 13,
  background: "#fff",
  color: "#0f172a",
};
const stepListStyle: React.CSSProperties = {
  marginTop: 8,
  padding: "8px 12px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  listStyle: "none",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};
const stepRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  alignItems: "baseline",
  fontSize: 12,
  color: "#0f172a",
};
const stepIndexStyle: React.CSSProperties = {
  fontWeight: 600,
  color: "#475569",
  minWidth: 18,
};
const stepTitleStyle: React.CSSProperties = {
  fontWeight: 600,
};
const stepPurposeStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#64748b",
};
const stepRequiredStyle: React.CSSProperties = {
  padding: "1px 5px",
  fontSize: 10,
  fontWeight: 600,
  borderRadius: 999,
  background: "#eff6ff",
  color: "#1e40af",
  border: "1px solid #93c5fd",
};
const stepOptionalStyle: React.CSSProperties = {
  padding: "1px 5px",
  fontSize: 10,
  fontWeight: 600,
  borderRadius: 999,
  background: "#f1f5f9",
  color: "#475569",
  border: "1px solid #cbd5e1",
};
const stepKindsStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "#475569",
  background: "#f8fafc",
  border: "1px dashed #cbd5e1",
  padding: "1px 5px",
  borderRadius: 6,
};
