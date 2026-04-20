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

function renderVerificationLinkPanel(vm: ReportViewModel): string {
  return `
    <div class="verification-link-panel">
      <div class="verification-link-panel-label">Technical Verification Access</div>
      <div class="verification-link-panel-value">${escapeHtml(vm.technicalUrl)}</div>
    </div>
  `;
}

function renderTechnicalMaterialsBlock(vm: ReportViewModel): string {
  const blocks: string[] = [
    renderMonoBlock("File SHA-256", vm.technicalAppendix.fileSha256),
    renderMonoBlock("Fingerprint Hash", vm.technicalAppendix.fingerprintHash),
    renderMonoBlock(
      "Signing Key Reference",
      vm.technicalAppendix.signingKeyReference
    ),
  ];

  if (vm.technicalAppendix.fingerprintCanonicalJsonExcerpt) {
    blocks.push(
      renderMonoBlock(
        "Fingerprint Canonical JSON (excerpt)",
        vm.technicalAppendix.fingerprintCanonicalJsonExcerpt
      )
    );
  }

  if (vm.technicalAppendix.signatureExcerpt) {
    blocks.push(
      renderMonoBlock(
        "Signature (Base64) (excerpt)",
        vm.technicalAppendix.signatureExcerpt
      )
    );
  } else {
    blocks.push(
      renderCallout({
        title: "Technical signature materials",
        body:
          "Detailed signature materials and public-key verification artifacts remain available through the technical verification workflow and verification package, where enabled. They are not reproduced in full in this reviewer-facing report.",
        tone: "neutral",
      })
    );
  }

  if (vm.technicalAppendix.publicKeyExcerpt) {
    blocks.push(
      renderMonoBlock(
        "Public Key (PEM) (excerpt)",
        vm.technicalAppendix.publicKeyExcerpt
      )
    );
  }

  return blocks.join("");
}

function renderTimestampMaterialsBlock(vm: ReportViewModel): string {
  const parts: string[] = [
    renderCallout({
      title: "RFC 3161 timestamp materials",
      body:
        "This block preserves the recorded trusted-timestamp metadata and associated technical values exactly as represented in the report model.",
      tone: "neutral",
    }),
    renderKeyValueGrid(vm.technicalAppendix.timestampRows),
  ];

  if (vm.technicalAppendix.tsaMessageImprint) {
    parts.push(
      renderMonoBlock(
        "Timestamp Message Imprint",
        vm.technicalAppendix.tsaMessageImprint
      )
    );
  }

  if (vm.technicalAppendix.tsaTokenExcerpt) {
    parts.push(
      renderMonoBlock(
        "Timestamp Token (Base64) (excerpt)",
        vm.technicalAppendix.tsaTokenExcerpt
      )
    );
  }

  return parts.join("");
}

function renderOtsMaterialsBlock(vm: ReportViewModel): string {
  const parts: string[] = [
    renderCallout({
      title: "OpenTimestamps materials",
      body:
        "This block preserves the recorded public-anchoring metadata and any associated proof values carried in the report model.",
      tone: "neutral",
    }),
    renderKeyValueGrid(vm.technicalAppendix.otsRows),
  ];

  if (vm.technicalAppendix.otsHash) {
    parts.push(renderMonoBlock("OTS Hash", vm.technicalAppendix.otsHash));
  }

  if (vm.technicalAppendix.otsProofExcerpt) {
    parts.push(
      renderMonoBlock(
        "OTS Proof (Base64) (excerpt)",
        vm.technicalAppendix.otsProofExcerpt
      )
    );
  }

  if (vm.technicalAppendix.otsDetail) {
    parts.push(
      renderMonoBlock(
        "OTS Failure / Detail",
        vm.technicalAppendix.otsDetail
      )
    );
  }

  return parts.join("");
}

function renderAnchorMaterialsBlock(vm: ReportViewModel): string {
  if (!vm.technicalAppendix.anchorRows.length && !vm.technicalAppendix.anchorHash) {
    return "";
  }

  return `
    ${renderCallout({
      title: "External anchoring materials",
      body:
        "Where external anchoring was configured or published, this block preserves the recorded anchoring references and related identifier values.",
      tone: "neutral",
    })}
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
  `;
}

export function renderTechnicalAppendixSection(vm: ReportViewModel): string {
  return renderPageSection(
    vm.mode === "external"
      ? "Technical Appendix — Reviewer-Facing Technical Summary"
      : "Technical Appendix — Identity, Fingerprint, Signature, and Anchoring",
    `
      ${renderCallout({
        title: "Technical appendix scope",
        body:
          vm.mode === "external"
            ? "This appendix presents reviewer-facing technical materials in a readable form while preserving full critical values such as recorded hashes and technical references."
            : "This appendix presents recorded technical materials in a denser review format, including full recorded hash values and preserved integrity references where available.",
        tone: "neutral",
      })}

      ${renderVerificationLinkPanel(vm)}

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
                "This external report includes reviewer-facing technical summaries only. Deeper technical payloads should be reviewed through the technical verification workflow or verification package when required.",
              tone: "neutral",
            })
          : ""
      }

      ${renderTechnicalStatusCards(vm)}

      ${renderTechnicalMaterialsBlock(vm)}

      ${renderTimestampMaterialsBlock(vm)}

      ${renderOtsMaterialsBlock(vm)}

      ${renderAnchorMaterialsBlock(vm)}
    `,
    { pageBreakBefore: true }
  );
}