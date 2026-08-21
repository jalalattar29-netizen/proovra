/**
 * EvidenceTechnicalAppendix — enterprise "Technical Evidence Context" section
 * for the authenticated Evidence Detail page.
 *
 * Primary reviewer-facing source of truth for the technical context that the
 * PDF report and Verification Package render. Ten sections, each a clean
 * card: Evidence Acquisition, Capture Device, Camera / EXIF, Exposure,
 * Location, Client / Browser Environment, Upload Session, Technical Metadata
 * (per part), Security & Integrity, and Chain of Custody summary.
 *
 * Data sources (no hardcoding):
 *   - GET /v1/evidence/:id/technical-metadata (internal projection) →
 *     acquisition, capture device/environment, EXIF/exposure, per-part table.
 *   - The already-fetched review-workspace payload → location, preservation /
 *     integrity, custody summary.
 *
 * All labels are humanized upstream or by the pure section-model helpers;
 * no raw enum values are rendered.
 */

"use client";

import { useEffect, useState } from "react";
import {
  Camera,
  Aperture,
  Fingerprint,
  Layers,
  MonitorSmartphone,
  Smartphone,
  UploadCloud,
} from "lucide-react";

import { apiFetch } from "../../../../../../lib/api";
import type { ReviewWorkspaceResponse } from "../../review-workspace-types";
import { TechnicalAppendixCard } from "./TechnicalAppendixCard";
import { TechnicalDisclosure } from "./TechnicalDisclosure";
import {
  AdvisoryNote,
  AppendixBadge,
  AppendixEmpty,
  MetadataRows,
} from "./MetadataRow";
import { EvidencePartMetadataTable } from "./EvidencePartMetadataTable";
import { FullExifAccordion } from "./FullExifAccordion";
import { LocationContextCard } from "./LocationContextCard";
import { IntegrityContextCard } from "./IntegrityContextCard";
import type { TechnicalMetadataInternal } from "./types";
import {
  buildAcquisitionModel,
  buildCameraRows,
  buildCaptureDeviceRows,
  buildClientAdvancedRows,
  buildClientEnvRows,
  buildCustodySummaryRows,
  buildExposureRows,
  buildFullExifRows,
  buildUploadSessionRows,
} from "./sections-model";

const DEVICE_ADVISORY =
  "Device and browser values are reported by the client environment. They may support context, but do not independently prove physical presence, authorship, truth, or admissibility.";

export function EvidenceTechnicalAppendix({
  evidenceId,
  workspace,
  onOpenCustody,
}: {
  evidenceId: string;
  workspace: ReviewWorkspaceResponse;
  onOpenCustody?: () => void;
}) {
  const [tm, setTm] = useState<TechnicalMetadataInternal | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = (await apiFetch(
          `/v1/evidence/${encodeURIComponent(evidenceId)}/technical-metadata`,
        )) as { technicalMetadata: TechnicalMetadataInternal | null };
        if (cancelled) return;
        setTm(res?.technicalMetadata ?? null);
        setState("ready");
      } catch {
        if (cancelled) return;
        setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [evidenceId]);

  const ev = workspace.evidence as unknown as Record<string, unknown>;
  const pm = workspace.preservationMatrix;
  const perParts = tm?.perParts ?? null;
  const multipart =
    Boolean(workspace.relationships?.multipart) ||
    (perParts != null && perParts.length > 1);

  const acquisition = buildAcquisitionModel(tm);
  const captureDeviceRows = buildCaptureDeviceRows(tm);
  const cameraRows = buildCameraRows(tm);
  const fullExifRows = buildFullExifRows(tm);
  const exposureRows = buildExposureRows(tm);
  const clientRows = buildClientEnvRows(tm);
  const clientAdvanced = buildClientAdvancedRows(tm);

  const leadItem =
    perParts?.find((p) => p.role === "Primary")?.filename ??
    perParts?.[0]?.filename ??
    null;

  const uploadRows = buildUploadSessionRows({
    tm,
    itemCount:
      (ev.itemCount as number | null) ?? workspace.relationships?.itemCount ?? null,
    multipart,
    partCount: perParts?.length ?? workspace.parts?.length ?? null,
    leadItem,
    uploadedAtUtc: (ev.uploadedAtUtc as string | null) ?? null,
  });

  const forensicEvents = workspace.custodyLifecycle?.forensicEvents ?? [];
  const custodyRows = buildCustodySummaryRows({
    forensicEventCount:
      workspace.custodyDisplayCounts?.currentForensicEvents ??
      workspace.custodyLifecycle?.forensicEventCount ??
      null,
    firstEventAtUtc: forensicEvents[0]?.atUtc ?? null,
    latestEventAtUtc: forensicEvents[forensicEvents.length - 1]?.atUtc ?? null,
    latestEventHash: forensicEvents[forensicEvents.length - 1]?.eventHash ?? null,
    hashChainValid: pm?.custodyChain?.valid ?? null,
    status: (ev.status as string | null) ?? null,
  });

  if (state === "loading") {
    return (
      <div className="ta-root" data-testid="evidence-technical-appendix">
        <p className="ta-empty">Loading technical evidence context…</p>
      </div>
    );
  }

  return (
    <div className="ta-root" data-testid="evidence-technical-appendix">
      {/* The copy column is the section-header contract, not decoration: the
          title and its sentence are two ROWS. Without it they became two
          columns of `.ta-intro`'s horizontal axis and the heading was split
          across the row from the sentence that explains it. */}
      <div className="ta-intro">
        <div className="ta-intro-copy">
          <h2 className="ta-intro-title">Technical Evidence Context</h2>
          <p className="ta-intro-sub">
            The same acquisition, device, media and integrity context recorded
            in the PDF report and Verification Package, presented for
            reviewers.
          </p>
        </div>
      </div>

      <div className="ta-grid">
        {/* Section 1 — Evidence Acquisition */}
        <TechnicalAppendixCard
          icon={UploadCloud}
          title="Evidence Acquisition"
          subtitle="How this evidence entered PROOVRA"
          badge={
            <AppendixBadge tone={acquisition.isIntake ? "info" : "neutral"}>
              {acquisition.isIntake ? "Secure Intake Link" : "Authenticated upload"}
            </AppendixBadge>
          }
          testId="ta-section-acquisition"
        >
          <MetadataRows
            rows={acquisition.rows}
            empty="Acquisition context was not recorded."
          />
          {acquisition.roleModel.length > 0 ? (
            <div className="ta-subblock">
              <span className="ta-subblock-title">Submitter &amp; identity</span>
              <MetadataRows rows={acquisition.roleModel} empty="Not recorded." />
            </div>
          ) : null}
        </TechnicalAppendixCard>

        {/* Section 2 — Capture Device */}
        <TechnicalAppendixCard
          icon={Smartphone}
          title="Capture Device"
          subtitle="Client-reported device & submission channel"
          testId="ta-section-capture-device"
        >
          <MetadataRows
            rows={captureDeviceRows}
            empty="No device metadata was recorded for this evidence."
          />
          {captureDeviceRows.length > 0 ? (
            <AdvisoryNote>{DEVICE_ADVISORY}</AdvisoryNote>
          ) : null}
        </TechnicalAppendixCard>

        {/* Section 3 — Camera / EXIF */}
        <TechnicalAppendixCard
          icon={Camera}
          title="Camera / EXIF"
          subtitle="File-embedded camera metadata"
          testId="ta-section-camera"
        >
          {cameraRows.length > 0 ? (
            <>
              <MetadataRows rows={cameraRows} empty="No EXIF camera metadata recorded." />
              <FullExifAccordion rows={fullExifRows} multipart={multipart} />
            </>
          ) : (
            <AppendixEmpty>
              No EXIF camera metadata recorded for this item.
            </AppendixEmpty>
          )}
        </TechnicalAppendixCard>

        {/* Section 4 — Exposure */}
        {exposureRows.length > 0 ? (
          <TechnicalAppendixCard
            icon={Aperture}
            title="Exposure"
            subtitle="Photographic exposure settings"
            testId="ta-section-exposure"
          >
            <MetadataRows rows={exposureRows} empty="No exposure metadata recorded." />
          </TechnicalAppendixCard>
        ) : null}

        {/* Section 5 — Location */}
        <LocationContextCard location={workspace.sourceCaptureLocation} />

        {/* Section 6 — Client / Browser Environment */}
        <TechnicalAppendixCard
          icon={MonitorSmartphone}
          title="Client / Browser Environment"
          subtitle="Reported client software environment"
          testId="ta-section-client-env"
        >
          <MetadataRows
            rows={clientRows}
            empty="No browser metadata available for this evidence."
          />
          {clientAdvanced.length > 0 ? (
            <TechnicalDisclosure
              title="Advanced client details"
              data-testid="ta-client-advanced"
            >
              <MetadataRows rows={clientAdvanced} empty="Not recorded." />
              <AdvisoryNote>
                The raw User-Agent and IP are never stored — only a hash and a
                masked IP are retained.
              </AdvisoryNote>
            </TechnicalDisclosure>
          ) : null}
        </TechnicalAppendixCard>

        {/* Section 7 — Upload Session */}
        <TechnicalAppendixCard
          icon={UploadCloud}
          title="Upload Session"
          subtitle="Ingest session & composition"
          testId="ta-section-upload-session"
        >
          <MetadataRows rows={uploadRows} empty="No upload session metadata recorded." />
        </TechnicalAppendixCard>

      </div>

      {/* ---------------------------------------------------------------
          FULL-WIDTH SECTIONS.

          Everything below is an UNBOUNDED COLLECTION: its height is a
          function of how many records exist, not of a fixed field list. In
          the peer grid a single 23-part record dictated the row height and
          left the neighbouring column empty. These get the full measure. */}

      <div className="ta-wide">
        {/* Section 8 — Technical Metadata (per part) */}
        <TechnicalAppendixCard
          icon={Layers}
          title="Technical Metadata"
          subtitle="Per-part media & digest detail"
          badge={
            perParts && perParts.length > 0 ? (
              <AppendixBadge tone="neutral">
                {perParts.length} {perParts.length === 1 ? "part" : "parts"}
              </AppendixBadge>
            ) : undefined
          }
          testId="ta-section-technical-metadata"
        >
          <EvidencePartMetadataTable parts={perParts} />
        </TechnicalAppendixCard>

        {/* Section 9 — Security & Integrity */}
        <IntegrityContextCard
          multipart={multipart}
          preservation={{
            recordedIntegrityVerifiedAtUtc: pm?.recordedIntegrityVerifiedAtUtc ?? null,
            signature: {
              recorded: Boolean(pm?.signature?.recorded),
              valid: Boolean(pm?.signature?.valid),
              keyId: pm?.signature?.keyId ?? null,
              keyVersion: pm?.signature?.keyVersion ?? null,
            },
            tsa: {
              status: pm?.tsa?.status ?? null,
              provider: pm?.tsa?.provider ?? null,
              timestampedDigestLabel: pm?.tsa?.timestampedDigestLabel ?? "",
            },
            ots: {
              effectiveStatus: pm?.ots?.effectiveStatus ?? pm?.ots?.status ?? null,
              proofPresent: Boolean(pm?.ots?.proofPresent),
              bitcoinTxid: pm?.ots?.bitcoinTxid ?? null,
              anchoredAtUtc: pm?.ots?.anchoredAtUtc ?? null,
              calendar: pm?.ots?.calendar ?? null,
            },
            storage: {},
          }}
          evidence={{
            evidenceRef: (ev.id as string | null) ?? null,
            fileSha256: (ev.fileSha256 as string | null) ?? null,
            fingerprintHash: (ev.fingerprintHash as string | null) ?? null,
            tsaSerialNumber: (ev.tsaSerialNumber as string | null) ?? null,
            storageObjectLockMode: (ev.storageObjectLockMode as string | null) ?? null,
            storageObjectLockRetainUntilUtc:
              (ev.storageObjectLockRetainUntilUtc as string | null) ?? null,
          }}
        />

        {/* Section 10 — Chain of Custody summary */}
        <TechnicalAppendixCard
          icon={Fingerprint}
          title="Chain of Custody"
          subtitle="Forensic event summary"
          testId="ta-section-custody-summary"
        >
          <MetadataRows
            rows={custodyRows}
            empty="No custody events recorded."
          />
          {/* The canonical secondary action. It was `ta-link-btn`, which paints
              no surface — white text on a white card. */}
          <div className="ta-card-footer">
            <button
              type="button"
              className="app-secondary-action ta-custody-open"
              onClick={onOpenCustody ?? undefined}
              disabled={!onOpenCustody}
              title={
                onOpenCustody
                  ? "Open the full custody timeline"
                  : "The full custody timeline is not available for this record."
              }
              data-ta-custody-open
            >
              Open full custody timeline
            </button>
            {!onOpenCustody ? (
              <p className="ta-card-note" data-ta-custody-disabled-reason>
                The full custody timeline is not available for this record.
              </p>
            ) : null}
          </div>
        </TechnicalAppendixCard>
      </div>

      {state === "error" ? (
        <p className="ta-empty">
          Some technical metadata could not be loaded. Integrity and custody
          context above is unaffected.
        </p>
      ) : null}
    </div>
  );
}
