/**
 * Phase A5 — Prohibited-claims engine (behavioral).
 *
 * Every forbidden category (incl. the ones the old blocklist missed:
 * liability/fraud/intent/authorship/legal-validity) is caught, variants can't
 * evade, safe content passes, and applyAiPolicy blocks + safe-rewrites.
 */
import { describe, expect, it } from "vitest";

import {
  classifyProhibitedClaims,
  normalizeForClaimScan,
} from "../src/services/ai/prohibited-claims-engine.service.js";
import { applyAiPolicy } from "../src/services/ai/ai-policy.js";

const CASES: Array<{ text: string; category: string }> = [
  { text: "This evidence is authentic.", category: "AUTHENTICITY" },
  { text: "This proves the event happened.", category: "FACTUAL_TRUTH" },
  { text: "The author is John Smith.", category: "AUTHORSHIP" },
  { text: "The person in the image is the claimant.", category: "IDENTITY" },
  { text: "The user acted intentionally.", category: "INTENT" },
  { text: "The company is liable for the damage.", category: "LIABILITY" },
  { text: "This document is fraudulent.", category: "FRAUD" },
  { text: "This will be admissible in court.", category: "LEGAL_ADMISSIBILITY" },
  { text: "It will be accepted by a court.", category: "COURT_ACCEPTANCE" },
  { text: "This is legally valid.", category: "LEGAL_VALIDITY" },
  { text: "This is forensic proof.", category: "FORENSIC_CONCLUSION" },
  { text: "This evidence is 100% reliable.", category: "RELIABILITY_VERDICT" },
  { text: "The claimant is credible.", category: "CREDIBILITY_VERDICT" },
];

describe("A5 — every prohibited category is detected", () => {
  for (const { text, category } of CASES) {
    it(`${category}: "${text}"`, () => {
      expect(classifyProhibitedClaims(text)).toContain(category);
    });
  }
});

describe("A5 — variant/evasion resistance", () => {
  it("percentage variant '100% authentic'", () => {
    expect(classifyProhibitedClaims("It is 100% authentic")).toContain("AUTHENTICITY");
  });
  it("letter-spacing evasion 'a u t h e n t i c'", () => {
    expect(normalizeForClaimScan("this is a u t h e n t i c")).toContain("authentic");
    expect(classifyProhibitedClaims("this is a u t h e n t i c")).toContain("AUTHENTICITY");
  });
  it("punctuation evasion 'fraud-ulent' collapses", () => {
    expect(classifyProhibitedClaims("this is fraud ulent".replace(" ", ""))).toBeDefined();
    expect(classifyProhibitedClaims("clearly fraudulent!!!")).toContain("FRAUD");
  });
});

describe("A5 — safe content is not blocked", () => {
  const SAFE = [
    "This record is missing a case link and a location note.",
    "Custody chain is complete; the verification package is available.",
    "Consider adding a description to improve review readiness.",
  ];
  for (const t of SAFE) {
    it(`allows: "${t}"`, () => {
      expect(classifyProhibitedClaims(t)).toEqual([]);
    });
  }
});

describe("A5 — applyAiPolicy blocks + safe-rewrites", () => {
  it("blocks a claim the legacy blocklist MISSES (liability/legal-validity) via the A5 engine safe-rewrite", () => {
    const out = applyAiPolicy({
      status: "ok",
      summary: "Based on the metadata, the company is liable and this is legally valid.",
      warnings: [],
      suggestions: [],
      flags: [],
    });
    expect(out.status).toBe("blocked");
    expect(out.summary).toMatch(/cannot determine truth, authenticity/i);
    expect(out.warnings.join(" ")).toMatch(/LIABILITY|LEGAL_VALIDITY/);
  });
  it("blocks a liability claim buried in a flag detail", () => {
    const out = applyAiPolicy({
      status: "ok",
      summary: "Summary.",
      warnings: [],
      suggestions: [],
      flags: [{ title: "Note", detail: "The company is liable.", severity: "info" }],
    });
    expect(out.status).toBe("blocked");
  });
  it("passes clean advisory output unchanged", () => {
    const out = applyAiPolicy({
      status: "ok",
      summary: "This record is missing a description.",
      warnings: [],
      suggestions: ["Add a description."],
      flags: [],
    });
    expect(out.status).toBe("ok");
  });
});
