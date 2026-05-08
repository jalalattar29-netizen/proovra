import type { DetailWorkspaceState, EvidenceListItem } from "../lib/evidence-library-types";
import {
  formatBytes,
  formatUtcDateTime,
  safeText,
} from "../lib/evidence-library-formatters";
import { getCaptureMethodLabel, getIdentityLevelLabel } from "../lib/evidence-library-status";

export function MetadataPanel({
  item,
  detail,
}: {
  item: EvidenceListItem;
  detail: DetailWorkspaceState;
}) {
  const evidence = detail.evidence;
  const firstPart = detail.parts[0] ?? null;

  return (
    <section className="evidence-library-panel">
      <div className="evidence-library-panel__header">
        <div>
          <strong>Metadata inspection</strong>
          <p>Only recorded metadata is shown. Missing fields are not inferred.</p>
        </div>
      </div>

      <div className="evidence-library-definition-grid">
        <div><span>MIME type</span><strong>{safeText(evidence?.mimeType ?? firstPart?.mimeType, "Not recorded")}</strong></div>
        <div><span>Size</span><strong>{formatBytes(evidence?.sizeBytes ?? firstPart?.sizeBytes ?? null)}</strong></div>
        <div><span>Item count</span><strong>{String(evidence?.itemCount ?? item.itemCount)}</strong></div>
        <div><span>Created</span><strong>{formatUtcDateTime(evidence?.createdAt ?? item.createdAt)}</strong></div>
        <div><span>Uploaded</span><strong>{formatUtcDateTime(evidence?.uploadedAtUtc ?? null)}</strong></div>
        <div><span>Captured</span><strong>{formatUtcDateTime(evidence?.capturedAtUtc ?? null)}</strong></div>
        <div><span>Signed</span><strong>{formatUtcDateTime(evidence?.signedAtUtc ?? null)}</strong></div>
        <div><span>Case</span><strong>{detail.caseName ?? "Unassigned"}</strong></div>
        <div><span>Workspace</span><strong>{detail.capabilities.workspaceName}</strong></div>
        <div><span>Capture method</span><strong>{getCaptureMethodLabel(evidence?.captureMethod ?? item.captureMethod)}</strong></div>
        <div><span>Identity level</span><strong>{getIdentityLevelLabel(evidence?.identityLevelSnapshot ?? item.identityLevel)}</strong></div>
        <div><span>Submitted by</span><strong>{safeText(evidence?.submittedByEmail ?? item.submittedByEmail, "Not recorded")}</strong></div>
      </div>
    </section>
  );
}
