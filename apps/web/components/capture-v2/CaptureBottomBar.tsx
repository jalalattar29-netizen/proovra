import { Button } from "../ui";

type Props = {
  busy: boolean;
  progress: number;
  sessionStatus: string | null;
  finishDisabled: boolean;
  finishReason?: string | null;
  missingSteps: string[];
  canClearSession: boolean;
  onReset: () => void;
  onFinalize: () => void;
};

export function CaptureBottomBar({
  busy,
  progress,
  sessionStatus,
  finishDisabled,
  finishReason,
  missingSteps,
  canClearSession,
  onReset,
  onFinalize,
}: Props) {
  const missingRequiredCount = missingSteps.length;
  const missingPreview = missingSteps.slice(0, 3).join(", ");
  const hiddenMissingCount = Math.max(0, missingRequiredCount - 3);

  return (
    <section className="capture-bottom-bar">
      <div className="capture-bottom-bar-inner capture-phase4-bottom-bar-inner">
        <div>
          <strong>
            {finishReason ?? (missingRequiredCount > 0 ? "Required mapping still incomplete" : "Ready for Review & Sign")}
          </strong>
          <p>
            {busy
              ? `Finishing evidence session… ${progress}%`
              : missingRequiredCount > 0
                ? `Map staged material to every required collection step before Review & Sign. Remaining: ${missingPreview}${hiddenMissingCount > 0 ? ` and ${hiddenMissingCount} more` : ""}.`
                : sessionStatus ??
                  "All required collection steps are mapped. Review & Sign locks the session, records integrity metadata, and starts verification artifact generation."}
          </p>

          {missingRequiredCount > 0 ? (
            <small className="capture-phase4-missing-list">
              Required still unmapped: {missingSteps.join(", ")}
            </small>
          ) : null}
        </div>

        <div className="capture-phase5-final-actions" aria-label="Session final actions">
          <Button
            variant="secondary"
            onClick={onReset}
            disabled={busy || !canClearSession}
            className="capture-clear-button capture-secondary-session-action"
          >
            Clear Session
          </Button>

          <Button
            onClick={onFinalize}
            disabled={finishDisabled}
            className="capture-finish-button proovra-cta-btn capture-primary-finalize-action"
          >
            {busy ? "Finishing…" : "Review & Sign"}
          </Button>
        </div>
      </div>
    </section>
  );
}
