/**
 * UC-4 — cross-cutting guards (source contract): observability, claim-safety,
 * Cases scoping, and security argv.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const repo = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), "utf8");

const WORKER_HANDLER = repo("services/worker/src/screen-intelligence.handler.ts");
const SERVICE = repo(
  "packages/shared-runtime/src/media-intelligence/screen-intelligence.service.ts",
);
const TESSERACT = repo("services/worker/src/tesseract-ocr-provider.ts");
const FFMPEG = repo("services/worker/src/ffmpeg-derived-assets.ts");
const MI_ROUTES = repo("services/api/src/routes/media-intelligence.routes.ts");

describe("UC-4 observability (§57) — never logs derived content", () => {
  it("the worker handler logs bounded counts, never OCR/reconstruction text", () => {
    // Log calls exist…
    expect(WORKER_HANDLER).toMatch(/logger\.(info|warn|error)/);
    // …but never log the observation/block text or region text.
    expect(WORKER_HANDLER).not.toMatch(/logger\.[a-z]+\([^)]*\.text\b/);
    expect(WORKER_HANDLER).not.toMatch(/observations:\s*observationRecords/);
  });

  it("the service does not log OCR text and does not print regions", () => {
    // The persistence service uses no logger at all (bounded results only) and
    // never stringifies observation text into a log.
    expect(SERVICE).not.toMatch(/console\.(log|info|warn|error)/);
    expect(SERVICE).not.toMatch(/logger\./);
  });
});

describe("UC-4 security (§63) — no shell; argv spawn only", () => {
  it("tesseract + ffmpeg spawn with an argv array and never a shell", () => {
    expect(TESSERACT).toMatch(/spawn\(/);
    expect(TESSERACT).not.toMatch(/shell:\s*true/);
    expect(TESSERACT).not.toMatch(/execSync|exec\(/);
    expect(FFMPEG).toMatch(/spawn\(/);
    expect(FFMPEG).not.toMatch(/shell:\s*true/);
    expect(FFMPEG).not.toMatch(/execSync|exec\(/);
  });
});

describe("UC-4 Cases (§42) — derived review is EVIDENCE-scoped, not copied per case", () => {
  it("the derived-review routes are addressed by evidenceId only", () => {
    expect(MI_ROUTES).toMatch(/"\/v1\/evidence\/:evidenceId\/derived-review"/);
    expect(MI_ROUTES).toMatch(
      /"\/v1\/evidence\/:evidenceId\/derived-review\/generate"/,
    );
    // There is NO case-scoped derived-review route (Case → Evidence → same review).
    expect(MI_ROUTES).not.toMatch(/\/v1\/cases\/[^"]*derived-review/);
  });
});

describe("UC-4 claim-safety (§65) — the persisted descriptor makes no truth claims", () => {
  it("the service/descriptor never assert authenticity/verification of content", () => {
    for (const src of [SERVICE, WORKER_HANDLER]) {
      expect(src).not.toMatch(/authentic conversation/i);
      expect(src).not.toMatch(/verified (message|sender|identity|truth)/i);
      expect(src).not.toMatch(/tamper-proof|legally admissible/i);
    }
  });
});
