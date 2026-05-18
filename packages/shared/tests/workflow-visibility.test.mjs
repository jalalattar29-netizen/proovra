import test from "node:test";
import assert from "node:assert/strict";

import {
  WORKFLOW_BASELINE_EXPORT_POLICY,
  WORKFLOW_BASELINE_VISIBILITY_POLICY,
  WORKFLOW_DATA_CLASSES,
  WORKFLOW_SURFACES,
  resolveVisibilityForViewer,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Baseline behavior matrix — when no policy is provided, the resolver MUST
// return the same decisions the platform currently makes implicitly. This is
// the contract documented in workflow-policy.ts and the §4 visibility matrix.
//
// Source of truth for current behavior:
//   - services/api/src/services/evidence-review/governance.service.ts:
//     reviewer comments, legal notes, annotations, AI advisory =>
//     reviewerOnly across publicVerify/report/verificationPackage
//   - services/api/src/routes/evidence.routes.ts:
//     Evidence.internalNotes and EvidencePart.privateNote returned to
//     authenticated members but never serialized into report-v2 or
//     verification-package outputs.
//   - packages/shared/src/public-identifiers.ts:
//     maskPublicEmail used on public/report rendering.
//
// Cell values: "allow:<transform>" or "deny".
// -----------------------------------------------------------------------------

const BASELINE_MATRIX = {
  // class                       AUTH                PUBLIC               REPORT               PACKAGE              EXTERNAL             REVIEWER
  session_internal_notes:       ["allow:none",       "deny",              "deny",              "deny",              "deny",              "allow:none"],
  per_part_private_note:        ["allow:none",       "deny",              "deny",              "deny",              "deny",              "allow:none"],
  per_part_private_role:        ["allow:none",       "deny",              "deny",              "deny",              "deny",              "allow:none"],
  public_description:           ["allow:none",       "allow:none",        "allow:none",        "allow:none",        "allow:none",        "allow:none"],
  metadata_technical:           ["allow:none",       "allow:none",        "allow:none",        "allow:none",        "allow:none",        "allow:none"],
  gps_exact:                    ["allow:none",       "allow:none",        "allow:none",        "allow:none",        "allow:none",        "allow:none"],
  gps_approximate:              ["allow:none",       "allow:none",        "allow:none",        "allow:none",        "allow:none",        "allow:none"],
  identity_fields:              ["allow:none",       "allow:mask_email",  "allow:mask_email",  "allow:none",        "allow:mask_email",  "allow:none"],
  consent_record:               ["allow:none",       "deny",              "deny",              "deny",              "deny",              "allow:none"],
  claim_reference:              ["allow:none",       "deny",              "allow:none",        "allow:none",        "deny",              "allow:none"],
  ai_advisory_output:           ["allow:none",       "deny",              "deny",              "deny",              "deny",              "allow:none"],
  reviewer_comment_internal:    ["allow:none",       "deny",              "deny",              "deny",              "deny",              "allow:none"],
  reviewer_comment_external:    ["allow:none",       "deny",              "deny",              "deny",              "deny",              "allow:none"],
  legal_note:                   ["allow:none",       "deny",              "deny",              "deny",              "deny",              "allow:none"],
  annotation:                   ["allow:none",       "deny",              "deny",              "deny",              "deny",              "allow:none"],
  custody_chain_forensic:       ["allow:none",       "allow:none",        "allow:none",        "allow:none",        "allow:none",        "allow:none"],
  // custody_chain_access: the events list (with detail). The public aggregate
  // count is delivered via `metadata_technical` and is not gated here. Today's
  // report-v2 PDF only embeds the count (build-view-model.ts uses
  // custody.access.length), not the events themselves — REPORT_PDF stays
  // allow:none because the audience permits, and renderer code is responsible
  // for choosing what level of detail to include.
  custody_chain_access:         ["allow:none",       "deny",              "allow:none",        "allow:none",        "deny",              "allow:none"],
  anchor_proof:                 ["allow:none",       "allow:none",        "allow:none",        "allow:none",        "allow:none",        "allow:none"],
};

const SURFACES_ORDER = [
  "AUTHENTICATED_APP",
  "PUBLIC_VERIFY",
  "REPORT_PDF",
  "VERIFICATION_PACKAGE",
  "EXTERNAL_SUBMITTER_VIEW",
  "INTERNAL_REVIEWER",
];

test("baseline matrix covers every data class", () => {
  for (const dataClass of WORKFLOW_DATA_CLASSES) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(BASELINE_MATRIX, dataClass),
      `missing baseline matrix entry for data class: ${dataClass}`,
    );
  }
});

test("baseline matrix covers every surface", () => {
  for (const row of Object.values(BASELINE_MATRIX)) {
    assert.equal(row.length, SURFACES_ORDER.length);
  }
  assert.deepEqual([...WORKFLOW_SURFACES].sort(), [...SURFACES_ORDER].sort());
});

test("baseline (no policy supplied) matches today's implicit behavior cell-by-cell", () => {
  for (const dataClass of Object.keys(BASELINE_MATRIX)) {
    const row = BASELINE_MATRIX[dataClass];
    for (let i = 0; i < SURFACES_ORDER.length; i++) {
      const surface = SURFACES_ORDER[i];
      const expected = row[i];
      const decision = resolveVisibilityForViewer({ dataClass, surface });
      const actual = decision.allowed
        ? `allow:${decision.transform}`
        : "deny";
      assert.equal(
        actual,
        expected,
        `baseline ${dataClass} on ${surface}: expected ${expected}, got ${actual} (reason: ${decision.reason})`,
      );
    }
  }
});

test("baseline-supplied policy produces the same decisions as no policy", () => {
  for (const dataClass of WORKFLOW_DATA_CLASSES) {
    for (const surface of WORKFLOW_SURFACES) {
      const a = resolveVisibilityForViewer({ dataClass, surface });
      const b = resolveVisibilityForViewer({
        dataClass,
        surface,
        visibilityPolicy: WORKFLOW_BASELINE_VISIBILITY_POLICY,
        exportPolicy: WORKFLOW_BASELINE_EXPORT_POLICY,
      });
      assert.equal(
        a.allowed,
        b.allowed,
        `mismatch allowed for ${dataClass}/${surface}`,
      );
      assert.equal(
        a.transform,
        b.transform,
        `mismatch transform for ${dataClass}/${surface}`,
      );
    }
  }
});

test("baseline reports source as baseline_default for non-hardcoded classes", () => {
  const decision = resolveVisibilityForViewer({
    dataClass: "public_description",
    surface: "AUTHENTICATED_APP",
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.source, "baseline_default");
});

test("baseline reports source as hardcoded_public_proof for integrity proofs", () => {
  const forensic = resolveVisibilityForViewer({
    dataClass: "custody_chain_forensic",
    surface: "PUBLIC_VERIFY",
  });
  assert.equal(forensic.source, "hardcoded_public_proof");
  const anchor = resolveVisibilityForViewer({
    dataClass: "anchor_proof",
    surface: "PUBLIC_VERIFY",
  });
  assert.equal(anchor.source, "hardcoded_public_proof");
});

// -----------------------------------------------------------------------------
// Export policy overrides
// -----------------------------------------------------------------------------

test("disabling public verify export blocks every data class on PUBLIC_VERIFY", () => {
  for (const dataClass of WORKFLOW_DATA_CLASSES) {
    const decision = resolveVisibilityForViewer({
      dataClass,
      surface: "PUBLIC_VERIFY",
      exportPolicy: { ...WORKFLOW_BASELINE_EXPORT_POLICY, allowPublicVerify: false },
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.source, "export_disabled");
  }
});

test("disabling report export blocks every data class on REPORT_PDF", () => {
  for (const dataClass of WORKFLOW_DATA_CLASSES) {
    const decision = resolveVisibilityForViewer({
      dataClass,
      surface: "REPORT_PDF",
      exportPolicy: { ...WORKFLOW_BASELINE_EXPORT_POLICY, allowReportPdf: false },
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.source, "export_disabled");
  }
});

test("disabling verification package blocks every data class on VERIFICATION_PACKAGE", () => {
  for (const dataClass of WORKFLOW_DATA_CLASSES) {
    const decision = resolveVisibilityForViewer({
      dataClass,
      surface: "VERIFICATION_PACKAGE",
      exportPolicy: {
        ...WORKFLOW_BASELINE_EXPORT_POLICY,
        allowVerificationPackage: false,
      },
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.source, "export_disabled");
  }
});

// -----------------------------------------------------------------------------
// Visibility policy overrides — leak-prevention focus
// -----------------------------------------------------------------------------

test("session internal notes never become public even when policy is overridden to authenticated_workspace", () => {
  const decision = resolveVisibilityForViewer({
    dataClass: "session_internal_notes",
    surface: "PUBLIC_VERIFY",
    visibilityPolicy: {
      ...WORKFLOW_BASELINE_VISIBILITY_POLICY,
      sessionInternalNotes: { audience: "authenticated_workspace" },
    },
  });
  assert.equal(decision.allowed, false);
});

test("gps precision approximate hides exact and downgrades approximate", () => {
  const policy = {
    ...WORKFLOW_BASELINE_VISIBILITY_POLICY,
    gps: { audience: "public", precision: "approximate" },
  };
  const exact = resolveVisibilityForViewer({
    dataClass: "gps_exact",
    surface: "PUBLIC_VERIFY",
    visibilityPolicy: policy,
  });
  assert.equal(exact.allowed, false);
  const approx = resolveVisibilityForViewer({
    dataClass: "gps_approximate",
    surface: "PUBLIC_VERIFY",
    visibilityPolicy: policy,
  });
  assert.equal(approx.allowed, true);
  assert.equal(approx.transform, "approx_gps");
});

test("gps precision hidden blocks both exact and approximate", () => {
  const policy = {
    ...WORKFLOW_BASELINE_VISIBILITY_POLICY,
    gps: { audience: "public", precision: "hidden" },
  };
  const exact = resolveVisibilityForViewer({
    dataClass: "gps_exact",
    surface: "PUBLIC_VERIFY",
    visibilityPolicy: policy,
  });
  const approx = resolveVisibilityForViewer({
    dataClass: "gps_approximate",
    surface: "PUBLIC_VERIFY",
    visibilityPolicy: policy,
  });
  assert.equal(exact.allowed, false);
  assert.equal(approx.allowed, false);
});

test("ai advisory stays out of report by default and opts in only when policy says so", () => {
  const defaultDecision = resolveVisibilityForViewer({
    dataClass: "ai_advisory_output",
    surface: "REPORT_PDF",
  });
  assert.equal(defaultDecision.allowed, false);

  const optedIn = resolveVisibilityForViewer({
    dataClass: "ai_advisory_output",
    surface: "REPORT_PDF",
    visibilityPolicy: {
      ...WORKFLOW_BASELINE_VISIBILITY_POLICY,
      aiAdvisory: { audience: "authenticated_workspace", includeInReport: true },
    },
  });
  assert.equal(optedIn.allowed, true);
  assert.equal(optedIn.transform, "none");
});

// -----------------------------------------------------------------------------
// Viewer-role gates on AUTHENTICATED_APP
// -----------------------------------------------------------------------------

test("VIEWER role cannot see reviewer_only data on AUTHENTICATED_APP", () => {
  const decision = resolveVisibilityForViewer({
    dataClass: "session_internal_notes",
    surface: "AUTHENTICATED_APP",
    viewer: { kind: "workspace_member", role: "VIEWER" },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.source, "viewer_role");
});

test("MEMBER role can see reviewer_only data on AUTHENTICATED_APP", () => {
  const decision = resolveVisibilityForViewer({
    dataClass: "session_internal_notes",
    surface: "AUTHENTICATED_APP",
    viewer: { kind: "workspace_member", role: "MEMBER" },
  });
  assert.equal(decision.allowed, true);
});

test("OWNER and ADMIN roles can see reviewer_only data on AUTHENTICATED_APP", () => {
  for (const role of ["OWNER", "ADMIN"]) {
    const decision = resolveVisibilityForViewer({
      dataClass: "legal_note",
      surface: "AUTHENTICATED_APP",
      viewer: { kind: "workspace_member", role },
    });
    assert.equal(decision.allowed, true, `expected ${role} to see legal notes`);
  }
});

test("public_anonymous viewer cannot promote into reviewer_only data", () => {
  // Note: PUBLIC_VERIFY surface itself already filters reviewer_only via
  // audience compatibility. This test reaffirms the layered defense.
  const decision = resolveVisibilityForViewer({
    dataClass: "session_internal_notes",
    surface: "PUBLIC_VERIFY",
    viewer: { kind: "public_anonymous" },
  });
  assert.equal(decision.allowed, false);
});

// -----------------------------------------------------------------------------
// External submitter view
// -----------------------------------------------------------------------------

test("external submitter cannot see reviewer_only data on their own view", () => {
  for (const dataClass of [
    "session_internal_notes",
    "per_part_private_note",
    "reviewer_comment_internal",
    "legal_note",
    "ai_advisory_output",
  ]) {
    const decision = resolveVisibilityForViewer({
      dataClass,
      surface: "EXTERNAL_SUBMITTER_VIEW",
      viewer: {
        kind: "external_submitter",
        intakeMode: "EXTERNAL_ONE_TIME",
        intakeLinkId: "link-1",
      },
    });
    assert.equal(decision.allowed, false, `external submitter saw ${dataClass}`);
  }
});

test("external submitter sees public_description and metadata_technical", () => {
  for (const dataClass of ["public_description", "metadata_technical"]) {
    const decision = resolveVisibilityForViewer({
      dataClass,
      surface: "EXTERNAL_SUBMITTER_VIEW",
      viewer: { kind: "external_submitter", intakeMode: "EXTERNAL_ONE_TIME" },
    });
    assert.equal(decision.allowed, true, `external submitter blocked from ${dataClass}`);
  }
});
