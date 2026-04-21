import { ReportViewModel } from "../types.js";
import {
  renderCallout,
  renderCustodyHashTable,
  renderKeyValueGrid,
  renderMonoBlock,
  renderPageSection,
} from "../ui.js";
import { escapeHtml } from "../formatters.js";

function renderTechnicalStatusCards(vm: ReportViewModel): string {
  const timestampTone = vm.technicalAppendix.timestampStatusTone ?? "neutral";
  const otsTone = vm.technicalAppendix.otsStatusTone ?? "neutral";

  return `
    <div class="technical-status-grid">
      <article class="technical-status-card tone-${timestampTone}">
        <div class="technical-status-kicker">RFC 3161</div>
        <div class="technical-status-title">Timestamp Status</div>
        <div class="technical-status-value">${escapeHtml(
          vm.technicalAppendix.timestampStatusLabel
        )}</div>
        <div class="technical-status-note">
          Trusted timestamp issuance and verification state as recorded in the evidence record.
        </div>
      </article>

      <article class="technical-status-card tone-${otsTone}">
        <div class="technical-status-kicker">Anchoring</div>
        <div class="technical-status-title">Publication Status</div>
        <div class="technical-status-value">${escapeHtml(
          vm.technicalAppendix.otsStatusLabel
        )}</div>
        <div class="technical-status-note">
          OpenTimestamps and external anchoring state for the recorded evidence digest.
        </div>
      </article>
    </div>
  `;
}

function renderVerificationLinkPanel(vm: ReportViewModel): string {
  return `
    <div class="verification-link-panel">
      <div class="verification-link-panel-label">Technical Verification Access</div>
      <div class="verification-link-panel-value">${escapeHtml(vm.technicalUrl)}</div>
    </div>
  `;
}

function renderAppendixSection(title: string, body: string): string {
  return `
    <section class="appendix-section">
      <h3 class="appendix-section-title">${escapeHtml(title)}</h3>
      ${body}
    </section>
  `;
}

export function renderTechnicalAppendixSection(vm: ReportViewModel): string {
  const appendixDepth = vm.presentation.decisions.appendixDepth;
  const compact = appendixDepth === "compact";
  const full = appendixDepth === "full";

  return renderPageSection(
    "Technical Appendix",
    `
      ${renderCallout({
        title: "Appendix scope",
        body:
          "This appendix preserves the structured technical references needed for audit and verification. Heavy payloads such as canonical JSON, signature blobs, timestamp tokens, and anchoring proof blobs are intentionally omitted from the PDF body and remain available through the verification workflow.",
        tone: "neutral",
      })}

      ${renderVerificationLinkPanel(vm)}

      ${renderTechnicalStatusCards(vm)}

      ${renderAppendixSection(
        "Technical Scope",
        renderCallout({
          title: "Appendix role",
          body:
            "This appendix preserves exact technical references, full digest values, and verification-access information in a structured form. It does not repeat the report's legal interpretation or presentation guidance.",
          tone: "neutral",
        })
      )}

      ${renderAppendixSection(
        "Identity",
        renderKeyValueGrid(vm.technicalIdentityRows)
      )}

      ${renderAppendixSection(
        "Fingerprint",
        `
          ${renderCallout({
            title: "Fingerprint summary",
            body: vm.technicalFingerprintNarrative,
            tone: "neutral",
          })}
          ${renderKeyValueGrid(vm.technicalAppendix.fingerprintRows)}
          ${renderMonoBlock("File SHA-256", vm.technicalAppendix.fileSha256)}
          ${renderMonoBlock("Fingerprint Hash", vm.technicalAppendix.fingerprintHash)}
        `
      )}

      ${
        compact
          ? ""
          : renderAppendixSection(
              "Signature",
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
        "Timestamp",
        `
          ${renderKeyValueGrid(vm.technicalAppendix.timestampRows)}
          ${
            vm.technicalAppendix.tsaMessageImprint
              ? renderMonoBlock(
                  "TSA Message Imprint",
                  vm.technicalAppendix.tsaMessageImprint
                )
              : ""
          }
        `
      )}

      ${renderAppendixSection(
        "Anchoring",
        `
          ${renderKeyValueGrid(vm.technicalAppendix.anchoringRows)}
          ${
            vm.technicalAppendix.otsHash
              ? renderMonoBlock("OTS Hash", vm.technicalAppendix.otsHash)
              : ""
          }
          ${
            vm.technicalAppendix.anchorHash
              ? renderMonoBlock("Anchor Hash", vm.technicalAppendix.anchorHash)
              : ""
          }
          ${
            vm.technicalAppendix.otsDetail
              ? renderCallout({
                  title: "Anchoring detail",
                  body: vm.technicalAppendix.otsDetail,
                  tone: "warning",
                })
              : ""
          }
        `
      )}

      ${
        full && vm.custodyHashRows.length > 0
          ? renderAppendixSection(
              "Custody Hash Chain Detail",
              renderCustodyHashTable(vm.custodyHashRows)
            )
          : ""
      }
    `,
    { pageBreakBefore: true }
  );
}
