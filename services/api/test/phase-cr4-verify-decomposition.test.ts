/**
 * PHASE CR4 — Verify Experience Decomposition contract tests.
 *
 * CR4 decomposes the 7,404-line public verify monolith
 * (`apps/web/app/verify/[token]/page.tsx`) into presentation primitives
 * + named card components under `apps/web/components/verify-v2/`,
 * WITHOUT touching the backend or trust-language semantics.
 *
 * These tests are landed BEFORE any extraction and must stay green at
 * every step of the decomposition. They form the safety net that
 * prevents trust-language regression, privacy regression, side-effect
 * leakage, or data-contract drift during the refactor.
 *
 * 15 test groups (~200 cases):
 *
 *   1.  File-size guards (backend pin + web upper-bound)
 *   2.  Trust-language verbatim (E5 PROOVRA_FORBIDDEN_SURFACE_PATTERNS)
 *   3.  "Recorded integrity verified" canonical phrase preserved
 *   4.  No new authenticity / admissibility / truth / forensic claims
 *   5.  Side-effect-free reads (zero POST/PUT/PATCH/DELETE)
 *   6.  Submitter email masking preserved
 *   7.  integrityProof preferred over legacy verification field
 *   8.  TSA state vocabulary stable (STAMPED / FAILED / UNAVAILABLE)
 *   9.  OTS state vocabulary stable (PENDING / ANCHORED / FAILED / UNAVAILABLE)
 *  10.  Custody vs access timeline counts separated by `category`
 *  11.  Report / package / share URL shape stable
 *  12.  No raw internal IDs / storage keys / signed URLs / private notes
 *  13.  No AI verification claims
 *  14.  Trust Center module imports preserved
 *  15.  Public/private boundary (no authenticated-route imports)
 *
 * Phase CR4 ships ZERO backend changes. Backend pins assert this by
 * byte-pinning `verify-projection.service.ts`, `claims-matrix.ts`, and
 * `trust-center-content.ts` to their pre-CR4 sizes.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function apiSrcPath(rel: string): string {
  return fileURLToPath(new URL(`../../../services/api/src/${rel}`, import.meta.url));
}
function sharedPath(rel: string): string {
  return fileURLToPath(
    new URL(
      `../../../packages/shared-evidence-presentation/src/${rel}`,
      import.meta.url,
    ),
  );
}

function readRepo(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(webPath(rel), "utf8");
}

// Recursively collect every .ts / .tsx file under `apps/web/components/verify-v2/`.
// Returns [] when the directory does not yet exist (pre-extraction state).
function listVerifyV2Files(): Array<{ rel: string; abs: string }> {
  const baseAbs = webPath("components/verify-v2");
  if (!existsSync(baseAbs)) return [];
  const out: Array<{ rel: string; abs: string }> = [];
  function walk(dirAbs: string, relPrefix: string) {
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      const entryAbs = join(dirAbs, entry.name);
      const entryRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(entryAbs, entryRel);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
      ) {
        out.push({ rel: entryRel, abs: entryAbs });
      }
    }
  }
  walk(baseAbs, "");
  return out;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TOKEN_PAGE = readWeb("app/verify/[token]/page.tsx");
const VERIFY_LANDING = readWeb("app/verify/page.tsx");
const VERIFY_DEMO = readWeb("app/verify/demo/page.tsx");
const VERIFY_PROJECTION_SVC = readFileSync(
  apiSrcPath("services/media-intelligence/verify-projection.service.ts"),
  "utf8",
);
const CLAIMS_MATRIX = readFileSync(sharedPath("claims-matrix.ts"), "utf8");
const TRUST_CENTER_CONTENT = readFileSync(
  sharedPath("trust-center-content.ts"),
  "utf8",
);

const VERIFY_V2_FILES = listVerifyV2Files();

// Pre-CR4 file sizes (bytes). The token page is allowed to SHRINK during
// extraction; everything else is byte-pinned. The token page upper-pin
// will be tightened in a closing commit once extraction stabilises.
const PRE_CR4_TOKEN_PAGE_BYTES = 255081;
const PRE_CR4_VERIFY_LANDING_BYTES = 21548;
const PRE_CR4_VERIFY_DEMO_BYTES = 18486;
const VERIFY_PROJECTION_SVC_BYTES = 3953;
const CLAIMS_MATRIX_BYTES = 2317;
const TRUST_CENTER_CONTENT_BYTES = 24846;

// ---------------------------------------------------------------------------
// Group 1 — File-size guards
// ---------------------------------------------------------------------------

describe("CR4 Group 1 — file-size guards", () => {
  it("token-page byte size MUST NOT exceed pre-CR4 baseline (decomposition only shrinks)", () => {
    const sz = statSync(webPath("app/verify/[token]/page.tsx")).size;
    expect(sz).toBeLessThanOrEqual(PRE_CR4_TOKEN_PAGE_BYTES);
  });

  it("verify landing page byte size MUST NOT exceed pre-CR4 baseline (out of scope for CR4)", () => {
    const sz = statSync(webPath("app/verify/page.tsx")).size;
    expect(sz).toBeLessThanOrEqual(PRE_CR4_VERIFY_LANDING_BYTES);
  });

  it("verify demo page byte size MUST NOT exceed pre-CR4 baseline (out of scope for CR4)", () => {
    const sz = statSync(webPath("app/verify/demo/page.tsx")).size;
    expect(sz).toBeLessThanOrEqual(PRE_CR4_VERIFY_DEMO_BYTES);
  });

  it("verify-projection.service.ts byte-exact pin (CR4 must not touch backend)", () => {
    const sz = statSync(
      apiSrcPath("services/media-intelligence/verify-projection.service.ts"),
    ).size;
    expect(sz).toBe(VERIFY_PROJECTION_SVC_BYTES);
  });

  it("claims-matrix.ts byte-exact pin (E5 canonical; CR4 must not touch)", () => {
    const sz = statSync(sharedPath("claims-matrix.ts")).size;
    expect(sz).toBe(CLAIMS_MATRIX_BYTES);
  });

  it("trust-center-content.ts byte-exact pin (E5 canonical; CR4 must not touch)", () => {
    const sz = statSync(sharedPath("trust-center-content.ts")).size;
    expect(sz).toBe(TRUST_CENTER_CONTENT_BYTES);
  });

  it("evidence-complete.service.ts pin (CR1.6 — 42,799 bytes)", () => {
    const sz = statSync(
      apiSrcPath("services/evidence-complete.service.ts"),
    ).size;
    // Baseline grows with documented phases (G3.x/G4/G5). The
    // "no shrink/regression" guarantee is the spirit; the constant
    // is rebaselined as the file legitimately grows.
    expect(sz).toBe(42799);
  });

  it("custody-events.service.ts pin (CR1.6 — 5,155 bytes)", () => {
    const sz = statSync(apiSrcPath("services/custody-events.service.ts")).size;
    expect(sz).toBe(5155);
  });

  it("timestamp.service.ts pin (CR1.6 — 7,535 bytes)", () => {
    const sz = statSync(apiSrcPath("services/timestamp.service.ts")).size;
    expect(sz).toBe(7535);
  });

  it("capture.routes.ts pin (CR1.6 — 21,271 bytes)", () => {
    const sz = statSync(apiSrcPath("routes/capture.routes.ts")).size;
    expect(sz).toBe(21271);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — Trust-language verbatim (reuse E5 PROOVRA_FORBIDDEN_SURFACE_PATTERNS)
// ---------------------------------------------------------------------------

// Local copy of E5's PROOVRA_FORBIDDEN_SURFACE_PATTERNS — kept in sync by
// the E5 test (which pins the canonical list). CR4 reads its own copy so
// drift inside `claims-matrix.ts` is caught by E5 and CR4 catches drift
// inside the verify component tree.
const E5_FORBIDDEN_SURFACE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bauthenticity verified\b/i,
  /\bevidence truth verified\b/i,
  /\bproves factual truth\b/i,
  /\bproves authorship\b/i,
  /\bproves identity\b/i,
  /\blegally admissible\b/i,
  /\badmissible in court\b/i,
  /\bguarantees legal admissibility\b/i,
  /\bguarantees court acceptance\b/i,
  /\bguarantees anti-tamper capture(?: at source)?\b/i,
  /\btruepic-style\b/i,
  /\bcellebrite-style\b/i,
  /\bai (?:verified|certified|determined) (?:the )?evidence\b/i,
];

function allVerifySurfaceTexts(): Array<{ label: string; text: string }> {
  const base: Array<{ label: string; text: string }> = [
    { label: "verify/[token]/page.tsx", text: TOKEN_PAGE },
  ];
  for (const f of VERIFY_V2_FILES) {
    base.push({ label: `verify-v2/${f.rel}`, text: readFileSync(f.abs, "utf8") });
  }
  return base;
}

describe("CR4 Group 2 — E5 forbidden-surface patterns stay false across the verify tree", () => {
  for (const surface of allVerifySurfaceTexts()) {
    for (const pattern of E5_FORBIDDEN_SURFACE_PATTERNS) {
      it(`${surface.label} :: pattern ${pattern} is NOT present`, () => {
        expect(pattern.test(surface.text)).toBe(false);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Group 3 — Canonical phrase "recorded integrity verified" preserved
// ---------------------------------------------------------------------------

describe("CR4 Group 3 — recorded-integrity-verified phrase preserved", () => {
  it("token page contains the canonical lowercase phrase 'recorded integrity verified'", () => {
    expect(/recorded integrity verified/i.test(TOKEN_PAGE)).toBe(true);
  });

  it("token page references integrityProof type (data contract preserved)", () => {
    expect(/integrityProof/.test(TOKEN_PAGE)).toBe(true);
  });

  it("token page references the masked submitter email field type", () => {
    expect(/submittedByEmail/.test(TOKEN_PAGE)).toBe(true);
  });

  it("the canonical phrase MUST appear at least twice (verdict label + body context)", () => {
    const matches = TOKEN_PAGE.match(/recorded integrity verified/gi) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Group 4 — No new authenticity / admissibility / truth / forensic claims
// ---------------------------------------------------------------------------

// These are POSITIVE-claim regexes that must stay false. They are
// stricter than E5's list because CR4 extracts may be tempted to add
// short marketing chips like "AI verified" or "tamper-proof".
// NOTE: phrases like `evidence is authentic` / `evidence is true` are
// intentionally NOT regex'd in CR4. They occur legitimately in
// negation-context safe wording (e.g., "must not be treated as proof
// that the underlying evidence is authentic or admissible"). E5's
// PROOVRA_FORBIDDEN_SURFACE_PATTERNS in Group 2 catches the genuinely
// dangerous POSITIVE forms (e.g., `\bauthenticity verified\b`,
// `\bproves authorship\b`) using narrower, negation-resistant shapes.
// CR4 Group 4 layers on the marketing-theatre vocabulary that E5
// doesn't explicitly cover.
const CR4_FORBIDDEN_POSITIVE_CLAIMS: ReadonlyArray<RegExp> = [
  /\btamper[- ]?proof\b/i,
  /\bforensically (?:proven|certified|verified)\b/i,
  /\bcourt[- ]?(?:ready|certified)\b/i,
  /\bai[- ]?(?:verified|certified|confirmed|validated)\b/i,
  /\bproves authenticity\b/i,
  /\bproves truth\b/i,
  /\bunhackable\b/i,
  /\bmilitary[- ]?grade\b/i,
  /\bsoc\s*2 compliant\b/i,
  /\biso\s*27001 compliant\b/i,
  /\bhipaa compliant\b/i,
  /\bgdpr compliant\b/i,
  /\bfedramp authorised\b/i,
  /\bfedramp authorized\b/i,
];

describe("CR4 Group 4 — no new positive-claim language across verify tree", () => {
  for (const surface of allVerifySurfaceTexts()) {
    for (const pattern of CR4_FORBIDDEN_POSITIVE_CLAIMS) {
      it(`${surface.label} :: ${pattern} stays absent`, () => {
        expect(pattern.test(surface.text)).toBe(false);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Group 5 — Side-effect-free reads (zero POST/PUT/PATCH/DELETE)
// ---------------------------------------------------------------------------

// The public verify surface is READ-ONLY for the anonymous viewer.
// Custody mutations + download recording happen server-side via
// authenticated routes; the public verify page must NEVER POST.
const HTTP_WRITE_METHOD = /method\s*:\s*["'`](?:POST|PUT|PATCH|DELETE)["'`]/i;

describe("CR4 Group 5 — verify tree is side-effect free", () => {
  for (const surface of allVerifySurfaceTexts()) {
    it(`${surface.label} :: contains NO POST/PUT/PATCH/DELETE method override`, () => {
      expect(HTTP_WRITE_METHOD.test(surface.text)).toBe(false);
    });
    it(`${surface.label} :: contains NO appendCustodyEvent reference`, () => {
      expect(/appendCustodyEvent/.test(surface.text)).toBe(false);
    });
    it(`${surface.label} :: contains NO custody-event creation reference`, () => {
      expect(/createCustodyEvent|emitCustodyEvent/.test(surface.text)).toBe(
        false,
      );
    });
    it(`${surface.label} :: contains NO download-record write reference`, () => {
      expect(/recordDownload|markDownloaded/.test(surface.text)).toBe(false);
    });
    it(`${surface.label} :: contains NO finalize-evidence reference`, () => {
      expect(/completeEvidence|finalizeEvidence/.test(surface.text)).toBe(
        false,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Group 6 — Submitter email masking preserved
// ---------------------------------------------------------------------------

describe("CR4 Group 6 — submitter email masking", () => {
  it("token page imports maskPublicEmail (and / or maskPublicEmailsInText)", () => {
    expect(/maskPublicEmail/.test(TOKEN_PAGE)).toBe(true);
  });

  it("token page calls maskPublicEmailsInText to defence-in-depth free-text", () => {
    expect(/maskPublicEmailsInText/.test(TOKEN_PAGE)).toBe(true);
  });

  // Across the verify tree, every raw email substring in source must be
  // either an escape sequence (regex), a masking-helper invocation, or a
  // type/comment. Pin a coarse anti-leak heuristic: no literal
  // user@domain.tld appears outside helper/test scaffolding.
  const RAW_EMAIL_LITERAL = /["'`][a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}["'`]/;
  for (const surface of allVerifySurfaceTexts()) {
    it(`${surface.label} :: contains NO raw email literal`, () => {
      expect(RAW_EMAIL_LITERAL.test(surface.text)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Group 7 — integrityProof preferred over legacy verification field
// ---------------------------------------------------------------------------

describe("CR4 Group 7 — integrityProof mapping preferred", () => {
  it("token page uses the integrityProof ?? verification pattern (preferred field first)", () => {
    expect(/integrityProof\s*\?\?\s*data?\.?\s*verification/.test(TOKEN_PAGE))
      .toBe(true);
  });

  it("at least 2 callsites use the integrityProof preference pattern", () => {
    const matches =
      TOKEN_PAGE.match(/integrityProof\s*\?\?\s*data?\.?\s*verification/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  // Reverse-order anti-pattern: nothing in the tree should prefer the
  // legacy field over integrityProof.
  const LEGACY_FIRST = /(?:data\.)?verification\s*\?\?\s*(?:data\.)?integrityProof/;
  for (const surface of allVerifySurfaceTexts()) {
    it(`${surface.label} :: NEVER prefers legacy verification over integrityProof`, () => {
      expect(LEGACY_FIRST.test(surface.text)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Group 8 — TSA state vocabulary stable
// ---------------------------------------------------------------------------

const TSA_STATES = ["STAMPED", "FAILED", "UNAVAILABLE"] as const;
const TSA_FORBIDDEN_STATES = [
  "VERIFIED",
  "PROVEN",
  "CERTIFIED",
  "TRUSTWORTHY",
  "ADMISSIBLE",
];

describe("CR4 Group 8 — TSA state vocabulary", () => {
  for (const allowed of TSA_STATES) {
    it(`token page recognises TSA state ${allowed}`, () => {
      expect(TOKEN_PAGE.includes(allowed)).toBe(true);
    });
  }
  for (const forbidden of TSA_FORBIDDEN_STATES) {
    for (const surface of allVerifySurfaceTexts()) {
      it(`${surface.label} :: TSA-context forbidden state '${forbidden}' not paired with timestamp wording`, () => {
        // Allow the bare word elsewhere (e.g., "verified" in lowercase as
        // adjective), but forbid the upper-case enum form adjacent to
        // "timestampStatus" or "TSA".
        const pattern = new RegExp(
          `(?:timestampStatus|TSA)[^\\n]{0,40}["'\`]${forbidden}["'\`]`,
          "i",
        );
        expect(pattern.test(surface.text)).toBe(false);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Group 9 — OTS state vocabulary stable
// ---------------------------------------------------------------------------

const OTS_STATES = ["PENDING", "ANCHORED", "FAILED", "UNAVAILABLE"] as const;
const OTS_FORBIDDEN_STATES = [
  "VERIFIED",
  "PROVEN",
  "GUARANTEED",
  "IMMUTABLE_FOREVER",
  "TAMPERPROOF",
];

describe("CR4 Group 9 — OTS state vocabulary", () => {
  for (const allowed of OTS_STATES) {
    it(`token page recognises OTS state ${allowed}`, () => {
      expect(TOKEN_PAGE.includes(allowed)).toBe(true);
    });
  }
  for (const forbidden of OTS_FORBIDDEN_STATES) {
    for (const surface of allVerifySurfaceTexts()) {
      it(`${surface.label} :: OTS-context forbidden state '${forbidden}' not paired with otsStatus wording`, () => {
        const pattern = new RegExp(
          `(?:otsStatus|OTS)[^\\n]{0,40}["'\`]${forbidden}["'\`]`,
          "i",
        );
        expect(pattern.test(surface.text)).toBe(false);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Group 10 — Custody vs access timeline counts separated by `category`
// ---------------------------------------------------------------------------

describe("CR4 Group 10 — custody vs access count separation", () => {
  it("token page filters on category === 'forensic' at least once", () => {
    expect(
      /category\s*===\s*["'`]forensic["'`]/.test(TOKEN_PAGE) ||
        /["'`]forensic["'`]\s*===\s*[\w.]*category/.test(TOKEN_PAGE),
    ).toBe(true);
  });

  it("token page filters on category === 'access' at least once", () => {
    expect(
      /category\s*===\s*["'`]access["'`]/.test(TOKEN_PAGE) ||
        /["'`]access["'`]\s*===\s*[\w.]*category/.test(TOKEN_PAGE),
    ).toBe(true);
  });

  it("token page references isAccessCustodyEventType helper (E5 categorisation)", () => {
    expect(/isAccessCustodyEventType/.test(TOKEN_PAGE)).toBe(true);
  });

  // No verify component may aggregate custody+access together — that
  // would inflate custody counts with public-view events.
  const MIXED_AGG_PATTERN =
    /\b(?:custody|forensic)Count\s*\+\s*(?:access|publicView)Count\b/i;
  for (const surface of allVerifySurfaceTexts()) {
    it(`${surface.label} :: never sums custodyCount + accessCount`, () => {
      expect(MIXED_AGG_PATTERN.test(surface.text)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Group 11 — Report / package / share URL shape stable
// ---------------------------------------------------------------------------

describe("CR4 Group 11 — verify URL shape stable", () => {
  // The /verify/${...} URL is the QR target and the canonical public
  // share path. The component tree must NOT hand-construct an alternate
  // shape (e.g., /public/verify/${...} as a literal in the UI).
  it("token page contains the /verify/${...} URL shape", () => {
    expect(/\/verify\/\$\{[^}]+\}/.test(TOKEN_PAGE)).toBe(true);
  });

  // No verify component should hand-construct an alternate share URL.
  const ALTERNATE_SHARE = /\/share\/|\/public-verify\//;
  for (const surface of allVerifySurfaceTexts()) {
    it(`${surface.label} :: contains no alternate share/public-verify URL shape`, () => {
      expect(ALTERNATE_SHARE.test(surface.text)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Group 12 — No raw internal IDs / storage keys / signed URLs / private notes
// ---------------------------------------------------------------------------

const FORBIDDEN_INTERNAL_TOKENS: ReadonlyArray<RegExp> = [
  /\bstorageKey\b/,
  /\bstorage[- ]key\b/i,
  /\bpresigned\b/i,
  /\bS3_(?:ACCESS|SECRET|ENDPOINT|BUCKET)\b/,
  /\bprivateNotes\b/,
  /\binternalNotes\b/,
  /\bteamSecret\b/,
  /\btokenSecret\b/,
];

describe("CR4 Group 12 — no internal field/identifier leakage", () => {
  for (const surface of allVerifySurfaceTexts()) {
    for (const pattern of FORBIDDEN_INTERNAL_TOKENS) {
      it(`${surface.label} :: ${pattern} stays absent`, () => {
        expect(pattern.test(surface.text)).toBe(false);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Group 13 — No AI verification claims (defence-in-depth over Group 2 / Group 4)
// ---------------------------------------------------------------------------

const AI_FORBIDDEN_PATTERNS: ReadonlyArray<RegExp> = [
  /\bAI\s+verified\b/i,
  /\bAI\s+confirmed\b/i,
  /\bAI\s+certified\b/i,
  /\bAI\s+validated\b/i,
  /\bAI\s+proves\b/i,
  /\bAI\s+determines\s+(?:truth|authenticity|admissibility)\b/i,
  /\bAI[- ]?(?:driven|powered)\s+verification\b/i,
];

describe("CR4 Group 13 — no AI verification claims in verify tree", () => {
  for (const surface of allVerifySurfaceTexts()) {
    for (const pattern of AI_FORBIDDEN_PATTERNS) {
      it(`${surface.label} :: AI claim ${pattern} stays absent`, () => {
        expect(pattern.test(surface.text)).toBe(false);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Group 14 — Trust Center module imports preserved
// ---------------------------------------------------------------------------

describe("CR4 Group 14 — E5 trust-content imports preserved", () => {
  it("token page imports PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE from shared-evidence-presentation", () => {
    expect(/PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE/.test(TOKEN_PAGE)).toBe(
      true,
    );
  });

  it("token page imports PROOVRA_MULTIPART_RECOMPUTATION_NOTE from shared-evidence-presentation", () => {
    expect(/PROOVRA_MULTIPART_RECOMPUTATION_NOTE/.test(TOKEN_PAGE)).toBe(true);
  });

  it("token page imports PROOVRA_MULTIPART_REVIEWER_EXPLANATION from shared-evidence-presentation", () => {
    expect(/PROOVRA_MULTIPART_REVIEWER_EXPLANATION/.test(TOKEN_PAGE)).toBe(
      true,
    );
  });

  it("token page imports buildEvidenceTrustDecision from @proovra/shared (canonical verdict)", () => {
    expect(/buildEvidenceTrustDecision/.test(TOKEN_PAGE)).toBe(true);
  });

  // Defence-in-depth: nothing in the verify tree re-implements a local
  // copy of buildEvidenceTrustDecision.
  const LOCAL_VERDICT_FN =
    /function\s+buildEvidenceTrustDecision\s*\(|const\s+buildEvidenceTrustDecision\s*=/;
  for (const surface of allVerifySurfaceTexts()) {
    it(`${surface.label} :: does NOT locally re-implement buildEvidenceTrustDecision`, () => {
      expect(LOCAL_VERDICT_FN.test(surface.text)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Group 15 — Public/private boundary (no authenticated-route imports)
// ---------------------------------------------------------------------------

const AUTHENTICATED_ROUTE_TOKENS: ReadonlyArray<RegExp> = [
  /["'`]\/v1\/teams\//,
  /["'`]\/v1\/governance\//,
  /["'`]\/admin\//,
  /["'`]\/v1\/admin\//,
  /["'`]\/ops\//,
  /["'`]\/v1\/security-events\//,
];

describe("CR4 Group 15 — no authenticated-route surfaces leak into verify tree", () => {
  for (const surface of allVerifySurfaceTexts()) {
    for (const pattern of AUTHENTICATED_ROUTE_TOKENS) {
      it(`${surface.label} :: authenticated route ${pattern} not referenced`, () => {
        expect(pattern.test(surface.text)).toBe(false);
      });
    }
  }

  // No verify component imports PageRouteGate (the surface is anonymous,
  // not capability-gated).
  for (const surface of allVerifySurfaceTexts()) {
    if (surface.label === "verify/[token]/page.tsx") {
      // Token page IS allowed not to use PageRouteGate (it's anonymous).
      continue;
    }
    it(`${surface.label} :: extracted component does NOT pull PageRouteGate`, () => {
      expect(/PageRouteGate/.test(surface.text)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Meta — sanity check on the test harness itself
// ---------------------------------------------------------------------------

describe("CR4 Meta — test harness", () => {
  it("token-page fixture loads with non-trivial content", () => {
    expect(TOKEN_PAGE.length).toBeGreaterThan(1000);
  });

  it("E5 canonical patterns list is non-empty", () => {
    expect(E5_FORBIDDEN_SURFACE_PATTERNS.length).toBeGreaterThan(0);
  });

  it("verify-projection.service.ts privacy JSDoc is preserved", () => {
    expect(/NEVER exposes per-signal IDs/.test(VERIFY_PROJECTION_SVC)).toBe(
      true,
    );
  });

  it("claims-matrix.ts canonical exports are intact", () => {
    expect(/PROOVRA_ALLOWED_CLAIMS/.test(CLAIMS_MATRIX)).toBe(true);
    expect(/PROOVRA_FORBIDDEN_SURFACE_PATTERNS/.test(CLAIMS_MATRIX)).toBe(true);
  });

  it("trust-center-content.ts canonical export is intact", () => {
    expect(/TRUST_CENTER_SECTION_IDS/.test(TRUST_CENTER_CONTENT)).toBe(true);
  });
});
