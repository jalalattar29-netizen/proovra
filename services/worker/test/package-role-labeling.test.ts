/**
 * Verification package — intake role-safe labeling for case-metadata.json and
 * original-linkage.json.
 *
 * For INTAKE the package metadata's submittedByEmail is the identity-snapshot
 * email = the LINK CREATOR / workspace owner (NOT the remote contributor), and
 * the persisted captureMethod is the STRUCTURE enum MULTIPART_PACKAGE. Both
 * must be relabeled role-safely: submittedByEmail → null + linkCreatorEmail +
 * submittedByRole; captureMethod → SECURE_INTAKE_LINK (structure preserved in
 * evidenceStructure). Web capture is unchanged.
 */
import { describe, it, expect } from "vitest";
import {
  buildCaseMetadata,
  buildOriginalLinkage,
} from "../src/verification-package";

const OWNER = "jalal.attar@proovra.com";

function metadata(isIntake: boolean) {
  return {
    title: "Roadside incident photo",
    rawEvidenceType: "PHOTO",
    reviewerEvidenceType: "Photo Evidence",
    evidenceStructure: "Multipart evidence package",
    itemCount: 2,
    imageCount: 2,
    mimeType: "image/jpeg",
    evidenceStatus: "SIGNED",
    verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
    captureMethod: "MULTIPART_PACKAGE",
    identityLevelSnapshot: "VERIFIED_EMAIL",
    submittedByEmail: isIntake ? OWNER : "owner@acme-legal.example",
    submittedByAuthProvider: "google",
    isIntake,
  } as never;
}

describe("verification package — intake role-safe submitter + capture method", () => {
  it("case-metadata.json (intake): relabels submitter + capture method, keeps structure", () => {
    const cm = buildCaseMetadata(metadata(true), "ev-1") as {
      evidence: { captureMethod: string; evidenceStructure: string };
      submitter: {
        submittedByEmail: string | null;
        submittedByAuthProvider: string | null;
        submittedByRole?: string;
        linkCreatorEmail?: string;
      };
    };
    expect(cm.submitter.submittedByEmail).toBeNull();
    expect(cm.submitter.submittedByAuthProvider).toBeNull();
    expect(cm.submitter.submittedByRole).toBe("Remote Contributor");
    expect(cm.submitter.linkCreatorEmail).toBe(OWNER);
    expect(cm.evidence.captureMethod).toBe("SECURE_INTAKE_LINK");
    expect(cm.evidence.captureMethod).not.toBe("MULTIPART_PACKAGE");
    // Structure info is preserved (just not as the capture method).
    expect(cm.evidence.evidenceStructure).toBe("Multipart evidence package");
  });

  it("original-linkage.json (intake): relabels submitter + capture method, keeps structure", () => {
    const ol = buildOriginalLinkage([] as never, metadata(true)) as {
      captureMethod: string;
      evidenceStructure: string;
      submittedByEmail: string | null;
      submittedByRole?: string;
      linkCreatorEmail?: string;
    };
    expect(ol.submittedByEmail).toBeNull();
    expect(ol.submittedByRole).toBe("Remote Contributor");
    expect(ol.linkCreatorEmail).toBe(OWNER);
    expect(ol.captureMethod).toBe("SECURE_INTAKE_LINK");
    expect(ol.evidenceStructure).toBe("Multipart evidence package");
  });

  it("Web capture is UNCHANGED (submittedByEmail kept, captureMethod raw, no intake role fields)", () => {
    const cm = buildCaseMetadata(metadata(false), "ev-1") as {
      evidence: { captureMethod: string };
      submitter: { submittedByEmail: string | null; submittedByRole?: string; linkCreatorEmail?: string };
    };
    expect(cm.submitter.submittedByEmail).toBe("owner@acme-legal.example");
    expect(cm.submitter.submittedByRole).toBeUndefined();
    expect(cm.submitter.linkCreatorEmail).toBeUndefined();
    expect(cm.evidence.captureMethod).toBe("MULTIPART_PACKAGE");

    const ol = buildOriginalLinkage([] as never, metadata(false)) as {
      captureMethod: string;
      submittedByEmail: string | null;
      submittedByRole?: string;
    };
    expect(ol.submittedByEmail).toBe("owner@acme-legal.example");
    expect(ol.submittedByRole).toBeUndefined();
    expect(ol.captureMethod).toBe("MULTIPART_PACKAGE");
  });

  it("no recipient phone/email or provider IDs are introduced", () => {
    const s = JSON.stringify([
      buildCaseMetadata(metadata(true), "ev-1"),
      buildOriginalLinkage([] as never, metadata(true)),
    ]);
    expect(s).not.toMatch(/\+?\d{7,}/); // no full phone
    expect(s).not.toMatch(/twilio/i);
    expect(s).not.toMatch(/\bSM[0-9a-f]{20,}/i); // Twilio SID
    expect(s).not.toMatch(/\bwamid/i); // WhatsApp message ID
  });
});
