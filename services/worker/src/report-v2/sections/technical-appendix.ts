import { ReportViewModel } from "../types.js";
import {
  renderKeyValueGrid,
  renderMonoBlock,
  renderPageSection,
  renderCallout,
} from "../ui.js";

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

      ${renderMonoBlock("File SHA-256", vm.technicalAppendix.fileSha256)}
      ${renderMonoBlock(
        "Fingerprint Hash",
        vm.technicalAppendix.fingerprintHash
      )}
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
    `
  );
}