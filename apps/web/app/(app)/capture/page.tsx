"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card } from "../../../components/ui";
import { useLocale } from "../../providers";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

type EvidenceType = "PHOTO" | "VIDEO" | "DOCUMENT";

export default function CapturePage() {
  const { t } = useLocale();
  const router = useRouter();
  const [type, setType] = useState<EvidenceType>("PHOTO");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useLocation, setUseLocation] = useState(false);
  const [progress, setProgress] = useState<number>(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const pollReport = async (evidenceId: string) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await apiFetch(`/v1/evidence/${evidenceId}/report/latest`, { method: "GET" });
        return;
      } catch {
        await sleep(2000);
      }
    }
  };

  const handleCapture = async () => {
    setError(null);
    setBusy(true);
    try {
      const mimeType = file?.type || "text/plain";
      const deviceTimeIso = new Date().toISOString();
      let gps: { lat: number; lng: number; accuracyMeters?: number } | undefined;
      if (useLocation && typeof navigator !== "undefined" && navigator.geolocation) {
        gps = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(
            (pos) =>
              resolve({
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                accuracyMeters: pos.coords.accuracy
              }),
            (err) => reject(err),
            { enableHighAccuracy: true, timeout: 8000 }
          );
        });
      }
      const data = await apiFetch("/v1/evidence", {
        method: "POST",
        body: JSON.stringify({ type, mimeType, deviceTimeIso, gps })
      });

      const uploadFile =
        file ?? new File([`Proovra ${type} capture`], "capture.txt", { type: "text/plain" });

      setProgress(0);
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            setProgress(Math.round((event.loaded / event.total) * 100));
          }
        };
        xhr.onerror = () => reject(new Error("Upload failed"));
        xhr.onload = () => resolve();
        xhr.open("PUT", data.upload.putUrl);
        xhr.setRequestHeader(
          "content-type",
          uploadFile.type || "application/octet-stream"
        );
        xhr.send(uploadFile);
      });

      await apiFetch(`/v1/evidence/${data.id}/complete`, { method: "POST", body: "{}" });
      await pollReport(data.id);
      router.push(`/evidence/${data.id}`);
    } catch (err) {
      captureException(err, { feature: "web_capture" });
      setError(err instanceof Error ? err.message : "Capture failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="section app-section">
      <div className="app-hero app-hero-contained">
        <div className="page-title" style={{ marginBottom: 0 }}>
          <div>
            <h1 style={{ margin: 0 }}>{t("capture")}</h1>
            <p className="page-subtitle">Upload a file and generate a signed report.</p>
          </div>
        </div>
      </div>
      <div className="app-body">
        <Card>
          <div style={{ display: "grid", gap: 16 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {([
              { label: t("photo"), value: "PHOTO" },
              { label: t("video"), value: "VIDEO" },
              { label: t("document"), value: "DOCUMENT" }
            ] as const).map((item) => (
              <button
                key={item.value}
                type="button"
                className={`pill-button ${type === item.value ? "active" : ""}`}
                onClick={() => setType(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <input
            type="file"
            aria-label="Upload evidence file"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            ref={fileInputRef}
            style={{ display: "none" }}
          />
          <div
            className="drop-zone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const dropped = event.dataTransfer.files?.[0] ?? null;
              if (dropped) setFile(dropped);
            }}
            onClick={() => fileInputRef.current?.click()}
          >
            {file ? (
              <div>
                <div style={{ fontWeight: 600 }}>{file.name}</div>
                <div style={{ fontSize: 12, color: "#64748b" }}>
                  {(file.size / 1024 / 1024).toFixed(2)} MB
                </div>
              </div>
            ) : (
              <div style={{ color: "#64748b" }}>Drag & drop or click to select</div>
            )}
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={useLocation}
              onChange={(event) => setUseLocation(event.target.checked)}
            />
            Include location metadata (optional)
          </label>
          {busy ? (
            <div style={{ fontSize: 12, color: "#64748b" }}>
              Uploading… {progress}%
            </div>
          ) : null}
          {error && <div className="error-text">{error}</div>}
          <div>
            <Button onClick={handleCapture} disabled={busy}>
              {busy ? "Capturing..." : "Capture & Sign"}
            </Button>
          </div>
        </div>
        </Card>
      </div>
    </div>
  );
}
