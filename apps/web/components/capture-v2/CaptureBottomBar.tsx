import { Button } from "../ui";

/**
 * The action zone: what the operator can DO, and how far a running
 * finalization has got.
 *
 * It used to also render a verdict — a headline from `finishReason` (the
 * readiness authority's first blocker), a paragraph naming the outstanding
 * required steps, and a `<small>` naming them again. `CaptureFinalReadiness`
 * now sits directly above this bar and states that verdict once, from the same
 * `SessionReadiness`, with the same complete list. Two boxes an inch apart
 * saying the same thing left the operator checking whether they agreed.
 *
 * Nothing was dropped: the reason and the unmapped-step names moved up into
 * that component. `finishDisabled` still gates the button, and it is still
 * `busy || !sessionReadiness.canFinalize`.
 */
type Props = {
  busy: boolean;
  progress: number;
  sessionStatus: string | null;
  finishDisabled: boolean;
  canClearSession: boolean;
  onReset: () => void;
  onFinalize: () => void;
};

export function CaptureBottomBar({
  busy,
  progress,
  sessionStatus,
  finishDisabled,
  canClearSession,
  onReset,
  onFinalize,
}: Props) {

  return (
    <section className="capture-bottom-bar">
      <div className="capture-bottom-bar-inner capture-phase4-bottom-bar-inner">
        <div>
          <strong>{busy ? "Finalizing" : "Review & Sign"}</strong>
          <p>
            {busy
              ? `Finishing evidence session… ${progress}%`
              : (sessionStatus ??
                "Review & Sign locks the session, records integrity metadata, and starts verification artifact generation.")}
          </p>
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
