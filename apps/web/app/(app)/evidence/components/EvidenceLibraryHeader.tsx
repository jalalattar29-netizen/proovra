import Link from "next/link";
import { FolderPlus, RefreshCw, Scale, Upload } from "lucide-react";
import { Button } from "../../../../components/ui";
import { EVIDENCE_LIBRARY_LEGAL_BOUNDARY } from "../lib/evidence-library-formatters";

export function EvidenceLibraryHeader({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <>
      <div className="evidence-library-header">
        <div>
          <span className="evidence-library-overline">
            <Scale size={14} />
            Evidence Operations Workspace
          </span>
          <h1>Evidence Library</h1>
          <p>
            Operational workspace for managing, reviewing, filtering, and exporting preserved evidence records across professional review workflows.
          </p>
        </div>

        <div className="evidence-library-toolbar">
          <Link href="/capture" className="evidence-library-link-button evidence-library-link-button--primary">
            <Upload size={16} />
            Upload / Capture Evidence
          </Link>
          <Link href="/cases" className="evidence-library-link-button">
            <FolderPlus size={16} />
            New Case
          </Link>
          <Button onClick={onRefresh} variant="secondary" disabled={refreshing}>
            <RefreshCw size={16} />
            {refreshing ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
      </div>

      <div className="evidence-library-callout">
        <strong>Legal boundary</strong>
        <p>{EVIDENCE_LIBRARY_LEGAL_BOUNDARY}</p>
      </div>
    </>
  );
}
