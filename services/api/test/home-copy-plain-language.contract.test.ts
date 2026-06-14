/**
 * Phase HOME-COPY — plain-language regression lock.
 *
 * PROOVRA's Home dashboard is consumed by individuals, journalists,
 * insurers, small businesses, and enterprise — not just security/
 * forensic operators. The previous labels leaned heavily on:
 *
 *   • forensic jargon       ("Operational queue", "Trust state")
 *   • implied legal claims  ("Trusted timestamps", "Integrity issues")
 *   • enterprise-speak      ("Workspace priorities", "Records reported")
 *
 * This pass replaces them with plain-English equivalents that read
 * the same way to a lawyer, a journalist, and a small-business owner
 * — and that DO NOT imply authenticity, factual truth, admissibility,
 * or court acceptance.
 *
 * The test locks the new strings AND asserts the old strings are
 * gone, so future copy edits can't quietly regress.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

function src(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

const HOME_SECTIONS = src(
  "apps/web/components/home-experience/HomeSections.tsx",
);
const HOME_DASH = src(
  "apps/web/components/home-experience/HomeDashboardSections.tsx",
);
const VM = src("apps/web/components/home-experience/home-view-model.ts");

describe("Phase HOME-COPY — Operational queue → Action needed", () => {
  it("the Operational Queue card title reads 'Action needed' (plain-English)", () => {
    expect(HOME_SECTIONS).toMatch(/Action needed · \$\{items\.length\}/);
    expect(HOME_SECTIONS).toMatch(/: "Action needed"/);
  });

  it("the legacy 'Operational queue · N' header text is gone from the title", () => {
    expect(HOME_SECTIONS).not.toMatch(
      /\{items\.length > 0 \? `Operational queue · \$\{items\.length\}`/,
    );
  });
});

describe("Phase HOME-COPY — Verification health → Public verification links", () => {
  it("the SectionCard title reads 'Public verification links'", () => {
    expect(HOME_SECTIONS).toMatch(
      /SectionCard title="Public verification links" testId="verification-health"/,
    );
  });

  it("the legacy 'Verification health' title is gone", () => {
    expect(HOME_SECTIONS).not.toMatch(
      /SectionCard title="Verification health"/,
    );
  });
});

describe("Phase HOME-COPY — Trusted timestamps → Time-stamp proof", () => {
  it("the TSA row label avoids implying legal 'trust' as fact", () => {
    expect(HOME_SECTIONS).toMatch(/label: "Time-stamp proof \(TSA\)"/);
  });

  it("the legacy 'Trusted timestamps (TSA)' label is gone", () => {
    expect(HOME_SECTIONS).not.toMatch(/label: "Trusted timestamps \(TSA\)"/);
  });
});

describe("Phase HOME-COPY — Trust state → Verification summary", () => {
  it("the Trust State card now reads 'Verification summary'", () => {
    expect(HOME_SECTIONS).toMatch(
      /SectionCard title="Verification summary" testId="trust-state"/,
    );
  });

  it("the legacy 'Trust state' title is gone", () => {
    expect(HOME_SECTIONS).not.toMatch(/SectionCard title="Trust state"/);
  });
});

describe("Phase HOME-COPY — Public verification 'live/suspended' wording", () => {
  it("'Public verification live' is now 'Public verification links live'", () => {
    expect(HOME_SECTIONS).toMatch(
      /label: "Public verification links live"/,
    );
  });

  it("'Public verification suspended' is now 'Public verification links paused' (less punitive)", () => {
    expect(HOME_SECTIONS).toMatch(
      /label: "Public verification links paused"/,
    );
  });

  it("the legacy bare 'Public verification live'/'suspended' labels are gone", () => {
    expect(HOME_SECTIONS).not.toMatch(
      /label: "Public verification live"/,
    );
    expect(HOME_SECTIONS).not.toMatch(
      /label: "Public verification suspended"/,
    );
  });
});

describe("Phase HOME-COPY — Workspace Health row labels", () => {
  it("'Records reported' → 'Records with a report' (key unchanged)", () => {
    expect(VM).toMatch(
      /\{\s*key:\s*"complete"\s*,\s*label:\s*"Records with a report"/,
    );
    expect(VM).not.toMatch(
      /\{\s*key:\s*"complete"\s*,\s*label:\s*"Records reported"/,
    );
  });

  it("'Operational issues' → 'Records with delivery issues' (key unchanged)", () => {
    expect(VM).toMatch(
      /\{\s*key:\s*"operational"\s*,\s*label:\s*"Records with delivery issues"/,
    );
    expect(VM).not.toMatch(
      /\{\s*key:\s*"operational"\s*,\s*label:\s*"Operational issues"/,
    );
  });

  it("'Integrity issues' → 'Records flagged for review' (PROOVRA does not declare integrity as fact)", () => {
    expect(VM).toMatch(
      /\{\s*key:\s*"integrity"\s*,\s*label:\s*"Records flagged for review"/,
    );
    expect(VM).not.toMatch(
      /\{\s*key:\s*"integrity"\s*,\s*label:\s*"Integrity issues"/,
    );
  });
});

describe("Phase HOME-COPY — header CTA + Workspace Priorities title", () => {
  it("the header CTA is 'All evidence' → /evidence", () => {
    expect(HOME_DASH).toMatch(
      /\{\s*label:\s*"All evidence"\s*,\s*href:\s*"\/evidence"\s*\}/,
    );
  });

  it("the legacy 'Evidence Queue' header label is gone", () => {
    expect(HOME_DASH).not.toMatch(
      /\{\s*label:\s*"Evidence Queue"\s*,\s*href:\s*"\/evidence"\s*\}/,
    );
  });

  it("the priorities card heading reads 'What needs attention' (plain)", () => {
    expect(HOME_DASH).toMatch(
      /<h2 style=\{homeCardTitleStyle\}>What needs attention<\/h2>/,
    );
  });

  it("the legacy 'Workspace priorities' h2 is gone", () => {
    expect(HOME_DASH).not.toMatch(
      /<h2 style=\{homeCardTitleStyle\}>Workspace priorities<\/h2>/,
    );
  });
});

describe("Phase HOME-COPY — anti-legal-overclaim guard", () => {
  // Words PROOVRA must NOT use as factual labels in user-visible Home
  // surfaces, per the principle "verifies integrity and preservation
  // signals; does NOT determine factual truth / authorship / identity
  // / legal admissibility / evidentiary weight." Each must NOT appear
  // as a JSX text node or label literal in HomeSections / HomeDash.
  // (Substring-in-source check; comments are excluded by being on
  // their own lines that don't survive the regex form.)
  const banned = [
    "Authentic",
    "Authenticated",
    "Court ready",
    "Court-ready",
    "Legally ready",
    "Legally admissible",
    "Proven authentic",
    "Tamper-proof",
    "Tamper proof",
  ];
  for (const word of banned) {
    it(`HomeSections never renders the banned overclaim word: "${word}"`, () => {
      // Allow the word to appear as part of a longer URL/identifier
      // (data-* attributes) but not as a JSX text/label literal.
      const pattern = new RegExp(
        `(?:label|title):\\s*"[^"]*${word}[^"]*"|>${word}[^<]*<`,
        "i",
      );
      expect(HOME_SECTIONS).not.toMatch(pattern);
      expect(HOME_DASH).not.toMatch(pattern);
    });
  }
});
