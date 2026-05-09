import type { CollectionPlanTemplate, EvidenceType, SessionItem } from "../../app/(app)/capture/_lib/types";
import type { SessionReadiness } from "../../app/(app)/capture/_lib/session-readiness";

type Props = {
  selectedCollectionPlan: CollectionPlanTemplate | undefined;
  collectionPlans: CollectionPlanTemplate[];
  collectionPlanId: string;
  setCollectionPlanId: (id: string) => void;
  planDropdownOpen: boolean;
  setPlanDropdownOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  busy: boolean;
  hasSessionItems: boolean;
  checklistStepItemMap: Map<string, SessionItem[]>;
  sessionReadiness: SessionReadiness;
  formatEvidenceTypeLabel: (kind: EvidenceType) => string;
};

export function CaptureRequirements({
  selectedCollectionPlan,
  collectionPlans,
  collectionPlanId,
  setCollectionPlanId,
  planDropdownOpen,
  setPlanDropdownOpen,
  busy,
  hasSessionItems,
  checklistStepItemMap,
  sessionReadiness,
  formatEvidenceTypeLabel,
}: Props) {
  const requiredTotal = sessionReadiness.summary.requiredTotal;
  const requiredCompleted = sessionReadiness.summary.requiredCompleted;
  const missingRequired = sessionReadiness.missingRequiredSteps.length;
  const optionalSteps = selectedCollectionPlan?.steps.filter((step) => !step.required) ?? [];
  const optionalMapped = optionalSteps.filter(
    (step) => (checklistStepItemMap.get(step.id)?.length ?? 0) > 0
  ).length;
  const requiredProgress = requiredTotal > 0 ? Math.round((requiredCompleted / requiredTotal) * 100) : 100;
  const unmappedMaterials = sessionReadiness.summary.unmappedCount;

  return (
    <div className="capture-requirements-panel capture-phase4-requirements-panel">
      <div className="capture-panel-heading capture-requirements-heading">
        <div>
          <div className="capture-section-label">Requirements</div>
          <div className="capture-card-title">
            {selectedCollectionPlan?.name ?? "Evidence intake"}
          </div>
          <p className="capture-card-muted">
            {selectedCollectionPlan?.description}
          </p>
        </div>

        <div className="capture-plan-dropdown">
          <button
            type="button"
            className="capture-plan-dropdown-trigger"
            disabled={busy || hasSessionItems}
            onClick={() => setPlanDropdownOpen((prev) => !prev)}
          >
            <span>{selectedCollectionPlan?.name ?? "Select plan"}</span>
            <span>⌄</span>
          </button>

          {planDropdownOpen && !(busy || hasSessionItems) ? (
            <div className="capture-plan-dropdown-menu">
              {collectionPlans.map((plan) => (
                <button
                  key={plan.id}
                  type="button"
                  className={`capture-plan-dropdown-item ${
                    collectionPlanId === plan.id ? "active" : ""
                  }`}
                  onClick={() => {
                    setCollectionPlanId(plan.id);
                    setPlanDropdownOpen(false);
                  }}
                >
                  {plan.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="capture-requirements-summary-strip capture-phase4-summary-strip">
        <div className={missingRequired > 0 ? "is-blocked" : "is-clear"}>
          <span>Required mapped</span>
          <strong>
            {requiredCompleted}/{requiredTotal}
          </strong>
        </div>
        <div>
          <span>Optional mapped</span>
          <strong>
            {optionalMapped}/{optionalSteps.length}
          </strong>
        </div>
        <div className={unmappedMaterials > 0 ? "is-attention" : "is-clear"}>
          <span>Unmapped materials</span>
          <strong>{unmappedMaterials}</strong>
        </div>
      </div>

      <div className="capture-requirement-progress-shell" aria-label="Required mapping progress">
        <div className="capture-requirement-progress-copy">
          <span>Finish gate</span>
          <strong>{missingRequired > 0 ? `${missingRequired} required unmapped` : "All required mapped"}</strong>
        </div>
        <div className="capture-requirement-progress-track">
          <span style={{ width: `${requiredProgress}%` }} />
        </div>
      </div>

      {selectedCollectionPlan ? (
        <div className="capture-requirements-list">
          {selectedCollectionPlan.steps.map((step, index) => {
            const mappedItems = checklistStepItemMap.get(step.id) ?? [];
            const mappedCount = mappedItems.length;
            const mapped = mappedCount > 0;
            const requiredMissing = step.required && !mapped;
            const acceptedKindsLabel = step.acceptedKinds?.map(formatEvidenceTypeLabel).join(", ");
            const mappingLabel = mapped
              ? `${mappedCount} material${mappedCount === 1 ? "" : "s"} mapped`
              : step.required
                ? "Required unmapped"
                : "Optional unmapped";

            return (
              <div
                key={step.id}
                className={`capture-requirement-row capture-phase4-requirement-row ${
                  requiredMissing ? "is-missing" : mapped ? "is-complete" : "is-optional-open"
                } ${step.required ? "is-required" : "is-optional"}`}
              >
                <div className="capture-requirement-index">{index + 1}</div>

                <div className="capture-requirement-copy">
                  <div className="capture-requirement-title-row">
                    <strong>{step.title}</strong>
                    <span className={step.required ? "required" : "optional"}>
                      {step.required ? "Required to finish" : "Optional context"}
                    </span>
                  </div>

                  <p>{step.description}</p>

                  <div className="capture-requirement-chip-row">
                    <span className={mapped ? "mapped" : requiredMissing ? "missing" : "optional"}>
                      {mappingLabel}
                    </span>
                    {acceptedKindsLabel ? <span>Accepts {acceptedKindsLabel}</span> : null}
                  </div>
                </div>

                <div className="capture-requirement-operational-status">
                  <strong className={mapped ? "mapped" : requiredMissing ? "missing" : "optional"}>
                    {mapped ? "Mapped" : step.required ? "Unmapped" : "Optional"}
                  </strong>
                  <span>
                    {mapped
                      ? `${mappedCount} linked item${mappedCount === 1 ? "" : "s"}`
                      : step.required
                        ? "Blocks Review & Sign"
                        : "Does not block finish"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
