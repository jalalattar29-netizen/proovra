/**
 * EXTERNAL INTAKE IDENTITY SEARCH — one rule, four surfaces.
 *
 * Customer ID, recipient name, recipient email and recipient phone can each
 * locate a record that arrived through an intake link. They are four different
 * facts, an operator types all four, and a record can carry all four.
 *
 * The point of these tests is that there is ONE matching rule. Written per
 * surface, the implementations drift — one lower-cases, one does not; one
 * understands a phone number with spaces, two do not — and the drift shows up
 * as "search is broken" for whichever surface somebody happened to try.
 *
 * The second point is the invariant underneath: SEARCHABILITY IS NOT
 * DISCLOSURE. Matching on a value the caller already holds tells them nothing
 * they did not bring; being shown that value is a separate act with its own
 * authority. The two are wired together deliberately — a caller who may not
 * SEE an address may not ask whether it is here either, because a row count
 * answers the question the mask exists to refuse.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  INTAKE_SEARCH_NEEDLE_MAX,
  evidenceIntakeIdentityArms,
  intakeLinkIdentityArms,
  intakePhoneDigits,
  intakePhoneE164,
} from "../src/services/search/intake-identity-search.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const SCHEMA = read("services/api/prisma/schema.prisma");
const MIGRATION = read(
  "services/api/prisma/migrations/20280210000000_intake_identity_search/migration.sql",
);
const LINK_SERVICE = read("services/api/src/services/workflow-intake-link.service.ts");
const EVIDENCE_ROUTES = read("services/api/src/routes/evidence.routes.ts");
const REPORTS = read("services/api/src/services/reports/reports-aggregator.service.ts");
const PROJECTION = read("packages/shared/src/search-projection.ts");
const INDEX_QUERY = read(
  "services/api/src/services/search/evidence-search.service.ts",
);

const armKeys = (arms: object[]) => arms.flatMap((a) => Object.keys(a));

// ===========================================================================
// Normalisation
// ===========================================================================
describe("one number, written the ways people write numbers", () => {
  it("resolves the three canonical forms to the same value", () => {
    const expected = "+4917612345678";
    for (const written of [
      "+4917612345678",
      "+49 176 12345678",
      "0049 176 12345678",
      "  +49 176 12345678  ",
      "+49-176-12345678",
    ]) {
      expect(intakePhoneE164(written), `${written} did not normalise`).toBe(
        expected,
      );
    }
  });

  it("does not invent a country for a national number", () => {
    /*
     * "017612345678" is a German mobile to a German reader and something else
     * to everybody else. Guessing here would quietly return the wrong
     * customer, which is worse than returning none.
     */
    expect(intakePhoneE164("017612345678")).toBeNull();
  });

  it("says nothing about a needle with no digits", () => {
    expect(intakePhoneE164("John Search Doe")).toBeNull();
    expect(intakePhoneDigits("John Search Doe")).toBeNull();
  });

  it("treats a very short digit run as not a phone search", () => {
    // Three digits matches half the workspace; it is a filter, not a search.
    expect(intakePhoneDigits("123")).toBeNull();
    expect(intakePhoneDigits("12345678")).toBe("12345678");
  });
});

// ===========================================================================
// The arms
// ===========================================================================
describe("the four identifiers are independently matchable", () => {
  it("an ordinary reader matches the business metadata and the name", () => {
    const arms = intakeLinkIdentityArms("anything", {
      matchRecipientContact: false,
    });
    expect(armKeys(arms)).toEqual(["customerId", "recipientLabel"]);
  });

  it("and never the contact — the search box is not an oracle", () => {
    const arms = intakeLinkIdentityArms("john.search@example.test", {
      matchRecipientContact: false,
    });
    expect(JSON.stringify(arms)).not.toContain("recipientEmail");
    expect(JSON.stringify(arms)).not.toContain("recipientPhone");
  });

  it("an authorized reader also matches the address and the number", () => {
    const keys = armKeys(
      intakeLinkIdentityArms("+49 176 12345678", { matchRecipientContact: true }),
    );
    expect(keys).toContain("customerId");
    expect(keys).toContain("recipientLabel");
    expect(keys).toContain("recipientEmail");
    expect(keys).toContain("recipientPhone");
    // Both the value as typed and the canonical form, so either finds the row.
    expect(keys.filter((k) => k === "recipientPhoneE164").length).toBeGreaterThan(0);
  });

  it("matches an email whatever case it is typed in", () => {
    const arms = intakeLinkIdentityArms("JOHN.SEARCH@EXAMPLE.TEST", {
      matchRecipientContact: true,
    });
    const email = arms.find((a) => "recipientEmail" in a) as {
      recipientEmail: { mode?: string };
    };
    expect(email.recipientEmail.mode).toBe("insensitive");
  });

  it("bounds the needle so a pathological query cannot become the query", () => {
    expect(INTAKE_SEARCH_NEEDLE_MAX).toBe(120);
    const arms = intakeLinkIdentityArms("x".repeat(500), {
      matchRecipientContact: false,
    });
    const first = arms[0] as { customerId: { contains: string } };
    expect(first.customerId.contains.length).toBe(120);
  });

  it("returns nothing for an empty needle", () => {
    expect(intakeLinkIdentityArms("   ", { matchRecipientContact: true })).toEqual([]);
    expect(evidenceIntakeIdentityArms("", { matchRecipientContact: true })).toEqual([]);
  });
});

describe("reaching the same four facts from an evidence row", () => {
  it("asks for the Customer ID on BOTH the snapshot and the link", () => {
    const arms = evidenceIntakeIdentityArms("CUST-SEARCH-849271", {
      matchRecipientContact: false,
    });
    const body = JSON.stringify(arms);
    // The indexed column on the row itself, not a join.
    expect(body).toContain("intakeCustomerId");
    // And the name through the 1:1 session relation.
    expect(body).toContain("workflowIntakeSession");
    expect(body).toContain("recipientLabel");
    /*
     * AND the link's own Customer ID.
     *
     * This asserted the opposite — that asking the link too was "the same
     * rows, slower". It is not the same rows. `intakeCustomerId` is a
     * SNAPSHOT taken at submission, and its column arrived with migration
     * 20280125000000, so every record submitted before that migration reached
     * production has it NULL no matter what its link says. Matching only the
     * snapshot left those records permanently unfindable by the identifier
     * their own organisation uses for them.
     *
     * The snapshot stays authoritative for provenance. Search accepts either.
     */
    expect(body).toContain('"customerId"');
    expect(body).toContain("intakeLink");
  });

  it("scopes the contact arms to the workspaces that may see them", () => {
    /*
     * The Evidence list spans every workspace the caller belongs to, and the
     * disclosure answer is per workspace. A single boolean across that set
     * would over-disclose in the workspace where they are a viewer, or refuse
     * a search they are entitled to run in the one where they are not.
     */
    const arms = evidenceIntakeIdentityArms("john.search@example.test", {
      matchRecipientContact: true,
      revealedTeamIds: ["team-a"],
    });
    const scoped = arms.find((a) => "AND" in a) as {
      AND: [{ teamId: { in: string[] } }, unknown];
    };
    expect(scoped).toBeTruthy();
    expect(scoped.AND[0].teamId.in).toEqual(["team-a"]);
    expect(JSON.stringify(scoped.AND[1])).toContain("recipientEmail");
  });

  it("omits the contact arms entirely when nobody may match on them", () => {
    const arms = evidenceIntakeIdentityArms("john.search@example.test", {
      matchRecipientContact: false,
    });
    expect(JSON.stringify(arms)).not.toContain("recipientEmail");
  });
});

// ===========================================================================
// Every surface consumes the one rule
// ===========================================================================
describe("the surfaces", () => {
  it("intake links spreads the shared arms", () => {
    expect(LINK_SERVICE).toContain("intakeLinkIdentityArms(needle, options)");
    // The old hand-rolled digit matching is gone.
    expect(LINK_SERVICE).not.toContain('recipientPhone: { contains: digits');
  });

  it("the evidence list spreads the shared arms", () => {
    expect(EVIDENCE_ROUTES).toContain("...evidenceIntakeIdentityArms(search, options)");
  });

  it("reports spreads the same arms rather than copying the data", () => {
    expect(REPORTS).toContain("...evidenceIntakeIdentityArms(needle, {");
    /*
     * Reports get NO copy of the recipient details. There is a 1:1 relation
     * through a unique key; a second table holding the same contact details
     * would be a second place a disclosure decision has to be got right.
     */
    expect(REPORTS).not.toContain("recipientEmail:");
    expect(REPORTS).not.toContain("recipientPhone:");
  });

  it("the canonical index carries all four, split by who may match on them", () => {
    /*
     * The free-text body holds the two identifiers that are not contact: the
     * organisation's own Customer ID and the label its own operator wrote.
     * Anyone who can read the record can match on those.
     */
    expect(PROJECTION).toContain("intake?.customerId");
    expect(PROJECTION).toContain("intake?.recipientLabel");

    /*
     * The address and the number are NOT in the body. `searchableText` is one
     * column and one ILIKE, so anything in it is matchable by every caller the
     * query lets through — which made the index the one intake surface that
     * ignored the recipient-contact policy the other three enforce. They live
     * in the gated haystack, and the query adds that arm only for a caller
     * whose disclosure allows it.
     */
    expect(PROJECTION).toContain("SEARCH_CONTACT_HAYSTACK_KEY");
    expect(PROJECTION).toContain("buildIntakeContactHaystack");
    const body = PROJECTION.slice(
      PROJECTION.indexOf("const bodyParts = ["),
      PROJECTION.indexOf("const searchableText"),
    );
    expect(body).not.toContain("recipientEmail");
    expect(body).not.toContain("recipientPhone");

    // All three contact forms reach the haystack, so one number written three
    // ways still resolves to the same row for a caller entitled to ask.
    expect(PROJECTION).toContain("identity.recipientEmail");
    expect(PROJECTION).toContain("identity.recipientPhone");
    expect(PROJECTION).toContain("identity.recipientPhoneE164");
  });

  it("the index query normalises a phone needle the same way", () => {
    // Without this the index is the one surface that disagrees about whether
    // "0049 176 12345678" is the same number as "+4917612345678".
    expect(INDEX_QUERY).toContain("intakePhoneE164(filter.q)");
  });
});

// ===========================================================================
// Storage
// ===========================================================================
describe("the canonical phone form", () => {
  it("sits beside the value as typed, never replacing it", () => {
    expect(SCHEMA).toContain(
      'recipientPhone String? @map("recipient_phone") @db.VarChar(32)',
    );
    expect(SCHEMA).toContain(
      'recipientPhoneE164 String? @map("recipient_phone_e164") @db.VarChar(32)',
    );
    // Provenance is what the operator entered; the derived form is additional.
    expect(MIGRATION).not.toMatch(/UPDATE[\s\S]*SET "recipient_phone" =/);
  });

  it("is derived once, at the write", () => {
    expect(LINK_SERVICE).toContain("recipientPhoneE164: input.recipientPhone");
    expect(LINK_SERVICE).toContain("intakePhoneE164(input.recipientPhone)");
  });

  it("is indexed, with the email, so neither search is a table scan", () => {
    expect(SCHEMA).toContain("@@index([teamId, recipientEmail])");
    expect(SCHEMA).toContain("@@index([teamId, recipientPhoneE164])");
    expect(MIGRATION).toContain('"team_id", "recipient_email"');
    expect(MIGRATION).toContain('"team_id", "recipient_phone_e164"');
  });

  it("backfills only what the digits make unambiguous", () => {
    /*
     * A national number without a country code cannot be normalised without
     * guessing which country it belongs to, and a wrong guess is a search that
     * quietly finds the wrong customer. Those rows stay null.
     */
    expect(MIGRATION).toContain("ELSE NULL");
    expect(MIGRATION).toContain("LIKE '00%'");
  });
});
