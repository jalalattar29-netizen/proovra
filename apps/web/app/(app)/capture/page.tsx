"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card } from "../../../components/ui";
import { useLocale } from "../../providers";
import { apiFetch } from "../../../lib/api";

type EvidenceType = "PHOTO" | "VIDEO" | "DOCUMENT";

export default function CapturePage() {
  const { t } = useLocale();
  const router = useRouter();
  const [type, setType] = useState<EvidenceType>("PHOTO");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCapture = async () => {
    setError(null);
    setBusy(true);
    try {
      const mimeType = file?.type || "text/plain";
      const data = await apiFetch("/v1/evidence", {
        method: "POST",
        body: JSON.stringify({ type, mimeType })
      });

      const uploadFile =
        file ?? new File([`Proovra ${type} capture`], "capture.txt", { type: "text/plain" });

      await fetch(data.upload.putUrl, {
        method: "PUT",
        headers: { "content-type": uploadFile.type || "application/octet-stream" },
        body: uploadFile
      });

      await apiFetch(`/v1/evidence/${data.id}/complete`, { method: "POST", body: "{}" });
      router.push(`/evidence/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Capture failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="section">
      <div className="page-title">
        <div>
          <h1 style={{ margin: 0 }}>{t("capture")}</h1>
          <p className="page-subtitle">Upload a file and generate a signed report.</p>
        </div>
      </div>
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
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          {error && <div className="error-text">{error}</div>}
          <div>
            <Button onClick={handleCapture} disabled={busy}>
              {busy ? "Capturing..." : "Capture & Sign"}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
