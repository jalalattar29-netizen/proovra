import { CheckCircle2, Circle, CircleAlert } from "lucide-react";

import type { CollectionPlanTemplate, EvidenceType, SessionItem } from "../../app/(app)/capture/_lib/types";
import type { CapturePlanMode, SessionReadiness } from "../../app/(app)/capture/_lib/session-readiness";
import { isPrimaryChecklistStepId } from "../../app/(app)/capture/_lib/captureReadiness";

/**
 * REQUIREMENTS — the template's checklist, as something the operator can act on.
 *
 * Every row's state is read from the readiness authority's inputs
 * (`checklistStepItemMap`, `sessionReadiness.missingRequiredSteps`); nothing is
 * decided here. What changed is the language and the actions:
 *
 *   * The label follows the ACTIVE MODE. In Guided mode a required item blocks
 *     Review & Sign, so it says "Required". In Flexible mode the same item does
 *     not block (see `buildSessionReadiness`), so it says "Recommended" — the
 *     old copy said "Blocks Review & Sign" in both modes, which was false in one.
 *   * Optional items are quieter than required ones.
 *   * An unmet item offers the next step directly: "Assign a file" when there
 *     is staged material not yet assigned (opens that file's assignment), or
 *     "Add file" when there is none (opens the file picker).
 *
 * The template picker that used to live in this header moved to Capture setup.
 */
type Props = {
  selectedCollectionPlan: CollectionPlanTemplate | undefined;
  planMode: CapturePlanMode;
  busy: boolean;
  checklistStepItemMap: Map<string, SessionItem[]>;
  sessionReadiness: SessionReadiness;
  formatEvidenceTypeLabel: (kind: EvidenceType) => string;
  onAddForStep: (stepId: string) => void;
  onAssignForStep: (stepId: string) => void;
};

export const requirementRowDomId = (stepId: string) => `capture-requirement-${stepId}`;

export function CaptureRequirements({
  selectedCollectionPlan,
  planMode,
  busy,
  checklistStepItemMap,
  sessionReadiness,
  formatEvidenceTypeLabel,
  onAddForStep,
  onAssignForStep,
}: Props) {
  const steps = selectedCollectionPlan?.steps ?? [];
  if (steps.length === 0) return null;

  const guided = planMode === "CHECKLIST_REQUIRED";
  const requiredTotal = sessionReadiness.summary.requiredTotal;
  const requiredCompleted = sessionReadiness.summary.requiredCompleted;
  const hasUnassigned = sessionReadiness.unmappedItems.length > 0;
  // Required first, then optional; the template's own order within each.
  const ordered = [...steps.filter((s) => s.required), ...steps.filter((s) => !s.required)];

  return (
    <section
      className="capture-requirements-panel capture-reqs"
      data-capture-requirements
      data-capture-requirements-mode={guided ? "guided" : "flexible"}
      aria-labelledby="capture-reqs-title"
    >
      <header className="capture-reqs__head">
        <div>
          <h2 id="capture-reqs-title" className="capture-reqs__title">
            Requirements
          </h2>
          <p className="capture-reqs__meta">
            {selectedCollectionPlan?.name}
            {requiredTotal > 0
              ? ` · ${requiredCompleted} of ${requiredTotal} ${guided ? "required" : "recommended"} assigned`
              : ""}
          </p>
        </div>
        {!guided && requiredTotal > 0 ? (
          <span className="capture-reqs__mode-note">Flexible mode: these do not block signing</span>
        ) : null}
      </header>

      <ol className="capture-reqs__list">
        {ordered.map((step) => {
          const mapped = (checklistStepItemMap.get(step.id)?.length ?? 0) > 0;
          const count = checklistStepItemMap.get(step.id)?.length ?? 0;
          const tier = step.required ? (guided ? "required" : "recommended") : "optional";
          const tierLabel = tier === "required" ? "Required" : tier === "recommended" ? "Recommended" : "Optional";
          const blocking = tier === "required" && !mapped;
          const accepts = step.acceptedKinds?.map(formatEvidenceTypeLabel).join(", ");
          const isPrimary = isPrimaryChecklistStepId(step.id);
          const actionLabel = hasUnassigned
            ? isPrimary
              ? "Mark a file as primary evidence"
              : "Assign a file"
            : "Add file";

          return (
            <li
              key={step.id}
              id={requirementRowDomId(step.id)}
              tabIndex={-1}
              className={`capture-reqs__item is-${tier} ${mapped ? "is-met" : "is-open"} ${blocking ? "is-blocking" : ""}`}
              data-capture-requirement={step.id}
              data-capture-requirement-tier={tier}
              data-capture-requirement-state={mapped ? "met" : "open"}
            >
              <span className="capture-reqs__icon" aria-hidden="true">
                {mapped ? (
                  <CheckCircle2 size={18} strokeWidth={2.2} />
                ) : blocking ? (
                  <CircleAlert size={18} strokeWidth={2.2} />
                ) : (
                  <Circle size={18} strokeWidth={2} />
                )}
              </span>
              <div className="capture-reqs__copy">
                <p className="capture-reqs__name">
                  <strong>{step.title}</strong>
                  <span className={`capture-reqs__tier is-${tier}`}>{tierLabel}</span>
                </p>
                <p className="capture-reqs__desc">
                  {step.description}
                  {accepts ? <span className="capture-reqs__accepts"> Accepts {accepts}.</span> : null}
                </p>
                <p className="capture-visually-hidden">
                  {mapped
                    ? `${count} file${count === 1 ? "" : "s"} assigned.`
                    : blocking
                      ? "Not assigned yet. Needed before Review & Sign."
                      : "Not assigned yet."}
                </p>
              </div>
              <div className="capture-reqs__state">
                {mapped ? (
                  <span className="capture-reqs__done">
                    {count} file{count === 1 ? "" : "s"} assigned
                  </span>
                ) : (
                  <button
                    type="button"
                    className={`capture-reqs__action ${blocking ? "is-primary" : ""}`}
                    disabled={busy}
                    onClick={() => (hasUnassigned ? onAssignForStep(step.id) : onAddForStep(step.id))}
                    aria-label={`${actionLabel} for ${step.title}`}
                  >
                    {actionLabel}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
