type EvidenceType = "PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT";

type ChecklistStep = {
  id: string;
  title: string;
  description: string;
  purposeLabel: string;
  required: boolean;
  acceptedKinds?: EvidenceType[];
};

type CollectionPlanTemplate = {
  id: string;
  name: string;
  description: string;
  locationRequirement: "optional" | "recommended" | "required";
  steps: ChecklistStep[];
};

type Props = {
  selectedCollectionPlan: CollectionPlanTemplate | undefined;
  collectionPlans: CollectionPlanTemplate[];
  collectionPlanId: string;
  setCollectionPlanId: (id: string) => void;
  planDropdownOpen: boolean;
  setPlanDropdownOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  busy: boolean;
  hasSessionItems: boolean;
  checklistStepItemMap: Map<string, unknown[]>;
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
  formatEvidenceTypeLabel,
}: Props) {
  return (
    <main className="capture-enterprise-card capture-requirements-panel">
      <div className="capture-card-topline">
        <div>
          <div className="capture-section-label">Requirements</div>
          <div className="capture-card-title">
            {selectedCollectionPlan?.name ?? "Evidence intake"}
          </div>
          <div className="capture-card-muted">
            {selectedCollectionPlan?.description}
          </div>
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

      {selectedCollectionPlan ? (
        <div className="capture-requirements-list">
          {selectedCollectionPlan.steps.map((step, index) => {
            const mapped = checklistStepItemMap.has(step.id);
            const required = step.required;

            return (
              <div key={step.id} className="capture-requirement-row">
                <div className="capture-requirement-index">{index + 1}</div>

                <div className="capture-requirement-icon">
                  {step.acceptedKinds?.includes("DOCUMENT")
                    ? "□"
                    : step.acceptedKinds?.includes("AUDIO")
                      ? "◌"
                      : "▣"}
                </div>

                <div style={{ minWidth: 0 }}>
                  <div className="capture-requirement-title-row">
                    <strong>{step.title}</strong>
                    <span className={required ? "required" : "optional"}>
                      {required ? "Required" : "Optional"}
                    </span>
                  </div>

                  <div className="capture-card-muted">{step.description}</div>

                  <div className="capture-card-muted">
                    Accepted:{" "}
                    {step.acceptedKinds?.map(formatEvidenceTypeLabel).join(", ")}
                  </div>
                </div>

                <div
                  className={`capture-requirement-status ${
                    mapped
                      ? "capture-status-met"
                      : required
                        ? "capture-status-missing"
                        : ""
                  }`}
                >
                  {mapped ? "Added" : required ? "Not added" : "Optional"}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </main>
  );
}