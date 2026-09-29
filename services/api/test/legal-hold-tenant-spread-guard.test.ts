/**
 * ET-SEC-34 / ET-SEC-17 — structural guards on the legal-hold authority.
 *
 * ET-SEC-34: three dead exported helpers (countActiveCaseHolds, listCaseHolds,
 * countLifecycleHolds) spread `teamId` only when supplied, so any future
 * caller that forgot it would read holds across every tenant. They are
 * deleted; no hold query in the authority may make its tenant optional.
 *
 * ET-SEC-17: the case-deletion hold decision fails closed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("legal-hold authority tenant guards", () => {
  it("ET-SEC-34: the dead optional-tenant helpers exist nowhere in the API source", () => {
    const hits = walk(SRC).filter((f) =>
      /\b(countActiveCaseHolds|listCaseHolds|countLifecycleHolds)\b/.test(readFileSync(f, "utf8")),
    );
    expect(hits).toEqual([]);
  });

  it("ET-SEC-34: no hold query in the legal-hold authority makes its tenant optional", () => {
    const src = read("services/governance/legal-hold.service.ts");
    expect(src).not.toMatch(/\.\.\.\(\s*input\.teamId\s*\?\s*\{\s*teamId/);
    expect(src).not.toMatch(/\.\.\.\(\s*input\.teamIds\s*&&/);
  });

  it("ET-SEC-17: the case-deletion hold decision answers `unavailable` on a store error, and the route maps it to 503", () => {
    const src = read("services/governance/legal-hold.service.ts");
    const at = src.indexOf("export async function evaluateCaseDeletionHold(");
    expect(at).toBeGreaterThan(0);
    const end = src.indexOf("\n}\n", at);
    const body = src.slice(at, end);
    expect(body).toMatch(/catch\s*\{\s*return \{ kind: "unavailable" \};\s*\}/);

    const routes = read("routes/cases.routes.ts");
    expect(routes).not.toMatch(/checkCaseLegalHold/);
    expect(routes).toMatch(/holdDecision\.kind === "unavailable"[\s\S]*?reply\.code\(503\)/);
  });
});
