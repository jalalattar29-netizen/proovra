/**
 * A REJECTED BODY IS NOT A SERVER FAULT.
 *
 * Every public intake route ends in a catch-all, and each answered anything it
 * did not recognise with a bare 500 `INTERNAL_ERROR` — which the public page
 * renders as "We hit a problem on our side. Please try again in a moment."
 *
 * Reproduced against the local fixture: a consent POST whose body did not
 * match the schema came back 500 INTERNAL_ERROR, and the server log recorded
 * it as `route: "external-intake.identity"` — the wrong endpoint, because five
 * labels covered seven routes and one had been copied. So the one production
 * signal for the failure pointed somewhere else.
 *
 * The API already owns the right answer: its global handler turns a `ZodError`
 * into a bounded 400 `INVALID_INPUT` with `fields[]`, which the public page
 * maps to a sentence a contributor can act on. The catch-alls were intercepting
 * the error before it could get there. They now re-throw it, and every one of
 * them logs under its own name.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoPath = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const ROUTES = readFileSync(repoPath("services/api/src/routes/external-intake.routes.ts"), "utf8");
const EVIDENCE_ROUTES = readFileSync(
  repoPath("services/api/src/routes/evidence.routes.ts"),
  "utf8",
);
const CITIZEN = readFileSync(
  repoPath("services/api/src/services/capture-trust/citizen-capture.service.ts"),
  "utf8",
);

/**
 * Source with its commentary removed.
 *
 * One assertion below forbids a commercial code from appearing in the intake
 * boundary — and the comment that explains WHY names the very code it forbids,
 * because an explanation that cannot mention its subject is not an
 * explanation. The rule is about what the boundary DOES, so it is asked of the
 * code alone.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("public intake error contract", () => {
  it("routes every catch-all through one decision", () => {
    // The shared handler exists and re-throws a schema rejection rather than
    // re-implementing the validation reply.
    expect(ROUTES).toMatch(/function intakeUnhandled\(/);
    expect(ROUTES).toMatch(/if \(err instanceof ZodError\) throw err;/);

    // Every generic catch-all delegates to it.
    const delegations = ROUTES.match(/intakeUnhandled\(\s*err,\s*req,\s*reply,\s*"/g) ?? [];
    expect(delegations.length).toBe(5);
  });

  it("never turns a rejected body into a 500", () => {
    /*
     * The submit route keeps its own richer handler — requestId, sessionId, a
     * security event and the bounded SUBMIT_FAILED code — so it is guarded
     * separately rather than folded in. What matters is that no route can
     * still answer a ZodError with a server fault.
     */
    const guards = ROUTES.match(/if \(err instanceof ZodError\) throw err;/g) ?? [];
    expect(guards.length).toBe(2);

    // No catch-all writes the bare 500 inline any more; the only remaining
    // INTERNAL_ERROR literals are the shared handler and the friendly-copy map.
    const inlineFivehundreds =
      ROUTES.match(/return reply\s*\n?\s*\.code\(500\)\s*\n?\s*\.send\(\{ error: \{ code: "INTERNAL_ERROR" \} \}\)/g) ??
      [];
    expect(inlineFivehundreds.length).toBe(0);
  });

  it("logs each route under its own name", () => {
    /*
     * The consent route logged itself as `external-intake.identity`, and the
     * two part routes shared one label. A wrong label is worse than no label:
     * it sends an operator to the wrong endpoint.
     */
    const labels = [...ROUTES.matchAll(/intakeUnhandled\(\s*err,\s*req,\s*reply,\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(
      expect.arrayContaining([
        "external-intake.validate",
        "external-intake.consent",
        "external-intake.part.create",
        "external-intake.part.update",
        "external-intake.transition",
      ]),
    );
    // The mislabelled one must not come back.
    expect(labels).not.toContain("external-intake.identity");
  });

  it("still answers a genuine unexpected fault generically", () => {
    // There is nothing honest to add for an unknown fault, so the generic
    // sentence and the 500 stay — with the error logged server-side.
    const handler = ROUTES.slice(
      ROUTES.indexOf("function intakeUnhandled("),
      ROUTES.indexOf("export async function externalIntakeRoutes("),
    );
    expect(handler).toMatch(/req\.log\.error\(/);
    expect(handler).toMatch(/intakeErrorUnhandled: true/);
    expect(handler).toMatch(/code: "INTERNAL_ERROR"/);
  });

  it("gives the contributor something the operator can grep for", () => {
    /*
     * A bounded 500 with no correlation id is a dead end for everyone: the
     * contributor has nothing to quote and the operator has no key to find the
     * log line. A production report of this exact banner could not be traced
     * to a server log for that reason.
     *
     * The submit route already returned a requestId and the public page
     * already rendered it as a Support ID; every public intake route now does
     * the same. The id identifies a REQUEST — it carries nothing about the
     * contributor, the link or the token.
     */
    const handler = ROUTES.slice(
      ROUTES.indexOf("function intakeUnhandled("),
      ROUTES.indexOf("export async function externalIntakeRoutes("),
    );
    expect(handler).toContain("const requestId = req.id ?? null;");
    expect(handler).toContain('code: "INTERNAL_ERROR", requestId');
    expect(handler).toContain("{ err, route, requestId, intakeErrorUnhandled: true }");
  });

  it("never turns an expected commercial denial into a 500 either", () => {
    /*
     * PROVEN IN PRODUCTION (support id cd2f011d-…, 2026-09-05). A workspace
     * that had used every evidence record its plan includes refused the
     * submission — correctly, via `assertWorkspaceAllowsEvidenceCreation`,
     * which raises a `DomainError` declaring httpStatus 409, publicCode
     * EVIDENCE_RECORD_LIMIT_REACHED and `reportability: \"EXPECTED_DENIAL\"`.
     * This catch-all flattened it to 500 INTERNAL_ERROR.
     *
     * The behaviour is proven end-to-end against live PostgreSQL in
     * `evidence-commercial-denial-contract.integration.test.ts`. What is
     * pinned HERE is the SHAPE of the decision, because the shape is what
     * decays: the boundary must keep ASKING the platform's classifier rather
     * than growing a list of commercial codes that drifts from the
     * authority that raises them.
     */
    expect(ROUTES).toMatch(/classifyReportability\(err\) !== "UNEXPECTED"/);
    expect(ROUTES).toMatch(/function intakeBoundedDenial\(/);

    // No allowlist. The boundary must not learn any commercial code by name.
    for (const code of [
      "EVIDENCE_RECORD_LIMIT_REACHED",
      "FREE_LIMIT_REACHED",
      "EVIDENCE_RECORD_MONTHLY_LIMIT_REACHED",
      "INSUFFICIENT_EVIDENCE_CREDITS",
      "TEAM_PLAN_REQUIRED",
    ]) {
      expect(
        stripComments(ROUTES).includes(code),
        `the public intake boundary must not name ${code} — it asks ` +
          "classifyReportability instead, so it cannot drift from the " +
          "commercial authority",
      ).toBe(false);
    }
  });

  it("answers a bounded denial with the sender's business kept out of it", () => {
    const handler = ROUTES.slice(
      ROUTES.indexOf("function intakeBoundedDenial("),
      ROUTES.indexOf("function intakeUnhandled("),
    );
    /*
     * The canonical `publicMessage` for this denial is addressed to the
     * ACCOUNT HOLDER — it names the allowance and tells them to buy credits.
     * This endpoint is unauthenticated, so the STATUS and the reason are
     * preserved while the SENTENCE is the public intake one.
     */
    expect(handler).toContain('code: "INTAKE_NOT_ACCEPTING_EVIDENCE"');
    expect(handler).toContain("friendlyPublicIntakeMessage(\"INTAKE_NOT_ACCEPTING_EVIDENCE\")");
    expect(handler).not.toContain("publicMessage");

    // 4xx only: a 5xx reachable from here would be the original bug.
    expect(handler).toMatch(/rawStatus >= 400 && rawStatus < 500/);

    // Warn, not error, and named for what it is.
    expect(handler).toMatch(/req\.log\.warn\(/);
    expect(handler).not.toMatch(/req\.log\.error\(/);

    // The sender can find out; the contributor is told to contact them.
    expect(handler).toContain("emitTenantAudit(");
    expect(handler).toContain('outcome: "denied"');
  });

  it("submit refuses the same way rather than calling it SUBMIT_FAILED", () => {
    /*
     * Submit runs `completeEvidence`, which spends an evidence credit and
     * re-checks storage — so the same authorities can refuse there. Answering
     * SUBMIT_FAILED would tell a contributor to press Submit again against a
     * workspace that will refuse every time.
     */
    const submitCatch = ROUTES.slice(
      ROUTES.indexOf('route: "external-intake.submit"') - 3000,
      ROUTES.indexOf('code: "SUBMIT_FAILED"'),
    );
    expect(submitCatch).toContain('intakeBoundedDenial(');
    expect(submitCatch).toMatch(/classifyReportability\(err\) !== "UNEXPECTED"/);
  });

  it("the sibling evidence-creation boundaries make the same distinction", () => {
    /*
     * The defect was a CLASS, not a location: an expected denial swallowed by
     * a local catch and re-described as a fault. `createEvidence` has three
     * user-facing callers and each had its own boundary.
     *
     * Capture answered the record-cap codes correctly but audited everything
     * else in the family — credits, subscription lifecycle — as a CRITICAL
     * failure of evidence creation, so the audit trail and the wire response
     * disagreed about the same event.
     *
     * Citizen/mobile ingest returned `EVIDENCE_PERSIST_FAILED` for every
     * refusal, and its route maps exactly that reason to a 500.
     */
    expect(EVIDENCE_ROUTES).toMatch(
      /const expected = classifyReportability\(err\) !== "UNEXPECTED"/,
    );
    expect(EVIDENCE_ROUTES).toMatch(/outcome: expected \? "blocked" : "failure"/);
    expect(EVIDENCE_ROUTES).toMatch(/severity: expected \? "warning" : "critical"/);

    expect(CITIZEN).toContain('"WORKSPACE_CAPACITY_REACHED"');
    expect(CITIZEN).toMatch(/classifyReportability\(err\) === "UNEXPECTED"/);
  });
});
