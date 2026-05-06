type Props = {
  activeStep: number;
};

const STEPS = [
  ["1", "Select method", "Choose how to collect"],
  ["2", "Configure", "Template & requirements"],
  ["3", "Capture", "Upload or record evidence"],
  ["4", "Review & sign", "Verify and finalize"],
];

export function CaptureWorkflow({
  activeStep,
}: Props) {
  return (
    <div className="capture-enterprise-steps">
      {STEPS.map(([step, title, detail], index) => {
        const active =
          activeStep === Math.min(index + 1, 3);

        return (
          <div
            key={step}
            className={`capture-enterprise-step ${
              active ? "active" : ""
            }`}
          >
            <div className="capture-enterprise-step-number">
              {step}
            </div>

            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 850,
                  color: "#1c3035",
                }}
              >
                {title}
              </div>

              <div className="capture-card-muted">
                {detail}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}