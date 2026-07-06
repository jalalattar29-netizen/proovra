"use client";

/**
 * PHASE 38-CLOSURE — Persona onboarding wizard.
 *
 * Renders at /settings/persona. A 4-step wizard that updates the
 * `WorkspacePersonaProfile` for the active workspace via the canonical
 * mutation route `PATCH /v1/workspaces/:teamId/persona`.
 *
 * Hard rules:
 *
 *   1. The wizard NEVER creates a workspace. The active workspace is
 *      whatever `activeSpace` already points at.
 *   2. The wizard NEVER changes capabilities. The mutation route only
 *      updates UX preferences.
 *   3. Cancel / dismiss is always possible. The wizard does NOT block
 *      the user from using the product.
 *   4. Partial state persists. If the user closes the page mid-wizard,
 *      the next visit resumes from the same step.
 */

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useCallback, useMemo, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import {
  useActiveSpace,
  usePersonaProfile,
  usePlatformContext,
  workflowFromPersona,
  WORKSPACE_PERSONA_PROFILES,
  type WorkspacePersonaProfile,
} from "../../../../lib/platform-context";
import {
  emit as emitStateEvent,
  redactWorkspaceId,
} from "../../../../lib/platform-context/state-observability";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { WorkspacePersonaProfileCard } from "../../../../components/hidden-feature-panels/HiddenFeaturePanels";

type WizardStep = 1 | 2 | 3 | 4;

// Phase 38.3 — workflow-oriented labels + descriptions. Internal enum
// codes preserved for backward compatibility; the public-facing copy
// reflects workflows, not profession identity.
function workflowLabel(p: WorkspacePersonaProfile): string {
  return workflowFromPersona(p).label;
}
function workflowDescription(p: WorkspacePersonaProfile): string {
  return workflowFromPersona(p).description;
}

const GOAL_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "capture-evidence", label: "Capture evidence" },
  { id: "organize-cases", label: "Organize cases" },
  { id: "generate-reports", label: "Generate reports" },
  { id: "verify-media", label: "Verify media" },
  { id: "review-submissions", label: "Review submissions" },
  { id: "manage-governance", label: "Manage governance" },
  { id: "handle-claims", label: "Handle claims" },
  { id: "publish-verified", label: "Publish verified material" },
  { id: "audit-org", label: "Audit organization activity" },
];

const DENSITY_OPTIONS: Array<{
  id: "compact" | "comfortable" | "spacious";
  label: string;
  description: string;
}> = [
  {
    id: "compact",
    label: "Compact",
    description:
      "Maximum operational density. Dense tables, minimal whitespace, for command-center work.",
  },
  {
    id: "comfortable",
    label: "Comfortable",
    description:
      "Balanced. Default for most workflows; keeps advanced controls visible.",
  },
  {
    id: "spacious",
    label: "Spacious",
    description: "Generous whitespace. Best for new users and lighter workflows.",
  },
];

// Phase 38.9 — wrap in canonical PageRouteGate. `account.persona` is
// an ACCOUNT-domain route (NONE active-space).
export default function PersonaWizardPage() {
  return (
    <PageRouteGate routeId="account.persona">
      <PersonaWizardPageInner />
    </PageRouteGate>
  );
}

function PersonaWizardPageInner() {
  const activeSpace = useActiveSpace();
  const persona = usePersonaProfile();
  // R1 (Bug B) — refresh the platform envelope after a successful
  // PATCH so sidebar / dashboard / density / persona banner / help
  // all update in place. CR1.5 diagnosed that the handler previously
  // flipped the saved flag without refreshing the envelope, which
  // left every downstream consumer stale until manual page reload.
  const ctx = usePlatformContext();

  // Resume from the saved primary profile if any.
  const [step, setStep] = useState<WizardStep>(() =>
    persona.onboardingCompleted ? 4 : 1,
  );
  const [primaryProfile, setPrimaryProfile] = useState<WorkspacePersonaProfile>(
    persona.primaryProfile,
  );
  const [secondaryUseCases, setSecondaryUseCases] = useState<
    ReadonlyArray<WorkspacePersonaProfile>
  >(persona.secondaryUseCases);
  const [goals, setGoals] = useState<ReadonlyArray<string>>([]);
  const [density, setDensity] = useState<
    "compact" | "comfortable" | "spacious"
  >(persona.operationalDensityPreference);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const workspaceId = activeSpace?.id ?? null;
  const contextLabel = useMemo(() => {
    if (!activeSpace) return "Loading workspace…";
    if (activeSpace.type === "PERSONAL") return "Personal Space";
    return activeSpace.displayName ?? "Organization workspace";
  }, [activeSpace]);

  const persistProfile = useCallback(
    async (overrides?: { onboardingCompleted?: boolean }) => {
      if (!workspaceId) {
        setSaveError("No active workspace.");
        return;
      }
      setSaving(true);
      setSaveError(null);
      try {
        await apiFetch(`/v1/workspaces/${encodeURIComponent(workspaceId)}/persona`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            primaryProfile,
            secondaryUseCases,
            operationalDensityPreference: density,
            onboardingCompleted: overrides?.onboardingCompleted ?? false,
            onboardingState: { goals, lastStep: step },
          }),
        });
        // R1 (Bug B) — pull the freshly-persisted persona/density
        // into the canonical envelope so every downstream surface
        // (sidebar, dashboard, density CSS, persona banner, help)
        // re-renders without a manual page reload.
        try {
          await ctx.refresh();
          emitStateEvent("persona-profile:saved", "PersonaWizard", {
            primaryProfile,
            density,
            onboardingCompleted:
              overrides?.onboardingCompleted ?? false,
            workspaceId: redactWorkspaceId(workspaceId),
          });
        } catch {
          emitStateEvent(
            "persona-profile:refresh-missing",
            "PersonaWizard",
            { workspaceId: redactWorkspaceId(workspaceId) },
          );
        }
        setSaved(true);
      } catch (err) {
        const e = err as { message?: string };
        setSaveError(toSafeUserError(e, { message: "Could not save persona profile." }).message);
      } finally {
        setSaving(false);
      }
    },
    [workspaceId, primaryProfile, secondaryUseCases, density, goals, step, ctx],
  );

  const toggleGoal = (id: string) => {
    setGoals((prev) =>
      prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id],
    );
  };

  const toggleSecondary = (p: WorkspacePersonaProfile) => {
    setSecondaryUseCases((prev) => {
      if (prev.includes(p)) return prev.filter((x) => x !== p);
      if (prev.length >= 3) return prev;
      return [...prev, p];
    });
  };

  return (
    <main
      className="cc-page"
      data-persona-wizard
      data-persona-current={persona.primaryProfile}
      style={{ maxWidth: 720, margin: "0 auto" }}
    >
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">Workspace personalization</div>
          <h1 className="cc-title">How will you use PROOVRA?</h1>
          <p className="cc-subtitle">
            Configure workflows, operational priorities, and workspace
            defaults. This setting only changes ordering, defaults, and
            labels — it never changes what your workspace is allowed to do.
          </p>
          {/* Phase Final-Hidden-Feature-Surfacing — read-back of the
              durable WorkspacePersonaProfile row from
              `/v1/workspaces/:teamId/persona`. Confirms what is
              actually persisted vs the wizard's draft state. */}
          {workspaceId ? (
            <div style={{ marginTop: 12 }}>
              <WorkspacePersonaProfileCard teamId={workspaceId} />
            </div>
          ) : null}
        </div>
        <div className="cc-meta">
          <span data-persona-wizard-context>{contextLabel}</span>
          <span data-persona-wizard-step={`step-${step}`}>Step {step} of 4</span>
        </div>
      </header>

      {/* ============================ STEP 1 ============================ */}
      {step === 1 ? (
        <section className="cc-section" data-persona-wizard-step-block="1">
          <header className="cc-section-header">
            <h2 className="cc-section-title">Confirm the workspace context</h2>
          </header>
          <p>
            You are setting up <strong>{contextLabel}</strong>. Personal Space
            keeps things lightweight; organization workspaces unlock team,
            reviewer, and governance surfaces. You can change the persona at
            any time.
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              type="button"
              className="cc-quick-action"
              data-persona-wizard-next
              onClick={() => setStep(2)}
            >
              Continue
            </button>
          </div>
        </section>
      ) : null}

      {/* ============================ STEP 2 ============================ */}
      {step === 2 ? (
        <section className="cc-section" data-persona-wizard-step-block="2">
          <header className="cc-section-header">
            <h2 className="cc-section-title">
              What workflows are most important to your work?
            </h2>
          </header>
          <div style={{ display: "grid", gap: 8 }}>
            {WORKSPACE_PERSONA_PROFILES.map((p) => {
              const selected = primaryProfile === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPrimaryProfile(p)}
                  data-persona-wizard-option={p}
                  data-persona-wizard-option-selected={selected ? "true" : "false"}
                  style={{
                    textAlign: "left",
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: `1px solid ${selected ? "#1e293b" : "#cbd5e1"}`,
                    background: selected ? "#eef2ff" : "#fff",
                    cursor: "pointer",
                  }}
                >
                  <strong>{workflowLabel(p)}</strong>
                  <div style={{ fontSize: 12, color: "#475569", marginTop: 4 }}>
                    {workflowDescription(p)}
                  </div>
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button
              type="button"
              onClick={() => setStep(1)}
              className="cases-filter-chip"
              data-persona-wizard-back
            >
              Back
            </button>
            <button
              type="button"
              className="cc-quick-action"
              onClick={() => setStep(3)}
              data-persona-wizard-next
            >
              Continue
            </button>
          </div>
        </section>
      ) : null}

      {/* ============================ STEP 3 ============================ */}
      {step === 3 ? (
        <section className="cc-section" data-persona-wizard-step-block="3">
          <header className="cc-section-header">
            <h2 className="cc-section-title">Pick the goals that fit (optional)</h2>
          </header>
          <p style={{ fontSize: 13, color: "#475569" }}>
            We use these to choose sensible defaults for navigation, capture
            templates, and dashboard layout. You can change them later.
          </p>
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}
            data-persona-wizard-goals
          >
            {GOAL_OPTIONS.map((g) => {
              const selected = goals.includes(g.id);
              return (
                <button
                  key={g.id}
                  type="button"
                  className={`cases-filter-chip ${selected ? "is-active" : ""}`}
                  data-persona-wizard-goal={g.id}
                  onClick={() => toggleGoal(g.id)}
                >
                  {g.label}
                </button>
              );
            })}
          </div>

          <h3
            style={{ fontSize: 13, marginTop: 24, marginBottom: 8 }}
            data-persona-wizard-secondary-label
          >
            Secondary workflows (up to 3, optional)
          </h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {WORKSPACE_PERSONA_PROFILES.filter((p) => p !== primaryProfile).map(
              (p) => {
                const selected = secondaryUseCases.includes(p);
                return (
                  <button
                    key={p}
                    type="button"
                    className={`cases-filter-chip ${selected ? "is-active" : ""}`}
                    data-persona-wizard-secondary={p}
                    onClick={() => toggleSecondary(p)}
                  >
                    {workflowLabel(p)}
                  </button>
                );
              },
            )}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button
              type="button"
              onClick={() => setStep(2)}
              className="cases-filter-chip"
              data-persona-wizard-back
            >
              Back
            </button>
            <button
              type="button"
              className="cc-quick-action"
              onClick={() => setStep(4)}
              data-persona-wizard-next
            >
              Continue
            </button>
          </div>
        </section>
      ) : null}

      {/* ============================ STEP 4 ============================ */}
      {step === 4 ? (
        <section className="cc-section" data-persona-wizard-step-block="4">
          <header className="cc-section-header">
            <h2 className="cc-section-title">Workspace preferences</h2>
          </header>

          <h3 style={{ fontSize: 13, marginBottom: 8 }}>Operational density</h3>
          <div style={{ display: "grid", gap: 6 }}>
            {DENSITY_OPTIONS.map((d) => {
              const selected = density === d.id;
              return (
                <label
                  key={d.id}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    padding: "8px 10px",
                    border: `1px solid ${selected ? "#1e293b" : "#cbd5e1"}`,
                    borderRadius: 6,
                    cursor: "pointer",
                    background: selected ? "#eef2ff" : "#fff",
                  }}
                  data-persona-wizard-density-option={d.id}
                >
                  <input
                    type="radio"
                    name="persona-density"
                    checked={selected}
                    onChange={() => setDensity(d.id)}
                  />
                  <div>
                    <strong>{d.label}</strong>
                    <div style={{ fontSize: 12, color: "#475569" }}>
                      {d.description}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>

          {saveError ? (
            <div
              style={{
                marginTop: 12,
                padding: 8,
                background: "#fef2f2",
                color: "#7f1d1d",
                border: "1px solid #fecaca",
                borderRadius: 6,
                fontSize: 13,
              }}
              data-persona-wizard-error
            >
              {saveError}
            </div>
          ) : null}
          {saved ? (
            <div
              style={{
                marginTop: 12,
                padding: 8,
                background: "#ecfdf5",
                color: "#065f46",
                border: "1px solid #a7f3d0",
                borderRadius: 6,
                fontSize: 13,
              }}
              data-persona-wizard-saved
            >
              Workspace profile updated. Your navigation and recommendations
              have been refreshed.
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button
              type="button"
              onClick={() => setStep(3)}
              className="cases-filter-chip"
              data-persona-wizard-back
            >
              Back
            </button>
            <button
              type="button"
              className="cc-quick-action"
              data-persona-wizard-save
              disabled={saving}
              onClick={() => void persistProfile({ onboardingCompleted: true })}
            >
              {saving ? "Saving…" : "Save persona"}
            </button>
            <button
              type="button"
              data-persona-wizard-save-draft
              onClick={() => void persistProfile()}
              className="cases-filter-chip"
              disabled={saving}
            >
              Save draft only
            </button>
          </div>
        </section>
      ) : null}

      <section className="cc-section" data-persona-wizard-footnote>
        <p style={{ fontSize: 12, color: "#64748b" }}>
          Your workflow profile tunes ordering, defaults, and labels. It does
          NOT change what your workspace is allowed to do — those rules
          continue to come from your role and your organization’s policies.
        </p>
      </section>
    </main>
  );
}
