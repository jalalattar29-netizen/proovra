import { Button } from "../../../../components/ui";
import type { DetailWorkspaceState, EvidenceListItem } from "../lib/evidence-library-types";
import { getDisplayTitle, getEvidenceTypeLabel, getStructureLabel } from "../lib/evidence-library-status";
import { formatUtcDateTime, shortId } from "../lib/evidence-library-formatters";

export function ReviewWorkspaceHeader({
  item,
  detail,
  onOpenRecord,
  onCopyVerificationLink,
  canCopyVerificationLink,
}: {
  item: EvidenceListItem;
  detail: DetailWorkspaceState;
  onOpenRecord: () => void;
  onCopyVerificationLink: () => void;
  canCopyVerificationLink: boolean;
}) {
  return (
    <div className="evidence-library-review-header">
      <div>
        <span className="evidence-library-overline">Review Workspace</span>
        <h2>{getDisplayTitle(detail.evidence ?? item)}</h2>
        <p>
          {getEvidenceTypeLabel(item, detail)} • {getStructureLabel(item, detail)} • Record {shortId(item.id)}
        </p>
      </div>

      <div className="evidence-library-toolbar">
        <div className="evidence-library-summary-strip">
          <span>Created {formatUtcDateTime(detail.evidence?.createdAt ?? item.createdAt)}</span>
          <span>{detail.caseName ?? "Unassigned"}</span>
          <span>{detail.capabilities.workspaceName}</span>
        </div>
        <div className="evidence-library-toolbar">
          <Button onClick={onOpenRecord} variant="secondary">
            Open Full Record
          </Button>
          {canCopyVerificationLink ? (
            <Button onClick={onCopyVerificationLink} variant="secondary">
              Copy Verification Link
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
