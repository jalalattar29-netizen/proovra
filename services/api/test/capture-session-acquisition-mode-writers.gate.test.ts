/**
 * =============================================================================
 * F-28 — A CAPTURE SESSION'S ACQUISITION MODE IS WRITTEN ONCE, AT CREATION.
 * =============================================================================
 *
 * `capture_sessions.acquisition_mode` has a CHECK constraint but no set-once
 * trigger (the evidence table has one: evidence_acquisition_set_once_trg). The
 * 2026-10-29 audit traced every authority that can write the column and found
 * exactly two, both creations: the direct-capture session open
 * (direct-capture-ingest.service.ts `captureSession.create`, mode from the
 * request) and the Capture draft create (capture.routes.ts, null). No update,
 * upsert or raw SQL writes it, and the draft PATCH body is `.strict()` without
 * the field — so no reachable writer can change a session's mode, and the
 * mode is copied once onto the Evidence row at reservation, where the trigger
 * locks it.
 *
 * That is an invariant held by code, not by the schema, so this gate pins it:
 * any NEW executable writer of `acquisitionMode` on a capture session — an
 * update/updateMany/upsert data block, or raw SQL naming the column — fails
 * here by file name. A migration adding a trigger would only be warranted if a
 * writer ever has to exist; until then the gate is the cheaper, exact guard.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");
const SCAN = ["services/api/src", "services/worker/src", "packages/shared-runtime/src", "packages/shared/src"];

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      yield* files(p);
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\./.test(name)) {
      yield p;
    }
  }
}

/** Strip comments and string literals so prose about the invariant is invisible. */
function strip(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

const SESSION_WRITE_CALL = /captureSession\s*\.\s*(update|updateMany|upsert)\s*\(/g;

/** The balanced argument list of the call whose "(" is at `open`. */
function callArguments(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** An update/upsert of a capture session whose OWN argument names acquisitionMode. */
function sessionUpdateWritesMode(src: string): boolean {
  const code = strip(src);
  for (const m of code.matchAll(SESSION_WRITE_CALL)) {
    const args = callArguments(code, (m.index ?? 0) + m[0].length - 1);
    if (/\bacquisitionMode\b/.test(args)) return true;
  }
  return false;
}

function detect(src: string, rawSource: string): string[] {
  const found: string[] = [];
  if (sessionUpdateWritesMode(src)) found.push("prisma update/upsert writes acquisitionMode");
  // Raw SQL is a string, so it is checked on the raw source.
  if (/UPDATE\s+"?capture_sessions"?[\s\S]{0,400}?acquisition_mode\s*=/i.test(rawSource)) found.push("raw SQL updates acquisition_mode");
  return found;
}

describe("F-28: capture_sessions.acquisition_mode has no writer after creation", () => {
  it("no executable source updates a capture session's acquisition mode", () => {
    const violations: string[] = [];
    for (const base of SCAN) {
      for (const file of files(join(ROOT, base))) {
        const raw = readFileSync(file, "utf8");
        for (const v of detect(raw, raw)) violations.push(`${relative(ROOT, file).replace(/\\/g, "/")}: ${v}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("the draft PATCH body cannot carry an acquisition mode", () => {
    const routes = readFileSync(join(ROOT, "services/api/src/routes/capture.routes.ts"), "utf8");
    const body = /const UpdateSessionBody = z[\s\S]*?\.strict\(\)/.exec(routes)?.[0] ?? "";
    expect(body, "UpdateSessionBody must stay .strict()").toMatch(/\.strict\(\)$/);
    expect(body).not.toMatch(/acquisitionMode/);
  });

  it("negative control: the detector finds a real writer and ignores prose", () => {
    const writer = `await tx.captureSession.update({ where: { id }, data: { status: "BOUND", acquisitionMode: next } });`;
    const raw = `await prisma.$executeRaw\`UPDATE "capture_sessions" SET acquisition_mode = \${m} WHERE id = \${id}\`;`;
    const prose = `// captureSession.update({ data: { acquisitionMode } }) is forbidden\nconst s = "captureSession.update({ acquisitionMode: x })";`;
    expect(detect(writer, writer)).toHaveLength(1);
    expect(detect(raw, raw)).toEqual(["raw SQL updates acquisition_mode"]);
    expect(detect(prose, "")).toEqual([]);
  });
});
