"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button, Card } from "../../../components/ui";
import { apiFetch } from "../../../lib/api";

export default function SharePage() {
  const params = useParams<{ id: string }>();
  const [reportUrl, setReportUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!params?.id) return;
    apiFetch(`/public/share/${params.id}`)
      .then((data) => setReportUrl(data.report?.url ?? null))
      .catch(() => setReportUrl(null));
  }, [params?.id]);
  return (
    <div className="section">
      <Card>
        <h2>Shared Evidence</h2>
        <p>Evidence #{params?.id}</p>
        <Button onClick={() => reportUrl && window.open(reportUrl, "_blank")}>
          Download Report
        </Button>
      </Card>
    </div>
  );
}
