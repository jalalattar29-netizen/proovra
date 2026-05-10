import { ReportViewModel, KeyValueRow } from "../types.js";
import {
  PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE,
  PROOVRA_MULTIPART_RECOMPUTATION_NOTE,
  PROOVRA_MULTIPART_REVIEWER_EXPLANATION,
} from "@proovra/shared-evidence-presentation";
import {
  renderCallout,
  renderKeyValueGrid,
  renderMonoBlock,
  renderPageSection,
} from "../ui.js";
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
function renderPackageComponentFlag(
  flag: boolean | null | undefined,
  presentLabel: string
): string {
  if (flag === true) return presentLabel;
  if (flag === false) return "Not available";
  return "Presence not independently confirmed (legacy package)";
}

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
        "Anchor Public URL",
        "Anchor Receipt ID",
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
        return { ...row, value: "Public anchoring recorded" };
      }
      return row;
    });
}

function renderTechnicalStatusCards(vm: ReportViewModel): string {
  const timestampTone = vm.technicalAppendix.timestampStatusTone ?? "neutral";
  const otsTone = vm.technicalAppendix.otsStatusTone ?? "neutral";

  return `
    <div class="technical-verification-strip">
      <article class="technical-verification-card tone-${timestampTone}">
        <div class="technical-verification-kicker">RFC 3161</div>
        <div class="technical-verification-title">Trusted Timestamp</div>
        <div class="technical-verification-value">${escapeHtml(
          vm.technicalAppendix.timestampStatusLabel
        )}</div>
        <div class="technical-verification-note">
          External timestamp state recorded for the preserved evidence digest.
        </div>
      </article>

      <article class="technical-verification-card tone-${otsTone}">
        <div class="technical-verification-kicker">Anchoring</div>
        <div class="technical-verification-title">Public Anchoring</div>
        <div class="technical-verification-value">${escapeHtml(
          vm.technicalAppendix.otsStatusLabel
          
        )}</div>
        <div class="technical-verification-note">
          OpenTimestamps or external publication state for the recorded digest.
        </div>
      </article>
      <article class="technical-verification-card tone-${vm.trustDecision.tone}">
        <div class="technical-verification-kicker">Trust Decision</div>
        <div class="technical-verification-title">Verification Classification</div>
        <div class="technical-verification-value">${escapeHtml(
          vm.trustDecision.verdictLabel
        )}</div>
        <div class="technical-verification-note">
          ${escapeHtml(vm.trustDecision.reviewerAction)}
        </div>
      </article>
    </div>
  `;
}

function renderVerificationAccess(vm: ReportViewModel): string {
  return `
    <div class="technical-access-panel">
      <div>
<div class="technical-access-kicker">Independent Verification Endpoint</div>
<div class="technical-access-title">Technical Verification Endpoint</div>
        <div class="technical-access-copy">
          Reviewers can use this endpoint to inspect the verification materials, public status, and technical references connected to this evidence record.
        </div>
      </div>

<div class="technical-access-url-block">
  <div class="technical-access-url-label">Verification Endpoint</div>
  <div class="technical-access-url-value">
    ${escapeHtml(vm.technicalUrl)}
  </div>
</div>
    </div>
  `;
}

function readPackageIntegrityRows(vm: ReportViewModel): KeyValueRow[] {
  const integrity = vm.verificationPackageIntegrity;

  return [
    // Phase D Blocker 3 — render per-component flags truthfully:
    //   true  -> "Present" / "Included"
    //   false -> "Not available"
    //   null  -> "Presence not independently confirmed" (legacy package
    //            with no per-component metadata persisted)
    {
      label: "Verification Package",
      value:
        integrity.available && integrity.version != null
          ? `Available • v${integrity.version}`
          : "Not generated",
    },
    {
      label: "Package Manifest",
      value: renderPackageComponentFlag(integrity.manifestPresent, "Present"),
    },
    {
      label: "Manifest Signature",
      value: renderPackageComponentFlag(
        integrity.signedManifestPresent,
        "Ed25519 signature present"
      ),
    },
    {
      label: "Manifest Digest",
      value: renderPackageComponentFlag(
        integrity.manifestDigestPresent,
        "Present"
      ),
    },
    {
      label: "Checksum Index",
      value: renderPackageComponentFlag(
        integrity.checksumIndexPresent,
        "Present"
      ),
    },
    {
      label: "Offline Verifier",
      value: renderPackageComponentFlag(
        integrity.offlineVerifierIncluded,
        "Included"
      ),
    },
    {
      label: "Audit Export",
      value: renderPackageComponentFlag(
        integrity.auditExportIncluded,
        "Custody and access export included"
      ),
    },
    {
      label: "Component presence source",
      value:
        integrity.componentPresenceSource === "verification_package_metadata"
          ? "Persisted package artifact-presence record"
          : integrity.componentPresenceSource === "legacy_inferred_unknown"
            ? "Legacy package — per-component presence not independently confirmed; inspect the verification package archive directly"
            : "Not generated",
    },
    {
      label: "Generated At",
      value: integrity.generatedAtUtc ?? "Not recorded",
    },
  ];
}

function renderVerificationPackageIntegrity(vm: ReportViewModel): string {
  return renderAppendixSection(
    "Verification Package Integrity",
"Compact reference to the machine-verifiable verification package artifacts, including the Ed25519 package-manifest signature when generated.",
    `
      ${renderKeyValueGrid(readPackageIntegrityRows(vm))}
      ${renderCallout({
        title: "Package integrity layer",
body:
  "The verification package is the offline forensic bundle. It may include the preserved originals, package manifest, Ed25519 manifest signature, checksum index, offline verifier, custody export, and access audit export. Package access activity is a snapshot taken at generation time; current live access activity should be reviewed on the verification page.",
          tone: "neutral",
      })}
    `,
    { className: "technical-appendix-package-integrity-block" }
  );
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
  // Issue #10: be precise about what the timestamped digest covers. For a
  // multipart record the digest is the lead-item SHA-256 (or, where used,
  // the synthetic composite — see the per-part checksum index in the
  // verification package).
  const timestampDigestLabel =
    vm.technicalAppendix.timestampDigestLabel ??
    "Timestamped digest (lead item SHA-256 for multipart; original file SHA-256 for single)";

  const otsHash = hasMeaningfulTechnicalValue(vm.technicalAppendix.otsHash)
    ? String(vm.technicalAppendix.otsHash)
    : "";

  const anchorHash = hasMeaningfulTechnicalValue(vm.technicalAppendix.anchorHash)
    ? String(vm.technicalAppendix.anchorHash)
    : "";

  const otsDetail = hasMeaningfulTechnicalValue(vm.technicalAppendix.otsDetail)
    ? String(vm.technicalAppendix.otsDetail)
    : "";

  const pages: string[] = [];

pages.push(
  renderPageSection(
shouldRenderSignature
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

${
  shouldRenderSignature
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
    : ""
}
      </div>
    `,
    { pageBreakBefore: true, className: "technical-appendix-section" }
  )
);

  pages.push(
    renderPageSection(
      "Technical Appendix — Timestamp & Anchoring",
      `
        <div class="technical-appendix-page technical-appendix-timestamp-anchor-page">
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
            "Anchoring & Publication",
            "OpenTimestamps and external anchoring references connected to the recorded digest state.",
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
