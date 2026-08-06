import { ReportViewModel, KeyValueRow } from "../types.js";
import {
  PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE,
  PROOVRA_MULTIPART_RECOMPUTATION_NOTE,
  PROOVRA_MULTIPART_REVIEWER_EXPLANATION,
} from "@proovra/shared-evidence-presentation";
import {
  describeTsaDigestSource,
} from "@proovra/shared";
import {
  renderCallout,
  renderKeyValueGrid,
  renderMonoBlock,
  renderPageSection,
} from "../ui.js";
import { renderTechnicalSummaryAppendixInner } from "./technical-summary.js";
import { escapeHtml } from "../formatters.js";

/**
 * Phase D Blocker 3 — render a per-component package-presence flag truthfully.
 *
 *   true  -> the supplied "presentLabel" (e.g. "Present" / "Included").
 *   false -> "Not available".
 *   null  -> "Presence not independently confirmed (legacy package)".
 *
 * The third state is critical: prior to Phase D, packages did not persist
 * per-component artifact presence. Treating those as success would
 * overclaim. Treating them as "Not available" would falsely contradict the
 * archive. We name them honestly.
 */

function renderAppendixSection(
  title: string,
  subtitle: string,
  body: string,
  opts?: { className?: string }
): string {
  const className = opts?.className ? ` ${escapeHtml(opts.className)}` : "";

  return `
    <section class="technical-appendix-block${className}">
      <div class="technical-appendix-block-head">
        <h3 class="technical-appendix-block-title">${escapeHtml(title)}</h3>
        <div class="technical-appendix-block-subtitle">${escapeHtml(subtitle)}</div>
      </div>
      <div class="technical-appendix-block-body">
        ${body}
      </div>
    </section>
  `;
}

function hasMeaningfulTechnicalValue(value: string | null | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();

  return Boolean(
    normalized &&
      normalized !== "n/a" &&
      normalized !== "na" &&
      normalized !== "not recorded" &&
      normalized !== "not reported" &&
      normalized !== "none" &&
      normalized !== "null" &&
      normalized !== "undefined"
  );
}

function hasRecordedPublicAnchoring(vm: ReportViewModel): boolean {
  const rows = vm.technicalAppendix.anchoringRows;

  return rows.some(
    (row) =>
      [
        "Anchor Anchored At (UTC)",
        "Anchor Transaction ID",
      ].includes(row.label) && hasMeaningfulTechnicalValue(row.value)
  );
}

function normalizeAnchoringRows(vm: ReportViewModel): KeyValueRow[] {
  const publicAnchoringRecorded = hasRecordedPublicAnchoring(vm);

  return vm.technicalAppendix.anchoringRows
    .filter((row) => hasMeaningfulTechnicalValue(row.value))
    .map((row) => {
      if (row.label === "Anchor Mode" && publicAnchoringRecorded) {
        return { ...row, value: "Bitcoin anchoring recorded" };
      }
      return row;
    });
}

export function renderTechnicalAppendixSection(vm: ReportViewModel): string {

const hasSignatureRows =
  Array.isArray(vm.technicalAppendix.signatureRows) &&
  vm.technicalAppendix.signatureRows.some((row) =>
    hasMeaningfulTechnicalValue(row.value)
  );
const shouldRenderSignature = hasSignatureRows;
  const anchoringRows = normalizeAnchoringRows(vm);

  const filteredIdentityRows = vm.technicalIdentityRows.filter(
    (row) => !row.label?.toLowerCase().includes("last accessed")
  );

  const tsaMessageImprint = hasMeaningfulTechnicalValue(
    vm.technicalAppendix.tsaMessageImprint
  )
    ? String(vm.technicalAppendix.tsaMessageImprint)
    : "";
  // Phase IA-digest-policy — the timestamped-digest label MUST be
  // sourced from the persisted `tsaInputKind` column (CANONICAL_PACKAGE_SHA256
  // or FILE_SHA256), not hard-coded. The technical-model already maps
  // the kind into `vm.technicalAppendix.timestampDigestLabel`; the
  // fallback below covers the edge case where that field is empty (e.g.
  // a legacy snapshot model). Both paths now go through the same
  // shared helper so a future divergence is caught by the digest-policy
  // tests.
  const timestampDigestLabel =
    vm.technicalAppendix.timestampDigestLabel ??
    describeTsaDigestSource(vm.technicalAppendix.tsaInputKind ?? null);

  const otsHash = hasMeaningfulTechnicalValue(vm.technicalAppendix.otsHash)
    ? String(vm.technicalAppendix.otsHash)
    : "";

  const anchorHash = hasMeaningfulTechnicalValue(vm.technicalAppendix.anchorHash)
    ? String(vm.technicalAppendix.anchorHash)
    : "";

  const otsDetail = hasMeaningfulTechnicalValue(vm.technicalAppendix.otsDetail)
    ? String(vm.technicalAppendix.otsDetail)
    : "";

  // The Digital Signature block is built once and placed on ONE page only.
  // For INTAKE reports it moves off the Identity/Camera/Fingerprint page onto
  // the final Timestamp & Anchoring page (ordered Signature → Timestamp →
  // Anchoring). Web/mobile capture keep it on the first appendix page exactly
  // as before. Values are unchanged — placement only.
  const isIntake = vm.meta.acquisition?.isIntake === true;
  const signatureBlock = shouldRenderSignature
    ? renderAppendixSection(
        "Digital Signature",
        "Signature and signing-key references used for independent verification of the recorded evidence state.",
        `
          ${renderKeyValueGrid(vm.technicalAppendix.signatureRows)}
          ${renderCallout({
            title: "Signature material handling",
            body: vm.technicalAppendix.signatureReferenceNote,
            tone: "neutral",
          })}
        `,
        { className: "technical-appendix-signature-block" }
      )
    : "";
  const signatureOnPage1 = signatureBlock && !isIntake;
  const signatureOnPage2 = signatureBlock && isIntake;

  const pages: string[] = [];

pages.push(
  renderPageSection(
signatureOnPage1
  ? "Technical Appendix — Identity, Provenance, Fingerprint & Signature"
  : "Technical Appendix — Identity, Provenance & Fingerprint"
,
      `
      <div class="technical-appendix-page technical-appendix-identity-fingerprint-signature-page">
        ${renderAppendixSection(
          "Identity & Provenance",
          "Who submitted the evidence, which identity level was recorded, and what workspace or organization context exists.",
          renderKeyValueGrid(filteredIdentityRows),
          { className: "technical-appendix-identity-block" }
        )}

        ${(() => {
          // Camera/EXIF that did NOT warrant a standalone Technical Summary
          // page (no capture-environment device context — e.g. intake) is
          // shown here as a compact appendix subsection, so there is never a
          // mostly-empty standalone page.
          const cameraInner = renderTechnicalSummaryAppendixInner(vm);
          return cameraInner
            ? renderAppendixSection(
                "Capture Device & Camera Metadata",
                "Device and camera context embedded in the file by the capturing device. Advisory enrichment for reviewers; it does not change the integrity verdict.",
                cameraInner,
                { className: "technical-appendix-camera-block" }
              )
            : "";
        })()}

        ${renderAppendixSection(
          "Cryptographic Fingerprint",
          "Primary digest and canonical fingerprint references used to identify the preserved evidence state.",
          `
            ${renderCallout({
              title: "Fingerprint interpretation",
              body: vm.technicalFingerprintNarrative,
              tone: "neutral",
            })}
            ${
              vm.contentSummary.itemCount > 1
                ? renderCallout({
                    title: "Multipart integrity explanation",
                    body: `${PROOVRA_MULTIPART_REVIEWER_EXPLANATION} ${PROOVRA_MULTIPART_RECOMPUTATION_NOTE} ${PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE}`,
                    tone: "neutral",
                  })
                : ""
            }
            ${renderKeyValueGrid(vm.technicalAppendix.fingerprintRows)}
          `,
          { className: "technical-appendix-fingerprint-block" }
        )}

${signatureOnPage1 ? signatureBlock : ""}
      </div>
    `,
    { pageBreakBefore: true, className: "technical-appendix-section" }
  )
);

  pages.push(
    renderPageSection(
      signatureOnPage2
        ? "Technical Appendix — Signature, Timestamp & Anchoring"
        : "Technical Appendix — Timestamp & Anchoring",
      `
        <div class="technical-appendix-page technical-appendix-timestamp-anchor-page">
          ${signatureOnPage2 ? signatureBlock : ""}

          ${renderAppendixSection(
            "Trusted Timestamp",
timestampDigestLabel.includes("Canonical Package Digest")
  ? "RFC 3161 timestamp metadata and timestamped digest reference. This digest may represent canonical package/fingerprint material rather than the original file SHA-256."
  : "RFC 3161 timestamp metadata and timestamped digest reference for the original preserved file SHA-256.",
            `
              ${renderKeyValueGrid(vm.technicalAppendix.timestampRows)}
              ${
                tsaMessageImprint
? renderMonoBlock(
    timestampDigestLabel,
    tsaMessageImprint
  )
                    : ""
              }
              ${renderCallout({
                title: "Timestamp material handling",
                body: vm.technicalAppendix.timestampReferenceNote,
                tone: "neutral",
              })}
            `,
            { className: "technical-appendix-timestamp-block" }
          )}

          ${renderAppendixSection(
            "Anchoring",
            "OpenTimestamps and Bitcoin anchoring references connected to the recorded digest state.",
            `
              ${renderKeyValueGrid(anchoringRows)}

              ${
                otsHash || anchorHash
                  ? `
                    <div class="technical-mono-grid">
                      ${
                        otsHash
                          ? renderMonoBlock("OpenTimestamps Digest", otsHash)
                          : ""
                      }
                      ${
                        anchorHash
                          ? renderMonoBlock("Anchor Hash", anchorHash)
                          : ""
                      }
                    </div>
                  `
                  : ""
              }

              ${renderCallout({
                title: "Anchoring material handling",
                body: vm.technicalAppendix.anchoringReferenceNote,
                tone: "neutral",
              })}

              ${
                otsDetail
                  ? renderCallout({
                      title: "Anchoring detail",
                      body: otsDetail,
                      tone: "warning",
                    })
                  : ""
              }
            `,
            { className: "technical-appendix-anchoring-block" }
          )}
        </div>
      `,
      { pageBreakBefore: true, className: "technical-appendix-section" }
    )
  );
  
  return pages.join("");
}
