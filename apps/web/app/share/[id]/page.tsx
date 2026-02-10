"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button, Card } from "../../../components/ui";
import { apiFetch } from "../../../lib/api";
import { Icons } from "../../../components/icons";

type PageState = "loading" | "success" | "error";

export default function SharePage() {
  const params = useParams<{ id: string }>();
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  const [state, setState] = useState<PageState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!params?.id) {
      setState("error");
      setErrorMessage("Invalid share link: no evidence ID provided.");
      return;
    }
    
    setState("loading");
    setErrorMessage(null);
    
    apiFetch(`/public/share/${params.id}`)
      .then((data) => {
        const url = data.report?.url ?? null;
        if (url) {
          setReportUrl(url);
          setState("success");
        } else {
          setErrorMessage("Report not available. The evidence may not have been processed yet.");
          setState("error");
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : "Failed to load report";
        setErrorMessage(msg || "Unable to retrieve the shared evidence. Please check the link.");
        setState("error");
      });
  }, [params?.id]);

  if (state === "loading") {
    return (
      <div className="section">
        <Card>
          <div style={{ display: "flex", alignItems: "center", gap: 12, justifyContent: "center", padding: "32px 16px" }}>
            <div style={{ animation: "spin 1s linear infinite" }}>
              <Icons.Fingerprint />
            </div>
            <span>Loading shared evidence...</span>
          </div>
          <style>{`
            @keyframes spin {
              from { transform: rotate(0deg); }
              to { transform: rotate(360deg); }
            }
          `}</style>
        </Card>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="section">
        <Card>
          <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 32 }}>⚠️</div>
            <div>
              <h2 style={{ margin: "0 0 8px 0" }}>Unable to Load Evidence</h2>
              <p style={{ margin: 0, color: "var(--color-muted)", fontSize: 14 }}>
                {errorMessage}
              </p>
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <p style={{ margin: "0 0 12px 0", fontSize: 13, color: "var(--color-muted)" }}>
              Evidence ID: <code style={{ backgroundColor: "#f0f0f0", padding: "2px 6px", borderRadius: 4 }}>{params?.id}</code>
            </p>
            <p style={{ margin: 0, fontSize: 13, color: "var(--color-muted)" }}>
              If you believe this is an error, please contact support at{" "}
              <a href="mailto:support@proovra.com" style={{ color: "var(--color-blue)" }}>
                support@proovra.com
              </a>
            </p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="section">
      <Card>
        <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 32 }}>✓</div>
          <div>
            <h2 style={{ margin: "0 0 8px 0" }}>Shared Evidence Report</h2>
            <p style={{ margin: 0, color: "var(--color-muted)", fontSize: 14 }}>
              Evidence ID: <code style={{ backgroundColor: "#f0f0f0", padding: "2px 6px", borderRadius: 4 }}>{params?.id}</code>
            </p>
          </div>
        </div>
        <div style={{ marginTop: 20, width: "100%" }}>
          <Button
            onClick={() => reportUrl && window.open(reportUrl, "_blank")}
            disabled={!reportUrl}
            className="w-full"
          >
            {reportUrl ? "Download Report" : "Report Unavailable"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
