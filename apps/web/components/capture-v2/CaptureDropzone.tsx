import { useId, useState } from "react";
import { Camera, FolderUp, Mic, MonitorUp, Plus, Upload, Video } from "lucide-react";

import { CaptureScreenRecordingHelp } from "../../app/(app)/capture/_lib/CaptureScreenRecorderCard";

/**
 * ADD EVIDENCE — the one place material enters a capture session.
 *
 * The page's first useful viewport leads with this: one primary action (Add
 * files), the other supported capture methods in one compact grid, and a drop
 * target that is ALSO a real button for keyboard and touch users. Every action
 * calls the existing owner (file / folder input, camera hook, audio recorder,
 * screen recorder); nothing here stages anything itself.
 *
 * Two densities. With nothing staged it is the page's call to action and
 * carries the one calm empty-state sentence. Once something is staged it
 * compresses to an "Add more" toolbar and a slim drop strip, so the staged
 * list below takes the focus.
 *
 * Screen is DIRECT: `onStartScreenRecording` must open the browser's chooser
 * from inside this click (see `useCaptureScreenRecorder.start`). There is no
 * intermediate card to click through.
 */
type CaptureDropzoneProps = {
  busy: boolean;
  /** Number of staged items; 0 renders the empty-state density. */
  itemCount: number;
  onOpenFilePicker: () => void;
  onOpenFolderPicker: () => void;
  onOpenCamera: (mode: "PHOTO" | "VIDEO") => void;
  onOpenAudioRecorder: () => void;
  /** Browser screen recording; the action renders only when supplied (supported browsers). */
  onStartScreenRecording?: () => void;
  /** A chooser is open or a recording is live / awaiting review. */
  screenRecordingActive?: boolean;
  onDropFiles: (event: React.DragEvent<HTMLElement>) => Promise<void>;
};

type MethodKey = "folder" | "photo" | "video" | "audio" | "screen";

const METHODS: ReadonlyArray<{
  key: MethodKey;
  label: string;
  helper: string;
  icon: typeof Upload;
}> = [
  { key: "folder", label: "Folder", helper: "Keeps folder structure", icon: FolderUp },
  { key: "photo", label: "Photo", helper: "Use camera", icon: Camera },
  { key: "video", label: "Video", helper: "Record a clip", icon: Video },
  { key: "audio", label: "Audio", helper: "Record a voice note", icon: Mic },
  { key: "screen", label: "Screen", helper: "Screen, window or tab", icon: MonitorUp },
];

export function CaptureDropzone({
  busy,
  itemCount,
  onOpenFilePicker,
  onOpenFolderPicker,
  onOpenCamera,
  onOpenAudioRecorder,
  onStartScreenRecording,
  screenRecordingActive = false,
  onDropFiles,
}: CaptureDropzoneProps) {
  const headingId = useId();
  const [dragging, setDragging] = useState(false);
  const empty = itemCount === 0;

  const run = (key: MethodKey) => {
    if (key === "folder") return onOpenFolderPicker();
    if (key === "photo") return onOpenCamera("PHOTO");
    if (key === "video") return onOpenCamera("VIDEO");
    if (key === "audio") return onOpenAudioRecorder();
    // Synchronous hand-off: the chooser opens within this click's gesture.
    return onStartScreenRecording?.();
  };

  const methods = METHODS.filter((m) => m.key !== "screen" || onStartScreenRecording);

  return (
    <section
      className={`capture-add ${empty ? "is-empty" : "is-compact"} ${dragging ? "is-dragging" : ""}`}
      data-capture-add-evidence={empty ? "empty" : "compact"}
      aria-labelledby={headingId}
      onDragOver={(event) => {
        event.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        setDragging(false);
        void onDropFiles(event);
      }}
    >
      <header className="capture-add__head">
        <h2 id={headingId} className="capture-add__title">
          {empty ? "Add evidence" : "Add more evidence"}
        </h2>
        <p className="capture-add__lead" data-capture-add-lead>
          {empty
            ? "Add your first file to get started."
            : `${itemCount} item${itemCount === 1 ? "" : "s"} staged. Add more at any time before Review & Sign.`}
        </p>
      </header>

      <div className="capture-add__actions" role="group" aria-label="Evidence intake actions">
        <button
          type="button"
          className="capture-add__primary"
          onClick={onOpenFilePicker}
          disabled={busy}
          data-capture-add-action="files"
        >
          <Upload size={18} strokeWidth={2.2} aria-hidden="true" />
          <span>
            <strong>Add files</strong>
            <small>Photos, video, audio, PDFs</small>
          </span>
        </button>

        <div className="capture-add__methods">
          {methods.map((method) => {
            const Icon = method.icon;
            const screenBusy = method.key === "screen" && screenRecordingActive;
            return (
              <button
                key={method.key}
                type="button"
                className="capture-add__method"
                onClick={() => run(method.key)}
                disabled={busy || screenBusy}
                data-capture-add-action={method.key}
                aria-describedby={method.key === "screen" ? `${headingId}-screen` : undefined}
              >
                <Icon size={17} strokeWidth={2.1} aria-hidden="true" />
                <span>
                  <strong>{method.label}</strong>
                  <small id={method.key === "screen" ? `${headingId}-screen` : undefined}>
                    {screenBusy ? "Recording in progress" : method.helper}
                  </small>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="capture-add__drop" data-capture-dropzone>
        <span className="capture-add__drop-copy">
          {empty ? "Drag files or a folder here, or" : "Drop more files here, or"}
        </span>
        <button
          type="button"
          className="capture-add__browse"
          onClick={onOpenFilePicker}
          disabled={busy}
        >
          <Plus size={15} strokeWidth={2.4} aria-hidden="true" />
          browse files
        </button>
      </div>

      {onStartScreenRecording ? <CaptureScreenRecordingHelp className="capture-add__help" /> : null}
    </section>
  );
}
