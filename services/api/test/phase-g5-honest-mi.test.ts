/**
 * Phase G5.1 — Honest-MI UI honesty contract.
 *
 * The Honest-MI decision (docs/architecture/honest-mi-decision.md) is:
 * keep the bounded backend scaffold + lock the UI so no operator
 * surface can imply that OCR / transcription / extraction runs today.
 *
 * This suite walks every file in `apps/web/**` and asserts:
 *
 *   1. No forbidden EXTRACTION verb appears in user-facing strings.
 *      "Extract text", "Run OCR", "Transcribe", "Generate transcript",
 *      "Index text", "OCR this", etc.
 *
 *   2. The signal catalog's safe-word vocabulary is unchanged.
 *      No file introduces "tampered", "forged", "authentic",
 *      "admissible", "court-ready", "forensic proof".
 *
 *   3. The MediaIntelligencePanel is the ONLY file that may import the
 *      `useMediaIntelligence` hook. Any new caller is flagged for
 *      review.
 *
 * Style: source-contract. Reads files, asserts regex.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";

import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(
  new URL("../../../apps/web", import.meta.url),
);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".next" || name === "dist") {
        continue;
      }
      // TESTS ARE NOT OPERATOR-FACING COPY (2026-09-04).
      //
      // This scan walked `__tests__` too, so the guards that FORBID the
      // overclaim vocabulary were flagged for naming it: both
      // `capture-target-surfaces` and `capture-workflow-hierarchy` carry a
      // `["Court-ready", "Legally admissible", "Court approved"]` list and
      // assert the capture UI contains none of them.
      //
      // Nothing in a spec file is shown to anybody, and a rule that punishes
      // the code enforcing it has one outcome: somebody deletes the
      // enforcement. The rule is about strings that ship.
      if (name === "__tests__") {
        continue;
      }
      out.push(...walk(full));
      continue;
    }
    if (
      name.endsWith(".tsx") ||
      name.endsWith(".ts") ||
      name.endsWith(".jsx") ||
      name.endsWith(".js")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Phrases that, when used as user-facing UI text, imply that
 * OCR/transcript extraction runs today. They are FORBIDDEN until
 * the decision doc flips from B-prime to A.
 *
 * Each pattern targets the verb form an operator would see. Pure code
 * identifiers like `extractText()` or `transcriptIndexer` are not
 * matched because they don't appear in JSX strings.
 */
const FORBIDDEN_EXTRACTION_PROMISES: ReadonlyArray<{
  pattern: RegExp;
  label: string;
}> = [
  { pattern: /\bExtract text\b/i, label: "Extract text" },
  { pattern: /\bRun OCR\b/i, label: "Run OCR" },
  { pattern: /\bOCR this\b/i, label: "OCR this" },
  { pattern: /\bTranscribe (?:audio|video)\b/i, label: "Transcribe audio/video" },
  { pattern: /\bGenerate transcript\b/i, label: "Generate transcript" },
  { pattern: /\bRun (?:OCR|transcription)\b/i, label: "Run extraction" },
];

/**
 * Phrases that overclaim legal / authenticity / admissibility. These
 * are the long-standing PROOVRA vocabulary contracts; this suite
 * extends them to every G5 surface.
 */
const FORBIDDEN_LEGAL_OVERCLAIMS: ReadonlyArray<RegExp> = [
  /\btampered?\b/i,
  /\btamper-?proof\b/i,
  /\bauthentic\b/i,
  /\badmissible\b/i,
  /\bcourt-?ready\b/i,
  /\bforensic\s+proof\b/i,
];

/**
 * The bounded set of files that contain PROOVRA's canonical
 * anti-overclaim copy — i.e. the strings the product shows to
 * operators saying "this is NOT proof of authenticity / NOT
 * admissible / NOT court-ready". These intentional denials must
 * keep the banned words verbatim so the disclaimer reads correctly.
 *
 * Adding a NEW file here requires reviewer sign-off: the burden of
 * proof is on the author to show that EVERY occurrence in the file
 * is part of an explicit anti-overclaim denial, not a positive
 * claim.
 */
const LEGAL_DISCLAIMER_ALLOWLIST = new Set<string>([
  "app/verify/[token]/page.tsx",
  "components/landing-body.tsx",
  "components/reports-experience/ReportsIndex.tsx",
  "lib/platform-context/workflowHelp.ts",
  // Committed compiled output of workflowHelp.ts. The .ts source above
  // is canonical; this .js artifact must remain in sync (existing
  // pattern in apps/web for browser-runtime files — see the
  // `/* eslint-env browser */` shims in lib/api.js, lib/uploads/*.js,
  // capture/_lib/file-utils.js etc.). The walker picks up both .ts and
  // .js extensions, so both siblings must be allowlisted or the
  // anti-overclaim disclaimer copy trips the pin.
  "lib/platform-context/workflowHelp.js",
]);

// Comment-stripping helper. Removes // line comments and /* block */
// comments so source-contract assertions don't trip on docstrings that
// MENTION a forbidden phrase by name to forbid it.
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source[i] === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (source[i] === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/"))
        i++;
      i += 2;
      continue;
    }
    out += source[i];
    i++;
  }
  return out;
}

describe("Phase G5.1 — Honest-MI UI honesty contract", () => {
  it("no operator-facing string promises OCR / transcript extraction", () => {
    const files = walk(WEB_ROOT);
    const offenders: Array<{
      file: string;
      line: number;
      phrase: string;
      excerpt: string;
    }> = [];
    for (const f of files) {
      const raw = readFileSync(f, "utf8");
      const stripped = stripComments(raw);
      const lines = stripped.split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const { pattern, label } of FORBIDDEN_EXTRACTION_PROMISES) {
          if (pattern.test(lines[i])) {
            offenders.push({
              file: relative(WEB_ROOT, f).replace(/\\/g, "/"),
              line: i + 1,
              phrase: label,
              excerpt: lines[i].trim().slice(0, 120),
            });
          }
        }
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        "Forbidden OCR/transcript extraction promises found:\n" +
          offenders
            .map(
              (o) =>
                `  ${o.file}:${o.line} — "${o.phrase}" — ${o.excerpt}`,
            )
            .join("\n"),
      );
    }
    expect(offenders).toEqual([]);
  });

  it("legal overclaim vocabulary stays absent from apps/web (outside disclaimer allowlist)", () => {
    const files = walk(WEB_ROOT);
    const offenders: Array<{ file: string; line: number; phrase: string }> = [];
    for (const f of files) {
      const rel = relative(WEB_ROOT, f).replace(/\\/g, "/");
      // Anti-overclaim disclaimer copy legitimately mentions the
      // banned words to explicitly REFUSE the claim. See
      // LEGAL_DISCLAIMER_ALLOWLIST.
      if (LEGAL_DISCLAIMER_ALLOWLIST.has(rel)) continue;
      const raw = readFileSync(f, "utf8");
      const stripped = stripComments(raw);
      const lines = stripped.split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const pattern of FORBIDDEN_LEGAL_OVERCLAIMS) {
          if (pattern.test(lines[i])) {
            offenders.push({
              file: rel,
              line: i + 1,
              phrase: pattern.source,
            });
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("useMediaIntelligence hook is consumed by the bounded set of files only", () => {
    const files = walk(WEB_ROOT);
    const callers: string[] = [];
    for (const f of files) {
      const raw = readFileSync(f, "utf8");
      // Match an import or use of the hook.
      if (/useMediaIntelligence\b/.test(raw)) {
        callers.push(relative(WEB_ROOT, f).replace(/\\/g, "/"));
      }
    }
    // Allow the hook itself + the MediaIntelligencePanel + any
    // bounded helpers. A new caller appearing here is a signal that
    // a future PR is widening the MI surface; the reviewer should
    // re-read honest-mi-decision.md before approving.
    const allow = new Set([
      "components/media-intelligence/MediaIntelligencePanel.tsx",
      "lib/media-intelligence/useMediaIntelligence.ts",
    ]);
    const offenders = callers.filter((c) => !allow.has(c));
    if (offenders.length > 0) {
      throw new Error(
        "Unexpected useMediaIntelligence callers (re-read honest-mi-decision.md):\n" +
          offenders.map((o) => `  ${o}`).join("\n"),
      );
    }
    expect(offenders).toEqual([]);
  });

  it("the MediaIntelligencePanel is actually mounted on evidence detail", () => {
    // Phase 12 Point 4 — `honest-mi-decision.md` records this panel as
    // the evidence-detail operator surface, but it had drifted to zero
    // importers (documented-as-shipped, unreachable in product). This
    // guard makes the claim falsifiable: the panel must have a real
    // mount, and it must be handed a server-projected workspace id
    // rather than a client-derived one.
    const tab = readFileSync(
      resolve(
        WEB_ROOT,
        "app/(app)/evidence/[id]/_tabs/EvidenceTechnicalAppendixTab.tsx",
      ),
      "utf8",
    );
    expect(tab).toMatch(
      /import\s+MediaIntelligencePanel\s+from\s+"[^"]*components\/media-intelligence\/MediaIntelligencePanel"/,
    );
    expect(tab).toMatch(/<MediaIntelligencePanel[\s\S]{0,200}teamId=/);
    expect(tab).toMatch(/workspace\.reviewWorkflow\?\.teamId/);
  });

  it("honest-mi-decision.md is present and pins the B-prime decision", () => {
    const doc = readFileSync(
      fileURLToPath(
        new URL(
          "../../../docs/architecture/honest-mi-decision.md",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(doc).toContain("Decision **B-prime**");
    expect(doc).toContain(
      "does not extract OCR text or audio/video transcripts",
    );
    expect(doc).toContain("UI honesty contract");
  });
});
