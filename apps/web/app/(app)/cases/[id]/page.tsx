"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card, ListRow, Badge } from "../../../../components/ui";
import { apiFetch } from "../../../../lib/api";

export default function CaseDetailPage() {
  const params = useParams<{ id: string }>();
  const [name, setName] = useState("Case");

  useEffect(() => {
    if (!params?.id) return;
    apiFetch(`/v1/cases/${params.id}`)
      .then((data) => setName(data.case?.name ?? "Case"))
      .catch(() => setName("Case"));
  }, [params?.id]);
  return (
    <div className="section">
      <div className="page-title">
        <div>
          <h1 style={{ margin: 0 }}>{name}</h1>
          <p className="page-subtitle">Evidence grouped under this case.</p>
        </div>
      </div>
      <Card>
        <ListRow title="Photo" subtitle="Today" badge={<Badge tone="signed">SIGNED</Badge>} />
      </Card>
    </div>
  );
}
