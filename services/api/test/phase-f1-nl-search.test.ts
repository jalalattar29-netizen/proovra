/** Phase F1 — deterministic NL search parser (behavioral, trilingual). */
import { describe, expect, it } from "vitest";

import { parseNlSearch } from "../src/services/ai/nl-search-parser.service.js";
import { classifyChatScope } from "../src/services/ai/chat-scope-classifier.service.js";

describe("F1 — state queries (EN/DE/AR)", () => {
  const CASES: Array<[string, string]> = [
    ["Find TSA pending", "TSA_PENDING"],
    ["show evidence with failed verification", "FAILED_VERIFICATION"],
    ["Show pending reviews", "REVIEW_BACKLOG"],
    ["review backlog", "REVIEW_BACKLOG"],
    ["find unsigned packages", "UNSIGNED_PACKAGE"],
    ["show package generation failures", "UNSIGNED_PACKAGE"],
    ["show evidence waiting for report", "WAITING_REPORT"],
    ["find reports generated yesterday", "REPORTS_RECENT"],
    ["Zeige fehlgeschlagene Verifizierung", "FAILED_VERIFICATION"],
    ["Finde Beweise ohne Bericht", "WAITING_REPORT"],
    ["OTS pending", "OTS_PENDING"],
  ];
  for (const [q, expected] of CASES) {
    it(`${q} → ${expected}`, () => {
      const r = parseNlSearch(q);
      expect(r.kind).toBe("STATE_QUERY");
      if (r.kind === "STATE_QUERY") expect(r.query).toBe(expected);
    });
  }
});

describe("F1 — unsupported filters are refused honestly", () => {
  for (const q of ["Find evidence missing GPS", "Show evidence without EXIF", "Find evidence captured from Android", "find evidence by contributor"]) {
    it(`${q} → UNSUPPORTED_FILTER`, () => {
      expect(parseNlSearch(q).kind).toBe("UNSUPPORTED_FILTER");
    });
  }
});

describe("F1 — text search mapping onto existing filters", () => {
  it("extracts evidence type + free text", () => {
    const r = parseNlSearch("find photos of the warehouse door");
    expect(r.kind).toBe("TEXT_SEARCH");
    if (r.kind === "TEXT_SEARCH") {
      expect(r.evidenceTypes).toEqual(["PHOTO"]);
      expect(r.q).toContain("warehouse");
    }
  });
  it("never emits SQL or unvalidated filters (bounded shape only)", () => {
    const r = parseNlSearch("find evidence'; DROP TABLE evidence;--");
    expect(r.kind).toBe("TEXT_SEARCH");
    if (r.kind === "TEXT_SEARCH") expect((r.q ?? "").length).toBeLessThanOrEqual(200);
  });
});

describe("F1 — default-deny boundary applies before parsing", () => {
  it("off-domain queries are refused by the classifier gate", () => {
    expect(classifyChatScope("find me a cheap flight to Rome").refuse).toBe(true);
    expect(classifyChatScope("Find TSA pending").refuse).toBe(false);
  });
});
