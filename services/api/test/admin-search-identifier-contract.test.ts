/**
 * THE IDENTIFIER CONTRACT — a refusal and an absence are different answers.
 *
 * This surface answers two questions through one box: free-text NAME search,
 * and EXACT identifier lookup. Only exact identifiers are matched; prefix
 * matching is deliberately not offered, because a prefix over UUIDs has no
 * useful collision story and a partial match is a guess about which record
 * the operator meant.
 *
 * The defect: a truncated identifier and a valid-but-absent one both returned
 * `200` with `total: 0`. Those are opposite facts — "you pasted half an id"
 * and "that record does not exist" — and an operator copying an id out of a
 * clipped log line had no way to tell which had happened.
 *
 * `classifyIdentifierAttempt` is the whole decision, so it is tested directly.
 * Its hard case is not the UUID; it is knowing when a term is NOT an
 * identifier attempt at all, because misjudging that direction would start
 * rejecting legitimate name searches.
 */

import { describe, expect, it } from "vitest";

import { classifyIdentifierAttempt } from "../src/routes/admin-search.routes.js";

describe("complete identifiers are accepted", () => {
  it("recognises the UUID shapes this platform issues", () => {
    for (const id of [
      "0adf0000-0000-4000-8000-000000000001",
      "11111111-1111-4111-8111-111111111111",
      "c72dd954-329e-4565-b471-5aab43658c76",
      "C72DD954-329E-4565-B471-5AAB43658C76",
    ]) {
      expect(classifyIdentifierAttempt(id), id).toBe("EXACT");
    }
  });

  it("tolerates surrounding whitespace, which is how a paste arrives", () => {
    expect(classifyIdentifierAttempt("  0adf0000-0000-4000-8000-000000000001  ")).toBe(
      "EXACT",
    );
  });
});

describe("an incomplete identifier is a malformed one, not an empty result", () => {
  it("refuses a truncated UUID", () => {
    for (const term of [
      "0adf0000-0000-4000-8000",
      "0adf0000-0000-4000",
      "0adf0000-",
      "0adf0000-0000-4000-8000-00000000000", // one character short
    ]) {
      expect(classifyIdentifierAttempt(term), term).toBe("MALFORMED");
    }
  });

  it("refuses a long unbroken hex run, which is an id with the hyphens lost", () => {
    expect(classifyIdentifierAttempt("0adf0000000040008000000000000001")).toBe(
      "MALFORMED",
    );
  });

  it("refuses a UUID-shaped string with an invalid version or variant", () => {
    // Right length, right layout, impossible content. Accepting it would send
    // a guaranteed-miss query and report it as "no such record".
    expect(classifyIdentifierAttempt("0adf0000-0000-9000-8000-000000000001")).toBe(
      "MALFORMED",
    );
  });
});

describe("a name is not a malformed identifier", () => {
  it("passes ordinary search terms through to the name search", () => {
    for (const term of [
      "Northwind Legal",
      "someone@example.com",
      "not-a-real-thing",
      "quarterly review",
      "Zoë",
      "acme",
    ]) {
      expect(classifyIdentifierAttempt(term), term).toBe("NOT_AN_IDENTIFIER");
    }
  });

  it("treats a short hex-looking word as a name, because people type those", () => {
    // "decaf" and "added" are hex-legal and also words. Rejecting them would
    // break name search to satisfy a rule about identifiers.
    expect(classifyIdentifierAttempt("decaf")).toBe("NOT_AN_IDENTIFIER");
    expect(classifyIdentifierAttempt("added")).toBe("NOT_AN_IDENTIFIER");
  });

  it("classifies a hyphenated NAME containing non-hex letters as a name", () => {
    // The hyphen alone must not condemn a term; the alphabet decides.
    expect(classifyIdentifierAttempt("north-west-team")).toBe("NOT_AN_IDENTIFIER");
  });
});

describe("no prefix matching is offered, and that is the stated contract", () => {
  it("an ambiguous prefix is refused rather than resolved to a guess", () => {
    // This prefix is shared by every fixture id. There is no correct record
    // to return, and returning the first is the failure this refuses.
    expect(classifyIdentifierAttempt("0adf0000-0000-4000-8000")).toBe("MALFORMED");
  });

  it("every classification is one of exactly three answers", () => {
    const seen = new Set(
      [
        "0adf0000-0000-4000-8000-000000000001",
        "0adf0000-0000",
        "Northwind",
      ].map(classifyIdentifierAttempt),
    );
    expect([...seen].sort()).toEqual(["EXACT", "MALFORMED", "NOT_AN_IDENTIFIER"]);
  });
});
