/**
 * IntegrityContextCard — Section 9 (Security & Integrity).
 *
 * Digest / fingerprint / signature / RFC3161 timestamp / OpenTimestamps
 * Bitcoin anchoring / immutable-storage state for the authenticated
 * reviewer. Wording mirrors the PDF report + shared trust-decision labels.
 * Legacy anchoring/receipt vocabulary and content-credential acronyms are
 * intentionally excluded.
 */

"use client";

import { ShieldCheck } from "lucide-react";
import { TechnicalAppendixCard } from "./TechnicalAppendixCard";
import { AdvisoryNote, MetadataRows } from "./MetadataRow";
import {
  buildIntegrityRows,
  type IntegrityEvidenceInput,
  type PreservationInput,
} from "./sections-model";

export function IntegrityContextCard({
  preservation,
  evidence,
  multipart,
}: {
  preservation: PreservationInput;
  evidence: IntegrityEvidenceInput;
  multipart: boolean;
}) {
  const bodyRows = buildIntegrityRows({ preservation, evidence, multipart });
  return (
    <TechnicalAppendixCard
      icon={ShieldCheck}
      title="Security & Integrity"
      subtitle="Cryptographic, timestamp, anchoring and storage state"
      testId="ta-section-integrity"
    >
      <MetadataRows
        rows={bodyRows}
        empty="No integrity materials were recorded for this evidence."
      />
      <AdvisoryNote>
        These values summarize the recorded integrity state. Full signature,
        RFC 3161 timestamp token, and OpenTimestamps proofs are preserved in
        the Verification Package and the verification endpoint.
      </AdvisoryNote>
    </TechnicalAppendixCard>
  );
}
