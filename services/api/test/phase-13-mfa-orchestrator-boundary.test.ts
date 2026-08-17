/**
 * PHASE 13 (NEW-058) — THE MFA ORCHESTRATOR BOUNDARY GATE, AND ITS REFUSALS.
 *
 * Two halves, and the second is the one that matters.
 *
 * The POSITIVE half runs the evaluator against the real repository and asserts
 * the boundary holds today. The ADVERSARIAL half hands the same evaluator five
 * deliberately-violating trees — one per way this boundary has actually been
 * broken or could be — and asserts it refuses each. A gate whose only evidence
 * is that it passed once has not been shown to be capable of failing, and the
 * pin this replaces was exactly that: a byte ceiling that would have stayed
 * green while someone added a parallel MFA authority and deleted an equal
 * number of bytes elsewhere.
 *
 * The five refusals mirror the five failure modes named in the phase contract:
 *   1. caller-supplied phone reintroduced into a step-up body
 *   2. a parallel factor authority in a route module
 *   3. direct destination resolution inside a route handler
 *   4. an enrolment handler bypassing the canonical factor service
 *   5. business logic (a raw database write) added inline to a handler
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  mfaOrchestratorBoundary,
  type BoundarySources,
} from "./security/mfa-orchestrator-boundary.js";

const API_ROOT = fileURLToPath(new URL("../", import.meta.url));

const STEP_UP_ROUTE = "src/routes/identity-security.routes.ts";
const ENROLLMENT_ROUTE = "src/routes/identity-security-contact-factors.routes.ts";
const ENROLLMENT_START_PATH =
  "/v1/identity-security/contact-factors/enroll/start";
const FACTOR_SERVICE_SPECIFIER = "verified-contact-factor.service";

/**
 * The step-up / contact-factor authority. A handler calling any of these is
 * IN SCOPE for the "no caller-supplied destination" rule, wherever it is
 * registered — which is why the rule cannot be evaded by moving the route, and
 * why it does not mis-fire on `/v1/communications/verify/start` (the generic
 * verification primitive, which legitimately takes a phone and touches none of
 * these).
 */
const STEP_UP_AUTHORITY_FUNCTIONS = [
  "startStepUpChallenge",
  "checkStepUpChallenge",
  "requireStepUpForSensitiveAction",
  "verifyAccountStepUp",
  "resolveStepUpDestination",
  "resolveActiveContactFactor",
  "startContactFactorEnrollment",
  "completeContactFactorEnrollment",
  "resolveEnrollingDestination",
] as const;

/**
 * The modules permitted to write `mfa_factors`, each an authority over a
 * DIFFERENT part of the factor lifecycle:
 *
 *   verified-contact-factor.service  contact factors (SMS / WhatsApp) — NEW-058
 *   mfa.service                      TOTP enrolment and activation — R8.1.1
 *   mfa-admin-lifecycle.service      operator-side revocation
 *   mfa-recovery-request.service     the approved-recovery reset
 *
 * A file writing the table that is not on this list is a fifth opinion about
 * what "verified" means, which is what `ParallelMfaAuthorities` counts.
 */
const SANCTIONED_FACTOR_WRITERS = [
  "src/services/security/verified-contact-factor.service.ts",
  "src/services/security/mfa.service.ts",
  "src/services/security/mfa-admin-lifecycle.service.ts",
  "src/services/security/mfa-recovery-request.service.ts",
] as const;

function readApi(rel: string): string {
  return readFileSync(resolve(API_ROOT, rel), "utf8");
}

/** Every `.ts` file under `src/`, repo-relative to the api package. */
function collect(dir: string, out: Record<string, string> = {}): Record<string, string> {
  const abs = resolve(API_ROOT, dir);
  for (const entry of readdirSync(abs)) {
    const relPath = `${dir}/${entry}`;
    const st = statSync(resolve(API_ROOT, relPath));
    if (st.isDirectory()) collect(relPath, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out[relPath] = readFileSync(resolve(API_ROOT, relPath), "utf8");
    }
  }
  return out;
}

function realSources(): BoundarySources {
  const routeFiles = collect("src/routes");
  const all = collect("src");
  const serviceFiles: Record<string, string> = {};
  for (const [path, text] of Object.entries(all)) {
    if (!(path in routeFiles)) serviceFiles[path] = text;
  }
  return {
    routeFiles,
    serviceFiles,
    enrollmentStartPath: ENROLLMENT_START_PATH,
    stepUpAuthorityFunctions: STEP_UP_AUTHORITY_FUNCTIONS,
    factorServiceSpecifier: FACTOR_SERVICE_SPECIFIER,
    sanctionedFactorWriters: SANCTIONED_FACTOR_WRITERS,
    stepUpRoutePath: STEP_UP_ROUTE,
    enrollmentRoutePath: ENROLLMENT_ROUTE,
  };
}

// ===========================================================================
// POSITIVE — the repository as it stands
// ===========================================================================

describe("NEW-058 — the MFA orchestrator boundary holds", () => {
  const report = mfaOrchestratorBoundary(realSources());

  it("no step-up request accepts a caller-supplied destination", () => {
    expect(report.problems.filter((p) => p.startsWith("CallerSuppliedDestination"))).toEqual([]);
    expect(report.callerSuppliedDestination).toBe(0);
  });

  it("no route module is a parallel MFA factor authority", () => {
    expect(report.problems.filter((p) => p.startsWith("ParallelMfaAuthorities"))).toEqual([]);
    expect(report.parallelMfaAuthorities).toBe(0);
  });

  it("every enrolment handler delegates to the canonical factor service", () => {
    expect(report.problems.filter((p) => p.startsWith("EnrollmentHandlersCanonical"))).toEqual([]);
    expect(report.enrollmentHandlersCanonical).toBe(true);
  });

  it("the step-up route module holds no elevation authority", () => {
    expect(report.problems.filter((p) => p.startsWith("StepUpAuthorityIntact"))).toEqual([]);
    expect(report.stepUpAuthorityIntact).toBe(true);
  });

  it("MfaOrchestratorGate — the whole boundary reports no problem", () => {
    expect(report.problems).toEqual([]);
  });

  /**
   * The enrolment routes are REGISTERED. Extracting them into their own plugin
   * restores the orchestration boundary only if the product still serves them;
   * an extraction that silently dropped four routes would satisfy every
   * structural check above and delete the capability.
   */
  it("the extracted enrolment plugin is registered in production", () => {
    const server = readApi("src/server.ts");
    expect(server).toMatch(/identitySecurityContactFactorRoutes/);
    expect(server).toMatch(/app\.register\(identitySecurityContactFactorRoutes\)/);
  });

  it("the four enrolment route paths survived the extraction unchanged", () => {
    const src = readApi(ENROLLMENT_ROUTE);
    for (const path of [
      "/v1/identity-security/contact-factors",
      "/v1/identity-security/contact-factors/enroll/start",
      "/v1/identity-security/contact-factors/enroll/verify",
      "/v1/identity-security/contact-factors/:id/revoke",
    ]) {
      expect(src, `missing route ${path}`).toContain(`"${path}"`);
    }
  });
});

// ===========================================================================
// ADVERSARIAL — each invariant must be able to say no
// ===========================================================================

/** The real tree, with ONE file's text replaced by a violating variant. */
function withFile(path: string, text: string): BoundarySources {
  const base = realSources();
  return { ...base, routeFiles: { ...base.routeFiles, [path]: text } };
}

const MINIMAL_ENROLLMENT = `
import { z } from "zod";
import {
  completeContactFactorEnrollment,
  listContactFactors,
  revokeContactFactor,
  startContactFactorEnrollment,
} from "../services/security/verified-contact-factor.service.js";

export async function identitySecurityContactFactorRoutes(app: any) {
  const EnrollStartBody = z.object({ teamId: z.string(), destination: z.string() }).strict();
  app.get("/v1/identity-security/contact-factors", {}, async (req: any, reply: any) => {
    return reply.code(200).send({ factors: await listContactFactors("u") });
  });
  app.post("/v1/identity-security/contact-factors/enroll/start", {}, async (req: any, reply: any) => {
    const body = EnrollStartBody.parse(req.body ?? {});
    return reply.code(200).send(await startContactFactorEnrollment(body));
  });
  app.post("/v1/identity-security/contact-factors/enroll/verify", {}, async (req: any, reply: any) => {
    return reply.code(200).send(await completeContactFactorEnrollment({}));
  });
  app.post("/v1/identity-security/contact-factors/:id/revoke", {}, async (req: any, reply: any) => {
    return reply.code(200).send(await revokeContactFactor({}));
  });
}
`;

describe("NEW-058 — the boundary gate REFUSES", () => {
  it("1. refuses a caller-supplied phone reintroduced into the step-up body", () => {
    const violating = `
import { z } from "zod";
export async function identitySecurityRoutes(app: any) {
  const StartBody = z.object({
    teamId: z.string(),
    purpose: z.string(),
    phone: z.string().min(3).max(32),
  }).strict();
  app.post("/v1/identity-security/step-up/start", {}, async (req: any, reply: any) => {
    const body = StartBody.parse(req.body ?? {});
    return reply.code(200).send(await startStepUpChallenge({ phoneE164OrRaw: body.phone }));
  });
}
`;
    const report = mfaOrchestratorBoundary(withFile(STEP_UP_ROUTE, violating));
    expect(report.callerSuppliedDestination).toBeGreaterThan(0);
    expect(report.problems.some((p) => p.includes("`phone`"))).toBe(true);
  });

  /**
   * The defect must stay caught when the route is MOVED. Path-scoped checks
   * would miss this; the scope is decided by the authority the handler calls.
   */
  it("1a. refuses the same defect registered under an unrelated path", () => {
    const violating = `
import { z } from "zod";
export async function someOtherRoutes(app: any) {
  const Body = z.object({ teamId: z.string(), destination: z.string() }).strict();
  app.post("/v1/somewhere-else/elevate", {}, async (req: any, reply: any) => {
    const body = Body.parse(req.body ?? {});
    return reply.code(200).send(await startStepUpChallenge({ to: body.destination }));
  });
}
`;
    const report = mfaOrchestratorBoundary(withFile("src/routes/cases.routes.ts", violating));
    expect(report.callerSuppliedDestination).toBeGreaterThan(0);
  });

  it("1b. a RENAMED destination field does not launder the same defect", () => {
    const violating = `
import { z } from "zod";
export async function identitySecurityRoutes(app: any) {
  const StartBody = z.object({ teamId: z.string(), to: z.string() }).strict();
  app.post("/v1/identity-security/step-up/start", {}, async (req: any, reply: any) => {
    const body = StartBody.parse(req.body ?? {});
    return reply.code(200).send(await startStepUpChallenge({ dest: body.to }));
  });
}
`;
    const report = mfaOrchestratorBoundary(withFile(STEP_UP_ROUTE, violating));
    expect(report.callerSuppliedDestination).toBeGreaterThan(0);
  });

  it("2. refuses a parallel factor authority inside a route module", () => {
    const violating = `${MINIMAL_ENROLLMENT}
export async function shadowAuthority(userId: string) {
  return prisma.mfaFactor.update({ where: { userId }, data: { status: "ACTIVE" } });
}
`;
    const report = mfaOrchestratorBoundary(withFile(ENROLLMENT_ROUTE, violating));
    expect(report.parallelMfaAuthorities).toBeGreaterThan(0);
    expect(report.problems.some((p) => p.includes("writes mfa_factors directly"))).toBe(true);
  });

  it("3. refuses direct destination resolution inside a route handler", () => {
    const violating = MINIMAL_ENROLLMENT.replace(
      "return reply.code(200).send(await startContactFactorEnrollment(body));",
      "const e164 = normaliseToE164(body.destination);\n    return reply.code(200).send(await startContactFactorEnrollment({ ...body, e164 }));",
    );
    const report = mfaOrchestratorBoundary(withFile(ENROLLMENT_ROUTE, violating));
    expect(report.enrollmentHandlersCanonical).toBe(false);
    expect(report.problems.some((p) => p.includes("resolves a destination inline"))).toBe(true);
  });

  it("4. refuses an enrolment handler that bypasses the canonical factor service", () => {
    const violating = MINIMAL_ENROLLMENT.replace(
      "return reply.code(200).send(await completeContactFactorEnrollment({}));",
      "return reply.code(200).send({ activated: true });",
    );
    const report = mfaOrchestratorBoundary(withFile(ENROLLMENT_ROUTE, violating));
    expect(report.enrollmentHandlersCanonical).toBe(false);
    expect(
      report.problems.some((p) => p.includes("calls no function of the canonical factor service")),
    ).toBe(true);
  });

  it("5. refuses business logic added inline as a raw database write", () => {
    const violating = MINIMAL_ENROLLMENT.replace(
      "return reply.code(200).send(await revokeContactFactor({}));",
      "await prisma.mfaFactor.updateMany({ where: {}, data: { status: \"REVOKED\" } });\n    return reply.code(200).send({ ok: true });",
    );
    const report = mfaOrchestratorBoundary(withFile(ENROLLMENT_ROUTE, violating));
    expect(report.enrollmentHandlersCanonical).toBe(false);
    expect(report.problems.some((p) => p.includes("reaches the database directly"))).toBe(true);
  });

  it("6. refuses a step-up route module that consumes an approved challenge", () => {
    const violating = `
export async function identitySecurityRoutes(app: any) {
  app.post("/v1/identity-security/step-up/check", {}, async (req: any, reply: any) => {
    await consumeApprovedChallenge({ id: req.body.challengeId });
    return reply.code(200).send({ ok: true });
  });
}
`;
    const report = mfaOrchestratorBoundary(withFile(STEP_UP_ROUTE, violating));
    expect(report.stepUpAuthorityIntact).toBe(false);
    expect(report.problems.some((p) => p.includes("consumes an approved challenge"))).toBe(true);
  });

  it("7. refuses the enrolment plugin being deleted outright", () => {
    const base = realSources();
    const routeFiles = { ...base.routeFiles };
    delete routeFiles[ENROLLMENT_ROUTE];
    const report = mfaOrchestratorBoundary({ ...base, routeFiles });
    expect(report.enrollmentHandlersCanonical).toBe(false);
  });

  /**
   * The positive control. An evaluator that refuses everything is as useless as
   * one that refuses nothing, so the minimal COMPLIANT enrolment module must
   * pass every enrolment check.
   */
  it("8. positive control — a compliant minimal enrolment module passes", () => {
    const report = mfaOrchestratorBoundary(withFile(ENROLLMENT_ROUTE, MINIMAL_ENROLLMENT));
    expect(report.problems.filter((p) => p.startsWith("EnrollmentHandlersCanonical"))).toEqual([]);
    expect(report.enrollmentHandlersCanonical).toBe(true);
  });
});
