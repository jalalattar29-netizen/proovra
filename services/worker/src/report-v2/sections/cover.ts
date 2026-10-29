// D:\digital-witness\services\worker\src\report-v2\sections\cover.ts
import { reportAssetDataUrl } from "../asset-data-url.js";
import type { ReportViewModel } from "../types.js";
import { escapeHtml, safe } from "../formatters.js";
import { renderInlineQrBlock } from "../ui.js";
import { VERIFICATION_LIMITATION, formatTimestampForReportUtc, resolveEvidenceAcquisition } from "@proovra/shared";
import { buildSignalCards } from "../signal-cards.js";
const coverBrandIconUrl = reportAssetDataUrl("icon-192.png");
const coverHeaderLockupUrl = reportAssetDataUrl("report-header.png");
// `coverBrandIconUrl` is retained for any legacy section that may still reference
// it. The cover header itself uses the inline lockup image below.
void coverBrandIconUrl;

function titleCaseEvidenceType(value: string): string {
  if (!value.trim()) return "Digital evidence record";

  return value
    .replace(/\bMedia\b/g, "media")
    .replace(/\bEvidence\b/g, "evidence")
    .replace(/\bPackage\b/g, "package")
    .replace(/\bRecord\b/g, "record");
}

function buildCoverSubtitle(vm: ReportViewModel): string {
  const summary = vm.contentSummary;

  const kinds = [
    summary.videoCount > 0 ? "Video" : null,
    summary.imageCount > 0 ? "Image" : null,
    summary.pdfCount > 0 ? "PDF" : null,
    summary.audioCount > 0 ? "Audio" : null,
    summary.textCount > 0 ? "Text" : null,
    summary.otherCount > 0 ? "Other" : null,
  ].filter(Boolean) as string[];

  const structure =
    summary.itemCount > 1 ? "Multipart evidence package" : "Single evidence item";

  const itemLabel = `${summary.itemCount} item${
    summary.itemCount === 1 ? "" : "s"
  }`;

  const kindLabel = kinds.length > 0 ? kinds.join(", ") : "Digital evidence";
  const sizeLabel =
    summary.totalSizeDisplay || vm.meta.fileSizeLabel || "Size not recorded";

  return `${structure} • ${itemLabel} • ${kindLabel} • ${sizeLabel}`;
}

function renderDecisionIndicator(params: {
  label: string;
  value: string;
  tone: "success" | "warning" | "danger" | "neutral";
  mark: string;
}): string {
  // The compact value is THE canonical layer/state label (getTrustLayerStateLabel),
  // passed in by the caller: only the PASSED state of a layer reads as verified or anchored.
  const compactValue = params.value;

  return `
    <div class="cover-decision-indicator tone-${params.tone}">
      <div class="cover-decision-line">
        <span class="cover-decision-mark">
          ${escapeHtml(params.mark)}
        </span>
        <span class="cover-decision-label">
          ${escapeHtml(params.label)}
        </span>
      </div>

      <div class="cover-decision-value">
        ${escapeHtml(compactValue)}
      </div>
    </div>
  `;
}

function renderCoverEvidenceVisual(vm: ReportViewModel): string {
  const hero = vm.presentation.buckets.heroItem;

  if (!hero) {
    return `
      <div class="cover-evidence-visual cover-evidence-placeholder">
        <div class="cover-evidence-placeholder-kind">EVIDENCE</div>
        <div class="cover-evidence-placeholder-note">
          Evidence represented by preserved metadata and technical references.
        </div>
      </div>
    `;
  }

  const asset = hero.asset;
  const fileName = safe(
    asset.originalFileName || asset.label,
    "Unnamed evidence item"
  );

  if (asset.previewDataUrl) {
    return `
      <div class="cover-evidence-visual">
        <img src="${asset.previewDataUrl}" alt="${escapeHtml(fileName)}" />
      </div>
    `;
  }

  return `
    <div class="cover-evidence-visual cover-evidence-placeholder">
      <div class="cover-evidence-placeholder-kind">${escapeHtml(
        hero.previewRenderKind.toUpperCase()
      )}</div>
      <div class="cover-evidence-placeholder-note">
        Evidence represented by preserved metadata and technical references.
      </div>
    </div>
  `;
}

export function renderCoverSection(vm: ReportViewModel): string {
  // The cover states the evidence's own verification layers (the first five
  // of the eight signal cards) — never an overall verdict, confidence or score.
  // Its tone follows core integrity: a failed signal is danger.
  const cards = buildSignalCards(vm);
  const core = cards.find((c) => c.key === "core_integrity");
  const presentationTone = cards.some((c) => c.tone === "danger")
    ? "danger"
    : core?.status === "Verified"
      ? "success"
      : "warning";

  const integrityBadgeClass =
    presentationTone === "success"
      ? "badge-success"
      : presentationTone === "danger"
        ? "badge-danger"
        : "badge-warning";

  const integrityBadgeText = core?.status === "Verified" ? "Recorded integrity verified" : `Core integrity ${(core?.status ?? "Unavailable").toLowerCase()}`;
  const primaryItemCount = vm.contentItems.filter(
    (item) => item.artifactRole === "primary_evidence"
  ).length;

  const primaryHash =
    vm.primaryContentItem?.sha256 ||
    vm.technicalAppendix.fileSha256 ||
    "Not recorded";

  const evidenceType = titleCaseEvidenceType(
    vm.meta.publicEvidenceTypeLabel || "Digital evidence record"
  );

  const leadItemLabel = safe(
    vm.primaryContentItem?.originalFileName || vm.primaryContentItem?.label,
    "No identified lead item"
  );
  const leadItemDisplayLabel =
    primaryItemCount > 1
      ? `Primary evidence set (${primaryItemCount} items)`
      : leadItemLabel;

  const reportMode =
    vm.presentationMode === "simple"
      ? "Compact review report"
      : vm.presentationMode === "medium"
        ? "Balanced review report"
        : "Full forensic report";

  const verifyUrl = vm.verifyUrl.trim();

  // UC-TRUST-008 — the report says which stored bytes it certifies, and as
  // of when; it is not a statement about the stored object afterwards.
  const certified = vm.certifiedOriginal;
  const certifiedBlock = certified
    ? `<div class="cover-verify-hint" data-certified-original>
        Certifies the original with SHA-256 ${escapeHtml(certified.recordedSha256)}
        (stored object version${certified.objectVersionIds.length === 1 ? "" : "s"}
        ${escapeHtml(certified.objectVersionIds.map((v) => v ?? "unversioned").join(", "))}),
        re-read from storage and matched to the signed fingerprint at ${escapeHtml(certified.rereadAtUtc)}.
        Later changes to the stored object are not covered by this report; check Public Verify for its current state.
      </div>`
    : "";

  // CANONICAL VERIFICATION IDENTITY (owner decision 2026-10-14) — every
  // report prints the record's permanent verification link and QR code. The
  // only exception is a page withdrawn at issuance for a legal, privacy or
  // security reason, and the report says exactly that.
  const verificationBlock = vm.publicVerificationPublished === false
    ? `
    <div class="cover-verify-texts" data-public-verification="withdrawn">
      <div class="cover-verify-title">Public Verification</div>
      <div class="cover-verify-hint">Verification page withdrawn</div>
      <div class="cover-verify-hint">This record's verification page was withdrawn when this report was issued (a legal, privacy or security action), so no verification link is printed.</div>
      ${certifiedBlock}
    </div>
  `
    : `
    <div class="cover-verify-qr-wrap">
      ${
        vm.qr.publicDataUrl
          ? renderInlineQrBlock(vm.qr.publicDataUrl, vm.qr.publicLabel)
          : `<div class="cover-verify-placeholder">QR unavailable</div>`
      }
    </div>
    <div class="cover-verify-texts">
      <div class="cover-verify-title">Public Verification</div>
      <div class="cover-verify-hint">Scan QR code or open verification page — no login required. The page verifies this record; it does not publish the original evidence files.</div>
      ${certifiedBlock}
      <a
        class="cover-verify-url"
        href="${escapeHtml(verifyUrl)}"
        target="_blank"
        rel="noopener noreferrer"
      >${escapeHtml(verifyUrl)}</a>
    </div>
  `;


  return `
    <section class="report-cover report-cover-premium cover-tone-${presentationTone}">
      <div class="cover-certificate-card cover-tone-${presentationTone}">
        <div class="cover-certificate-top">
          <img
            class="cover-header-lockup"
            src="${escapeHtml(coverHeaderLockupUrl)}"
            alt="PROOVRA — Integrity in Every Evidence"
          />

          <div class="cover-top-badge badge ${integrityBadgeClass}">
            ${escapeHtml(integrityBadgeText)}
          </div>
        </div>

        <div class="cover-certificate-body cover-premium-body">
          <div class="cover-decision-hero">
            <div class="cover-eyebrow">Decision Page</div>

            <h1 class="cover-certificate-title">
              Digital Evidence Verification Record
            </h1>

            <div class="cover-certificate-subtitle">
              ${escapeHtml(buildCoverSubtitle(vm))}
            </div>

            <div class="cover-status-stamp ${integrityBadgeClass}">
              <span>${presentationTone === "success" ? "✓" : "!"}</span>
              <strong>${escapeHtml(integrityBadgeText)}</strong>
            </div>
          </div>

          <div class="cover-decision-grid cover-trust-signal-grid">
            ${cards
              .slice(0, 5)
              .map((c) => renderDecisionIndicator({ label: c.label, value: c.status, tone: c.tone, mark: c.mark }))
              .join("")}
          </div>
                    <div class="cover-main-grid">
            <div class="cover-evidence-panel">
              ${renderCoverEvidenceVisual(vm)}

              <div class="cover-evidence-meta">
                <div class="cover-panel-title">Evidence Snapshot</div>

                <div class="cover-snapshot-grid">
                  <div>
                    <div class="cover-meta-label">Evidence Type</div>
                    <div class="cover-meta-value">${escapeHtml(evidenceType)}</div>
                  </div>
                  <div>
                    <div class="cover-meta-label">Structure</div>
                    <div class="cover-meta-value">${escapeHtml(vm.structureLabel)}</div>
                  </div>
                  <div>
                    <div class="cover-meta-label">Item Count</div>
                    <div class="cover-meta-value">${escapeHtml(
                      String(vm.contentSummary.itemCount)
                    )}</div>
                  </div>
                  <div>
<div class="cover-meta-label">${
  primaryItemCount > 1 ? "Primary Evidence Set" : "Lead Item"
}</div>
<div class="cover-meta-value">${escapeHtml(leadItemDisplayLabel)}</div>
                  </div>
                </div>
              </div>
            </div>

            <div class="cover-verify-box cover-verify-box-premium">
              ${verificationBlock}
            </div>
          </div>

          <div class="cover-meta-grid">
            <div class="cover-meta-card">
              <div class="cover-meta-label">Verification Reference</div>
              <div class="cover-meta-value">${escapeHtml(vm.evidenceReference)}</div>
            </div>

            <div class="cover-meta-card">
              <div class="cover-meta-label">Generated UTC</div>
              <div class="cover-meta-value">${escapeHtml(formatTimestampForReportUtc(vm.generatedAtUtc))}</div>
            </div>

            <div class="cover-meta-card">
              <div class="cover-meta-label">Report Mode</div>
              <div class="cover-meta-value">${escapeHtml(reportMode)}</div>
            </div>

            <div class="cover-meta-card">
              <div class="cover-meta-label">Verification Status</div>
              <div class="cover-meta-value">${escapeHtml(vm.verificationStatusLabel)}</div>
            </div>

            <div class="cover-meta-card">
              <div class="cover-meta-label">Evidence Status At Report Generation</div>
              <div class="cover-meta-value">${escapeHtml(vm.recordStatusLabel)}</div>
            </div>

            <div class="cover-meta-card cover-meta-card-wide">
<div class="cover-meta-label">${
  // Wire contract D — digest semantics follow the STORED parts.
  vm.technicalPartCount > 1
    ? vm.primaryContentItem?.userItemKind === "recording" &&
      (vm.primaryContentItem.technicalParts?.length ?? 0) > 1
      ? "First recording part SHA-256 (segmented recording — per-part hashes follow)"
      : "Lead item SHA-256 (multipart package — per-part hashes follow)"
    : "Original file SHA-256"
}</div>
              <div class="cover-meta-value cover-meta-value-code cover-primary-hash">
                ${escapeHtml(primaryHash)}
              </div>
            </div>
          </div>

<div class="cover-boundary-note cover-boundary-inline">
  <div class="cover-boundary-title">Report boundary.</div>
  <div class="cover-boundary-followup">${escapeHtml(VERIFICATION_LIMITATION)}</div>
  <div class="cover-boundary-followup" data-acquisition-boundary>${escapeHtml(
    resolveEvidenceAcquisition({ acquisitionMode: vm.meta.acquisitionMode ?? null }).boundary,
  )}</div>
</div>
      </div>
    </section>
  `;
}
