import { ReportViewModel, KeyValueRow } from "../types.js";
import {
  renderCallout,
  renderKeyValueGrid,
  renderMonoBlock,
  renderPageSection,
} from "../ui.js";
import { escapeHtml } from "../formatters.js";

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
  const status = String(vm.technicalAppendix.otsStatusLabel ?? "").toLowerCase();

  return (
    status.includes("recorded") ||
    status.includes("anchored") ||
    status.includes("published") ||
    status.includes("verified") ||
    hasMeaningfulTechnicalValue(vm.technicalAppendix.otsHash)
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
    </div>
  `;
}

function renderVerificationAccess(vm: ReportViewModel): string {
  return `
    <div class="technical-access-panel">
      <div>
        <div class="technical-access-kicker">Technical Verification Access</div>
        <div class="technical-access-title">Independent Technical Verification Endpoint</div>
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

export function renderTechnicalAppendixSection(vm: ReportViewModel): string {
  const appendixDepth = vm.presentation.decisions.appendixDepth;
  const compact = appendixDepth === "compact";
  const anchoringRows = normalizeAnchoringRows(vm);

  const filteredIdentityRows = vm.technicalIdentityRows.filter(
    (row) => !row.label?.toLowerCase().includes("last accessed")
  );

  const tsaMessageImprint = hasMeaningfulTechnicalValue(
    vm.technicalAppendix.tsaMessageImprint
  )
    ? String(vm.technicalAppendix.tsaMessageImprint)
    : "";

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
    "Technical Appendix — Verification Access",
    `
      <div class="technical-appendix-page technical-appendix-court-page">
        <section class="court-appendix-hero">
          <div class="court-appendix-kicker">Forensic Technical Appendix</div>
          <div class="court-appendix-title">Independent Verification Materials</div>
          <div class="court-appendix-copy">
            This appendix preserves the technical references required for independent review of the recorded evidence state. It separates cryptographic identity, timestamping, anchoring, custody linkage, and reviewer access material from legal interpretation.
          </div>
        </section>

        ${renderVerificationAccess(vm)}
        ${renderTechnicalStatusCards(vm)}

        ${renderAppendixSection(
          "Court Review Index",
          "Structured control points for legal, forensic, or technical review.",
          renderKeyValueGrid(vm.meta.courtAppendixRows ?? []),
          { className: "technical-appendix-court-index-block" }
        )}
      </div>
    `,
    { pageBreakBefore: true, className: "technical-appendix-section" }
  )
);

pages.push(
  renderPageSection(
    "Technical Appendix — Identity & Provenance",
    `
      <div class="technical-appendix-page technical-appendix-identity-page">
        ${renderAppendixSection(
          "Identity & Provenance",
          "Who submitted the evidence, which identity level was recorded, and what workspace or organization context exists.",
          renderKeyValueGrid(filteredIdentityRows),
          { className: "technical-appendix-identity-block" }
        )}
      </div>
    `,
    { pageBreakBefore: true, className: "technical-appendix-section" }
  )
);

pages.push(
  renderPageSection(
    "Technical Appendix — Evidence Fingerprint",
    `
      <div class="technical-appendix-page technical-appendix-fingerprint-page">
        ${renderAppendixSection(
          "Cryptographic Fingerprint",
          "Primary digest and canonical fingerprint references used to identify the preserved evidence state.",
          `
            ${renderCallout({
              title: "Fingerprint interpretation",
              body: vm.technicalFingerprintNarrative,
              tone: "neutral",
            })}
            ${renderKeyValueGrid(vm.technicalAppendix.fingerprintRows)}
          `,
          { className: "technical-appendix-fingerprint-block" }
        )}
      </div>
    `,
    { pageBreakBefore: true, className: "technical-appendix-section" }
  )
);

  if (!compact) {
    pages.push(
      renderPageSection(
        "Technical Appendix — Digital Signature",
        `
          <div class="technical-appendix-page">
            ${renderAppendixSection(
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
            )}
          </div>
        `,
        { pageBreakBefore: true, className: "technical-appendix-section" }
      )
    );
  }

  pages.push(
    renderPageSection(
      "Technical Appendix — Timestamp & Anchoring",
      `
        <div class="technical-appendix-page technical-appendix-timestamp-anchor-page">
          ${renderAppendixSection(
            "Trusted Timestamp",
            "RFC 3161 timestamp metadata and message-imprint reference recorded for the evidence digest.",
            `
              ${renderKeyValueGrid(vm.technicalAppendix.timestampRows)}
              ${
                tsaMessageImprint
                  ? renderMonoBlock("TSA Message Imprint", tsaMessageImprint)
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