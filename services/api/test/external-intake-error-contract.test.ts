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

describe("public intake error contract", () => {
  it("routes every catch-all through one decision", () => {
    // The shared handler exists and re-throws a schema rejection rather than
    // re-implementing the validation reply.
    expect(ROUTES).toMatch(/function intakeUnhandled\(/);
    expect(ROUTES).toMatch(/if \(err instanceof ZodError\) throw err;/);

    // Every generic catch-all delegates to it.
    const delegations = ROUTES.match(/intakeUnhandled\(err, req, reply, "/g) ?? [];
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
    const labels = [...ROUTES.matchAll(/intakeUnhandled\(err, req, reply, "([^"]+)"\)/g)].map(
      (m) => m[1],
    );
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
    expect(ROUTES).not.toMatch(/intakeUnhandled\(err, req, reply, "external-intake\.identity"\)/);
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
});
