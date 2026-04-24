import { ReportViewModel } from "../types.js";
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

function renderTechnicalStatusCards(vm: ReportViewModel): string {
  const timestampTone = vm.technicalAppendix.timestampStatusTone ?? "neutral";
  const otsTone = vm.technicalAppendix.otsStatusTone ?? "neutral";

  return `
    <div class="technical-verification-strip">
      <article class="technical-verification-card tone-${timestampTone}">
        <div class="technical-verification-kicker">RFC 3161</div>
        <div class="technical-verification-title">Trusted Timestamp</div>
        <div class="technical-verification-value">${escapeHtml(vm.technicalAppendix.timestampStatusLabel)}</div>
        <div class="technical-verification-note">
          External timestamp state recorded for the preserved evidence digest.
        </div>
      </article>

      <article class="technical-verification-card tone-${otsTone}">
        <div class="technical-verification-kicker">Anchoring</div>
        <div class="technical-verification-title">Public Anchoring</div>
        <div class="technical-verification-value">${escapeHtml(vm.technicalAppendix.otsStatusLabel)}</div>
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
        <div class="technical-access-title">Independent verification endpoint</div>
        <div class="technical-access-copy">
          Reviewers can use this endpoint to inspect the verification materials, public status, and technical references connected to this evidence record.
        </div>
      </div>
      <div class="technical-access-url">${escapeHtml(vm.technicalUrl)}</div>
    </div>
  `;
}

export function renderTechnicalAppendixSection(vm: ReportViewModel): string {
  const appendixDepth = vm.presentation.decisions.appendixDepth;
  const compact = appendixDepth === "compact";

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
            <div class="technical-mono-grid">
              ${renderMonoBlock("File SHA-256", vm.technicalAppendix.fileSha256)}
              ${renderMonoBlock("Fingerprint Hash", vm.technicalAppendix.fingerprintHash)}
            </div>
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
              vm.technicalAppendix.tsaMessageImprint
                ? renderMonoBlock("TSA Message Imprint", vm.technicalAppendix.tsaMessageImprint)
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
            ${renderKeyValueGrid(vm.technicalAppendix.anchoringRows)}
            <div class="technical-mono-grid">
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
            </div>
            ${renderCallout({
              title: "Anchoring material handling",
              body: vm.technicalAppendix.anchoringReferenceNote,
              tone: "neutral",
            })}
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

      </div>
    `,
    { pageBreakBefore: true, className: "technical-appendix-section" }
  );
}