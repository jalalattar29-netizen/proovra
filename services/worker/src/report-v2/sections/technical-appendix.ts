import { ReportViewModel } from "../types.js";
import {
  renderKeyValueGrid,
  renderMonoBlock,
  renderPageSection,
  renderCallout,
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
        <div class="technical-status-kicker">OpenTimestamps</div>
        <div class="technical-status-title">Anchoring Status</div>
        <div class="technical-status-value">${escapeHtml(
          vm.technicalAppendix.otsStatusLabel
        )}</div>
        <div class="technical-status-note">
          Public anchoring state for the recorded evidence digest and related proof materials.
        </div>
      </article>
    </div>
  `;
}

export function renderTechnicalAppendixSection(vm: ReportViewModel): string {
  return renderPageSection(
    vm.mode === "external"
      ? "Technical Appendix — Reviewer-Facing Technical Summary"
      : "Technical Appendix — Identity, Fingerprint, Signature, and Anchoring",
    `
      ${renderKeyValueGrid(vm.technicalIdentityRows)}

      ${renderCallout({
        title: "Fingerprint structure summary",
        body: vm.technicalFingerprintNarrative,
        tone: "neutral",
      })}

      ${
        vm.mode === "external"
          ? renderCallout({
              title: "External report note",
              body:
                "This external report includes reviewer-facing technical summaries only. Deep technical materials should be reviewed through the technical verification workflow or verification package when required.",
              tone: "neutral",
            })
          : ""
      }

      ${renderTechnicalStatusCards(vm)}

      ${renderMonoBlock("File SHA-256", vm.technicalAppendix.fileSha256)}

      ${renderMonoBlock(
        "Fingerprint Hash",
        vm.technicalAppendix.fingerprintHash
      )}

      ${
        vm.technicalAppendix.fingerprintCanonicalJsonExcerpt
          ? renderMonoBlock(
              "Fingerprint Canonical JSON (excerpt)",
              vm.technicalAppendix.fingerprintCanonicalJsonExcerpt
            )
          : ""
      }

      ${renderMonoBlock(
        "Signing Key Reference",
        vm.technicalAppendix.signingKeyReference
      )}

      ${
        vm.technicalAppendix.signatureExcerpt
          ? renderMonoBlock(
              "Signature (Base64) (excerpt)",
              vm.technicalAppendix.signatureExcerpt
            )
          : renderCallout({
              title: "Technical signature materials",
              body:
                "Detailed signature materials and public-key verification artifacts remain available through the technical verification workflow and verification package, where enabled. They are not reproduced in full in this reviewer-facing report.",
              tone: "neutral",
            })
      }

      ${
        vm.technicalAppendix.publicKeyExcerpt
          ? renderMonoBlock(
              "Public Key (PEM) (excerpt)",
              vm.technicalAppendix.publicKeyExcerpt
            )
          : ""
      }

      ${renderKeyValueGrid(vm.technicalAppendix.timestampRows)}

      ${
        vm.technicalAppendix.tsaMessageImprint
          ? renderMonoBlock(
              "Timestamp Message Imprint",
              vm.technicalAppendix.tsaMessageImprint
            )
          : ""
      }

      ${
        vm.technicalAppendix.tsaTokenExcerpt
          ? renderMonoBlock(
              "Timestamp Token (Base64) (excerpt)",
              vm.technicalAppendix.tsaTokenExcerpt
            )
          : ""
      }

      ${renderKeyValueGrid(vm.technicalAppendix.otsRows)}

      ${
        vm.technicalAppendix.otsHash
          ? renderMonoBlock("OTS Hash", vm.technicalAppendix.otsHash)
          : ""
      }

      ${
        vm.technicalAppendix.otsProofExcerpt
          ? renderMonoBlock(
              "OTS Proof (Base64) (excerpt)",
              vm.technicalAppendix.otsProofExcerpt
            )
          : ""
      }

      ${
        vm.technicalAppendix.otsDetail
          ? renderMonoBlock(
              "OTS Failure / Detail",
              vm.technicalAppendix.otsDetail
            )
          : ""
      }

      ${
        vm.technicalAppendix.anchorRows.length
          ? renderKeyValueGrid(vm.technicalAppendix.anchorRows)
          : ""
      }

      ${
        vm.technicalAppendix.anchorHash
          ? renderMonoBlock("Anchor Hash", vm.technicalAppendix.anchorHash)
          : ""
      }
    `,
    { pageBreakBefore: true }
  );
}