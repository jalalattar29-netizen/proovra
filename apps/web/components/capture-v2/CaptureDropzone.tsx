import { Button } from "../ui";

type Props = {
  busy: boolean;
  openFilePicker: () => void;
  openFolderPicker: () => void;
  openCamera: (mode: "PHOTO" | "VIDEO") => void;
  openAudioRecorder: () => void;
  onDropFiles: (event: React.DragEvent<HTMLDivElement>) => Promise<void>;
  secondaryButtonStyle: React.CSSProperties;
  tertiaryButtonStyle: React.CSSProperties;
};

export function CaptureDropzone({
  busy,
  openFilePicker,
  openFolderPicker,
  openCamera,
  openAudioRecorder,
  onDropFiles,
  secondaryButtonStyle,
  tertiaryButtonStyle,
}: Props) {
  return (
    <div
      className="capture-drop-zone-enterprise"
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDropFiles}
    >
      <div className="capture-drop-actions">
        <Button
          variant="secondary"
          onClick={(event) => {
            event.stopPropagation();
            openFilePicker();
          }}
          disabled={busy}
          className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
          style={secondaryButtonStyle}
        >
          Upload Files
        </Button>

        <Button
          variant="secondary"
          onClick={(event) => {
            event.stopPropagation();
            openFolderPicker();
          }}
          disabled={busy}
          className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
          style={tertiaryButtonStyle}
        >
          Upload Folder
        </Button>

        <Button
          variant="secondary"
          onClick={() => openCamera("PHOTO")}
          disabled={busy}
          className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
          style={secondaryButtonStyle}
        >
          Capture Photo
        </Button>

        <Button
          variant="secondary"
          onClick={() => openCamera("VIDEO")}
          disabled={busy}
          className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
          style={secondaryButtonStyle}
        >
          Record Video
        </Button>

        <Button
          variant="secondary"
          onClick={openAudioRecorder}
          disabled={busy}
          className="rounded-[999px] border px-5 py-3 text-[0.95rem] font-medium"
          style={tertiaryButtonStyle}
        >
          Record Audio
        </Button>
      </div>

      <div className="capture-drop-title">
        Drag & drop files here or choose a capture method
      </div>

      <div className="capture-card-muted">
        Nothing is signed or submitted until you finish the evidence record.
      </div>
    </div>
  );
}