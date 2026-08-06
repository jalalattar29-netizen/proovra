/**
 * Phase 3A (Redaction closure) — PUBLISHING a redacted derivative must
 * require STEP-UP.
 *
 * Publishing a redacted derivative is the irreversible, disclosure-shaping
 * step of the redaction lifecycle: it flips the version + project to
 * PUBLISHED so downstream consumers (public verify badge, reports,
 * packages, derivative download) treat that derivative as the authoritative
 * redacted artifact. Previously the publish route was only RBAC-gated
 * (`redaction.version.publish`) + audited. This closure adds a dedicated
 * step-up purpose `REDACTION_PUBLISH` and gates the publish mutation with
 * `requireStepUpForSensitiveAction`, placed AFTER the RBAC capability check
 * and BEFORE the PUBLISHED transition.
 *
 * Contract pins (source-contract style, matching the sibling
 * phase-3-external-review-grant-step-up + phase-3a-redaction-platform
 * tests). They read the canonical source without a DB / Fastify spin-up so
 * they stay fast and never depend on a populated dev database.
 *
 * What IS gated (SENSITIVE — irreversible publish / disclosure):
 *   * POST /v1/redaction/versions/:id/publish
 *
 * What is NOT gated (view / author / detection / submit / approve /
 * derivative render-request):
 *   * GET   /v1/redaction/projects/:id                (view)
 *   * GET   /v1/redaction/versions/:id/derivative     (view)
 *   * POST  /v1/redaction/versions/:id/submit         (submit)
 *   * POST  /v1/redaction/versions/:id/approve        (approve)
 *   * POST  /v1/redaction/versions/:id/derivative     (render request)
 *
 * ORIGINAL EVIDENCE SAFETY: redaction NEVER mutates the original Evidence
 * row — the derivative service refuses to write a derivative whose storage
 * key collides with the evidence storage key, and the publish transition
 * only touches redaction_version / redaction_project rows (verified in the
 * service source pins below). No evidence hash / storageKey is ever
 * rewritten by publish.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  STEP_UP_PURPOSES,
  StepUpPurposeSchema,
  type StepUpPurpose,
} from "@proovra/shared";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const SHARED_IDENTITY = readSource(
  "../../../packages/shared/src/identity-security.ts",
);
const MFA_POLICY = readSource(
  "../../../services/api/src/services/identity-security/mfa-policy.service.ts",
);
const ROUTES_REDACTION = readSource(
  "../../../services/api/src/routes/redaction.routes.ts",
);
const SVC_PROJECT = readSource(
  "../../../services/api/src/services/redaction/redaction-project.service.ts",
);

const PURPOSE = "REDACTION_PUBLISH";

// =============================================================================
// PART 1 — Shared step-up purpose
// =============================================================================

describe("Phase 3A — REDACTION_PUBLISH step-up purpose", () => {
  it("is a member of the canonical STEP_UP_PURPOSES enum", () => {
    expect((STEP_UP_PURPOSES as readonly string[]).includes(PURPOSE)).toBe(
      true,
    );
  });

  it("is accepted by StepUpPurposeSchema (runtime validator)", () => {
    expect(StepUpPurposeSchema.safeParse(PURPOSE).success).toBe(true);
    // The schema still rejects ad-hoc strings — the enum is exhaustive.
    expect(StepUpPurposeSchema.safeParse("REDACTION_ANYTHING").success).toBe(
      false,
    );
  });

  it("is typed as a StepUpPurpose", () => {
    const p: StepUpPurpose = PURPOSE;
    expect(p).toBe(PURPOSE);
  });

  it("is declared in the shared identity-security source", () => {
    expect(SHARED_IDENTITY).toMatch(/"REDACTION_PUBLISH"/);
  });

  it("is in the canonical MFA force-list (always forces step-up)", () => {
    // ACTIONS_FORCING_MFA is the source of truth for sensitive actions;
    // the new purpose must be present so org policy can never waive it.
    expect(MFA_POLICY).toMatch(
      /ACTIONS_FORCING_MFA[\s\S]*"REDACTION_PUBLISH"[\s\S]*\];/,
    );
  });
});

// =============================================================================
// PART 2 — Publish route is gated (AFTER RBAC, BEFORE mutation)
// =============================================================================

describe("Phase 3A — publish route is step-up gated", () => {
  it("redaction.routes imports requireStepUpForSensitiveAction", () => {
    expect(ROUTES_REDACTION).toMatch(
      /import\s+\{\s*requireStepUpForSensitiveAction\s*\}\s+from\s+["'][^"']*step-up-middleware\.js["']/,
    );
  });

  it("POST /publish gates on REDACTION_PUBLISH after the RBAC capability check, before the PUBLISHED transition", () => {
    // Isolate the publish handler block: from its route path to the
    // transitionRedactionVersion mutation call.
    const publishBlock = ROUTES_REDACTION.slice(
      ROUTES_REDACTION.indexOf('"/v1/redaction/versions/:id/publish"'),
      ROUTES_REDACTION.indexOf('"/v1/redaction/versions/:id/regions"'),
    );
    // RBAC capability check present.
    expect(publishBlock).toMatch(
      /gate\(reply,\s*ctx,\s*"redaction\.version\.publish"\)/,
    );
    // Step-up gate present with the canonical purpose + resource binding.
    expect(publishBlock).toMatch(/requireStepUpForSensitiveAction\(/);
    expect(publishBlock).toMatch(/purpose:\s*"REDACTION_PUBLISH"/);
    expect(publishBlock).toMatch(
      /resourceKind:\s*"redaction_derivative"/,
    );
    // Order pin: RBAC capability check BEFORE the step-up gate.
    expect(
      publishBlock.indexOf('gate(reply, ctx, "redaction.version.publish")'),
    ).toBeLessThan(
      publishBlock.indexOf("requireStepUpForSensitiveAction("),
    );
    // Order pin: step-up gate BEFORE the PUBLISHED transition (the mutation).
    expect(publishBlock.indexOf("requireStepUpForSensitiveAction(")).toBeLessThan(
      publishBlock.indexOf("transitionRedactionVersion({"),
    );
    // The mutation must be guarded by an early-return on gate.sent.
    expect(publishBlock).toMatch(/if\s*\(\s*gateResult\.sent\s*\)\s*return\s+reply;/);
  });
});

// =============================================================================
// PART 3 — Non-sensitive redaction routes are NOT step-up gated
// =============================================================================

describe("Phase 3A — view / author / submit / approve / derivative-request NOT gated", () => {
  it("project VIEW route does NOT require step-up", () => {
    const block = ROUTES_REDACTION.slice(
      ROUTES_REDACTION.indexOf('"/v1/redaction/projects/:id"'),
      ROUTES_REDACTION.indexOf('"/v1/redaction/projects/:id/activity"'),
    );
    expect(block).not.toMatch(/requireStepUpForSensitiveAction\(/);
  });

  it("version SUBMIT route does NOT require step-up", () => {
    const block = ROUTES_REDACTION.slice(
      ROUTES_REDACTION.indexOf('"/v1/redaction/versions/:id/submit"'),
      ROUTES_REDACTION.indexOf('"/v1/redaction/versions/:id/approve"'),
    );
    expect(block).not.toMatch(/requireStepUpForSensitiveAction\(/);
  });

  it("version APPROVE route does NOT require step-up", () => {
    const block = ROUTES_REDACTION.slice(
      ROUTES_REDACTION.indexOf('"/v1/redaction/versions/:id/approve"'),
      ROUTES_REDACTION.indexOf('"/v1/redaction/versions/:id/publish"'),
    );
    expect(block).not.toMatch(/requireStepUpForSensitiveAction\(/);
  });

  it("derivative RENDER-REQUEST route does NOT require step-up", () => {
    const block = ROUTES_REDACTION.slice(
      ROUTES_REDACTION.indexOf('"/v1/redaction/versions/:id/derivative"'),
      ROUTES_REDACTION.indexOf(
        "// Sentinel — also expose the derivative for a given version directly.",
      ),
    );
    expect(block).not.toMatch(/requireStepUpForSensitiveAction\(/);
  });
});

// =============================================================================
// PART 4 — RBAC still denies BEFORE step-up (unauthorized → 403 first)
// =============================================================================

describe("Phase 3A — RBAC denial precedes step-up", () => {
  it("publish handler runs the RBAC gate with an early-return BEFORE reaching the step-up gate", () => {
    const publishBlock = ROUTES_REDACTION.slice(
      ROUTES_REDACTION.indexOf('"/v1/redaction/versions/:id/publish"'),
      ROUTES_REDACTION.indexOf('"/v1/redaction/versions/:id/regions"'),
    );
    // The RBAC gate early-returns 403 (via the `gate` helper) so an actor
    // without redaction.version.publish is denied BEFORE any step-up
    // challenge is consumed.
    expect(publishBlock).toMatch(
      /if\s*\(!\(await gate\(reply,\s*ctx,\s*"redaction\.version\.publish"\)\)\)\s*return\s+reply;/,
    );
  });
});

// =============================================================================
// PART 5 — Audit metadata records the step-up outcome
// =============================================================================

describe("Phase 3A — publish audit records the step-up outcome", () => {
  it("route threads the consumed step-up challenge id into the transition", () => {
    const publishBlock = ROUTES_REDACTION.slice(
      ROUTES_REDACTION.indexOf('"/v1/redaction/versions/:id/publish"'),
      ROUTES_REDACTION.indexOf('"/v1/redaction/versions/:id/regions"'),
    );
    // The route reads the step-up header and passes it to the service so
    // the VERSION_PUBLISHED audit row records who authorised the disclosure.
    expect(publishBlock).toMatch(/x-proovra-step-up-challenge-id/);
    expect(publishBlock).toMatch(/stepUpChallengeId/);
  });

  it("VERSION_PUBLISHED activity payload captures stepUpVerified + challenge id + evidence-bound version", () => {
    // The transition emits VERSION_PUBLISHED through the EXISTING redaction
    // activity audit path (emitRedactionActivity) — not a second audit
    // system — and augments the payload with the step-up outcome. The
    // payload always carries the version id (versionId on the row) + project
    // id, tying the audit to the redaction job + evidence lineage.
    // The transition maps toState PUBLISHED to the VERSION_PUBLISHED
    // activity code (computed via ternary), then emits it.
    expect(SVC_PROJECT).toMatch(/"VERSION_PUBLISHED"/);
    expect(SVC_PROJECT).toMatch(/stepUpVerified/);
    expect(SVC_PROJECT).toMatch(/stepUpChallengeId/);
    expect(SVC_PROJECT).toMatch(/stepUpPurpose/);
    // emitRedactionActivity is the existing audit emitter — reused, not
    // replaced.
    expect(SVC_PROJECT).toMatch(/emitRedactionActivity\(/);
  });

  it("the audit stores only the bounded challenge id — never OTP / phone / session token", () => {
    // Defence-in-depth: the payload OBJECT must not carry secret material as
    // a key. We inspect the step-up payload spread (the object literal keys),
    // not the surrounding documentation comment, so the assertion tracks the
    // actual persisted shape.
    const spreadStart = SVC_PROJECT.indexOf(
      'input.toState === "PUBLISHED"',
    );
    const spreadEnd = SVC_PROJECT.indexOf("}", SVC_PROJECT.indexOf("stepUpPurpose"));
    const payloadSpread = SVC_PROJECT.slice(spreadStart, spreadEnd);
    // The only keys written are stepUpVerified / stepUpChallengeId /
    // stepUpPurpose — no otp/phone/token/password key.
    expect(payloadSpread).not.toMatch(
      /\b(otp|phone|sessionToken|password|token)\s*:/i,
    );
    expect(payloadSpread).toMatch(/stepUpVerified:/);
    expect(payloadSpread).toMatch(/stepUpChallengeId:/);
  });
});

// =============================================================================
// PART 6 — Original evidence hash / bytes are NEVER mutated by redaction
// =============================================================================

describe("Phase 3A — original evidence safety (publish never touches the original)", () => {
  it("the PUBLISHED transition only touches redaction_version / redaction_project — never the Evidence row", () => {
    // Isolate the transition body and confirm it mutates only redaction
    // tables. There is no prisma.evidence.update / .delete anywhere in the
    // publish path, so no evidence hash / storageKey is rewritten.
    expect(SVC_PROJECT).toMatch(/tx\.redactionVersion\.update\(/);
    expect(SVC_PROJECT).toMatch(/tx\.redactionProject\.update\(/);
    expect(SVC_PROJECT).not.toMatch(/prisma\.evidence\.(update|delete|upsert)/);
    expect(SVC_PROJECT).not.toMatch(/tx\.evidence\.(update|delete|upsert)/);
  });

  it("the redaction project service documents that the original Evidence row is NEVER altered", () => {
    expect(SVC_PROJECT).toMatch(/Original Evidence row is NEVER altered/i);
  });
});
