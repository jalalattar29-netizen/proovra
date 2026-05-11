import { Camera, Mic, Upload, Video } from "lucide-react";

import { Button } from "../ui";

type CaptureDropzoneProps = {
  busy: boolean;
  sessionHasItems: boolean;
  onOpenFilePicker: () => void;
  onOpenFolderPicker: () => void;
  onOpenCamera: (mode: "PHOTO" | "VIDEO") => void;
  onOpenAudioRecorder: () => void;
  onDropFiles: (event: React.DragEvent<HTMLDivElement>) => Promise<void>;
};

const INTAKE_ACTIONS = [
{
  key: "files",
  label: "Files",
  helper: "Photos, video, audio, PDFs",
  icon: Upload,
  tone: "primary",
},
  {
    key: "folder",
    label: "Folder",
    helper: "Preserve structure",
    icon: Upload,
    tone: "secondary",
  },
  {
    key: "photo",
    label: "Photo",
    helper: "Camera capture",
    icon: Camera,
    tone: "secondary",
  },
  {
    key: "video",
    label: "Video",
    helper: "Record clip",
    icon: Video,
    tone: "secondary",
  },
  {
    key: "audio",
    label: "Audio",
    helper: "Record note",
    icon: Mic,
    tone: "secondary",
  },
] as const;

export function CaptureDropzone({
  busy,
  sessionHasItems,
  onOpenFilePicker,
  onOpenFolderPicker,
  onOpenCamera,
  onOpenAudioRecorder,
  onDropFiles,
}: CaptureDropzoneProps) {
  const runAction = (actionKey: (typeof INTAKE_ACTIONS)[number]["key"]) => {
    if (actionKey === "files") {
      onOpenFilePicker();
      return;
    }

    if (actionKey === "folder") {
      onOpenFolderPicker();
      return;
    }

    if (actionKey === "photo") {
      onOpenCamera("PHOTO");
      return;
    }

    if (actionKey === "video") {
      onOpenCamera("VIDEO");
      return;
    }

    onOpenAudioRecorder();
  };

  return (
    <div
      className="capture-drop-zone-enterprise capture-intake-command"
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDropFiles}
    >
      <div className="capture-intake-command-header">
        <div>
          <div className="capture-section-label">Evidence capture</div>
<div className="capture-card-title">Add source files</div>
<p>
  Upload, capture, or record materials for this session.
</p>
        </div>

        <div className="capture-intake-state-pill">
          {sessionHasItems ? "Session in progress" : "Ready for intake"}
        </div>
      </div>

      <div
        className="capture-upload-actions capture-phase5-upload-actions"
        aria-label="Evidence intake actions"
      >
        {INTAKE_ACTIONS.map((action) => {
          const Icon = action.icon;
          const isPrimary = action.tone === "primary";

          return (
            <Button
              key={action.key}
              variant={isPrimary ? undefined : "secondary"}
              onClick={() => runAction(action.key)}
              disabled={busy}
              className={
                isPrimary
                  ? "capture-intake-primary-action"
                  : "capture-intake-secondary-action"
              }
            >
              <Icon size={17} strokeWidth={2.1} className="capture-action-icon" />
              <span>
                <strong>{action.label}</strong>
                <small>{action.helper}</small>
              </span>
            </Button>
          );
        })}
      </div>

      <div className="capture-drop-assistive-copy">
        <strong>Drag and drop files or folders into this workspace.</strong>
        <span>
          Mapping, integrity checks, and readiness warnings update as soon as materials
          are staged.
        </span>
      </div>
    </div>
  );
}
