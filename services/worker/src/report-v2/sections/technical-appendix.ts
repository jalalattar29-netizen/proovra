import { ReportViewModel, KeyValueRow } from "../types.js";
import {
  renderCallout,
  renderKeyValueGrid,
  renderMonoBlock,
  renderPageSection,
} from "../ui.js";
import { escapeHtml } from "../formatters.js";

function renderAppendixSection(title: string, subtitle: string, body: string): string {
  return `
    <section class="technical-appendix-block">
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
        return {
          ...row,
          value: "Public anchoring recorded",
        };
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

      <div
        class="technical-access-url"
        style="
          font-size: 9.6px;
          line-height: 1.55;
          font-weight: 700;
          padding: 10px 11px;
        "
      >
        ${escapeHtml(vm.technicalUrl)}
      </div>
    </div>
  `;
}

export function renderTechnicalAppendixSection(vm: ReportViewModel): string {
  const appendixDepth = vm.presentation.decisions.appendixDepth;
  const compact = appendixDepth === "compact";
  const anchoringRows = normalizeAnchoringRows(vm);

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

  return renderPageSection(
    "Technical Appendix",
    `
      <div class="technical-appendix-page">
        ${renderCallout({
          title: "Technical appendix scope",
          body:
            "This appendix preserves exact technical references for audit and independent verification. Human interpretation, legal posture, and custody chronology are kept in their own sections so this appendix remains a structured technical reference.",
          tone: "neutral",
        })}

        ${renderVerificationAccess(vm)}

        ${renderTechnicalStatusCards(vm)}

        ${renderAppendixSection(
          "Identity & Provenance",
          "Who submitted the evidence, which identity level was recorded, and what workspace or organization context exists.",
          renderKeyValueGrid(vm.technicalIdentityRows)
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
            ${renderKeyValueGrid(vm.technicalAppendix.fingerprintRows)}
          `
        )}

        ${
          compact
            ? ""
            : renderAppendixSection(
                "Digital Signature",
                "Signature and signing-key references used for independent verification of the recorded evidence state.",
                `
                  ${renderKeyValueGrid(vm.technicalAppendix.signatureRows)}
                  ${renderCallout({
                    title: "Signature material handling",
                    body: vm.technicalAppendix.signatureReferenceNote,
                    tone: "neutral",
                  })}
                `
              )
        }

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
          `
        )}

        ${renderAppendixSection(
          "Anchoring & Publication",
          "OpenTimestamps and external anchoring references connected to the recorded digest state.",
          `
            ${renderKeyValueGrid(anchoringRows)}

            <div class="technical-mono-grid">
              ${otsHash ? renderMonoBlock("OTS Hash", otsHash) : ""}
              ${anchorHash ? renderMonoBlock("Anchor Hash", anchorHash) : ""}
            </div>

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
          `
        )}
      </div>
    `,
    { pageBreakBefore: true, className: "technical-appendix-section" }
  );
}