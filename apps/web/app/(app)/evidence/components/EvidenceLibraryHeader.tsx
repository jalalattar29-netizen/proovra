import type React from "react";
import Link from "next/link";
import { FolderPlus, RefreshCw, Scale, Upload } from "lucide-react";
import { PageHeader } from "../../../../components/ui";
import { Button } from "../../../../components/ui/Button";
import { Card } from "../../../../components/ui/Card";
import { Badge } from "../../../../components/ui/Badge";
import { EVIDENCE_LIBRARY_LEGAL_BOUNDARY } from "../lib/evidence-library-formatters";

const LINK_BASE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  minHeight: 42,
  padding: "0 18px",
  borderRadius: 12,
  fontSize: 14,
  fontWeight: 650,
  textDecoration: "none",
};

const SECONDARY_LINK_STYLE: React.CSSProperties = {
  ...LINK_BASE,
  background: "var(--surface-card, #ffffff)",
  color: "var(--ink-primary, #0f172a)",
  border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
  boxShadow: "var(--shadow-card, 0 1px 2px rgba(15,23,42,0.04))",
};

const PRIMARY_LINK_STYLE: React.CSSProperties = {
  ...LINK_BASE,
  background: "var(--btn-primary-bg)",
  color: "var(--btn-primary-color)",
  border: "1px solid var(--btn-primary-border)",
  boxShadow: "var(--btn-primary-shadow)",
};

export function EvidenceLibraryHeader({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <>
      <PageHeader
        className="evidence-library-header"
        eyebrow={
          <span
            className="evidence-library-overline"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <Scale size={13} />
            Evidence Operations Workspace
          </span>
        }
        title="Evidence Library"
        subtitle="Operational workspace for managing, reviewing, filtering, and exporting preserved evidence records across professional review workflows."
        secondaryActions={
          <>
            <Link
              href="/cases"
              className="evidence-library-link-button"
              style={SECONDARY_LINK_STYLE}
            >
              <FolderPlus size={16} />
              New Case
            </Link>
            <Button
              onClick={onRefresh}
              variant="secondary"
              disabled={refreshing}
              leadingIcon={<RefreshCw size={16} />}
            >
              {refreshing ? "Refreshing..." : "Refresh"}
            </Button>
          </>
        }
        primaryAction={
          <Link
            href="/capture"
            className="evidence-library-link-button evidence-library-link-button--primary"
            style={PRIMARY_LINK_STYLE}
          >
            <Upload size={16} />
            Upload / Capture Evidence
          </Link>
        }
      />

      <Card
        variant="status"
        tone="governance"
        padding="comfortable"
        className="evidence-library-callout"
        header={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Badge tone="governance" subtle>
              Legal boundary
            </Badge>
          </div>
        }
      >
        <p
          className="evidence-library-muted"
          style={{ margin: 0, lineHeight: 1.6 }}
        >
          {EVIDENCE_LIBRARY_LEGAL_BOUNDARY}
        </p>
      </Card>
    </>
  );
}
