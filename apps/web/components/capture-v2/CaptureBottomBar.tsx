import { Button } from "../ui";

type Props = {
  busy: boolean;
  progress: number;
  sessionStatus: string | null;
  finishDisabled: boolean;
  finishReason?: string;
  missingSteps: string[];
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
  onReset,
  onFinalize,
}: Props) {
  return (
    <div className="capture-bottom-bar">
      <div className="capture-bottom-bar-inner">
        <div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 850,
            }}
          >
            {finishReason ??
              "Ready to finish and sign"}
          </div>

          <div
            style={{
              color: "rgba(211,223,220,0.72)",
              fontSize: 12,
              marginTop: 4,
            }}
          >
            {busy
              ? `Finishing evidence session… ${progress}%`
              : sessionStatus ??
                "Creates the evidence record, uploads staged materials, signs integrity data, and starts verification artifact generation."}
          </div>

          {missingSteps.length > 0 ? (
            <div
              style={{
                color: "#e6c9ae",
                fontSize: 12,
                marginTop: 8,
              }}
            >
              Missing: {missingSteps.join(", ")}
            </div>
          ) : null}
        </div>

        <Button
          variant="secondary"
          onClick={onReset}
          disabled={busy}
          className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
          style={{
            borderColor:
              "rgba(248,113,113,0.24)",
            color: "#fecaca",
            background:
              "rgba(127,29,29,0.16)",
          }}
        >
          Clear Session
        </Button>

        <Button
          onClick={onFinalize}
          disabled={finishDisabled}
          className="rounded-[999px] border px-6 py-3 text-[0.95rem] font-medium"
        >
          {busy
            ? "Finishing…"
            : "Review & Sign"}
        </Button>
      </div>
    </div>
  );
}