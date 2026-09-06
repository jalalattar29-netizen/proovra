/**
 * EXTERNAL INTAKE IDENTITY IN GLOBAL SEARCH.
 *
 * The Intake Links screen found a Customer ID; `/search` did not. Both were
 * asked the same question about the same workspace and gave different answers,
 * and the one people reach for first was the one that said "no results".
 *
 * The cause was not a frontend filter and not a stale document: the index held
 * EVIDENCE documents only, so intake identity reached it only once evidence
 * came back. A request that had been SENT and not yet answered — which is
 * exactly when somebody goes looking for it — had no document at all.
 *
 * These tests pin the fix at the layer it was made:
 *
 *   1. the request is its own document type, built by the shared projection;
 *   2. the two identifiers that are not contact stay matchable by every
 *      reader, and the two that ARE contact move to a haystack the query
 *      opens only for a caller whose disclosure allows it;
 *   3. the indexer, the mutation hooks and the reconciliation sweep all know
 *      about the new type, so both new and pre-existing records are reachable;
 *   4. a result says WHICH identifier matched without printing a number.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SEARCH_CONTACT_HAYSTACK_KEY,
  SEARCH_CUSTOMER_ID_KEY,
  SEARCH_DOCUMENT_TYPES,
  SEARCH_PROJECTION_VERSION,
  buildEvidenceProjection,
  buildIntakeContactHaystack,
  buildIntakeLinkProjection,
  isAllowedSearchDocumentType,
} from "@proovra/shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const api = (p: string) => readFileSync(resolve(HERE, "..", p), "utf8");
const repo = (p: string) => readFileSync(resolve(HERE, "../../..", p), "utf8");

const INDEXER = api("src/services/search/evidence-indexing.service.ts");
const QUERY = api("src/services/search/evidence-search.service.ts");
const ROUTE = api("src/routes/search.routes.ts");
const REINDEX = api("src/services/search/reindex.service.ts");
const LINK_SERVICE = api("src/services/workflow-intake-link.service.ts");
const PROJECTION = repo("packages/shared/src/search-projection.ts");
const SEARCH_PAGE = repo("apps/web/app/(app)/search/page.tsx");

const CUSTOMER = "CUST-849271";
const EMAIL = "John.Search@Example.Test";
const PHONE = "+49 176 12345678";
const PHONE_E164 = "+4917612345678";

const LINK = {
  id: "11111111-2222-4333-8444-555555555555",
  teamId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  customerId: CUSTOMER,
  recipientLabel: "John Search Doe",
  recipientEmail: EMAIL,
  recipientPhone: PHONE,
  recipientPhoneE164: PHONE_E164,
  workflowTemplateSlug: "general-evidence-record",
  intakeMode: "EXTERNAL_ONE_TIME",
  status: "ACTIVE",
  caseId: null as string | null,
  expiresAtUtc: new Date(Date.now() + 86_400_000) as Date | null,
  revokedAtUtc: null as Date | null,
  archivedAtUtc: null as Date | null,
  usedCount: 0,
  updatedAt: new Date("2026-09-01T10:00:00.000Z"),
};

function projectLink(overrides: Partial<typeof LINK> = {}) {
  const result = buildIntakeLinkProjection({
    teamId: LINK.teamId,
    link: { ...LINK, ...overrides },
  });
  if (!result.ok) throw new Error(`projection refused: ${result.reason}`);
  return result.projection;
}

// ===========================================================================
// 1. The request is a first-class document
// ===========================================================================
describe("the intake request is its own document", () => {
  it("INTAKE_LINK is in the canonical catalog", () => {
    expect(SEARCH_DOCUMENT_TYPES).toContain("INTAKE_LINK");
    expect(isAllowedSearchDocumentType("INTAKE_LINK")).toBe(true);
  });

  it("carries the workspace and the link id, so the row can be opened", () => {
    const p = projectLink();
    expect(p.documentType).toBe("INTAKE_LINK");
    expect(p.teamId).toBe(LINK.teamId);
    expect(p.sourceId).toBe(LINK.id);
    expect(p.projectionVersion).toBe(SEARCH_PROJECTION_VERSION);
  });

  it("refuses to build a document for another workspace's row", () => {
    const result = buildIntakeLinkProjection({
      teamId: "99999999-9999-4999-8999-999999999999",
      link: LINK,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("team_mismatch");
  });

  it("stays indexed after it is revoked, expired or archived", () => {
    // A closed request is the one an operator asking "what happened with this
    // customer" needs most. The STATE travels with the document instead.
    expect(projectLink({ revokedAtUtc: new Date() }).workflowState).toBe("REVOKED");
    expect(
      projectLink({ expiresAtUtc: new Date(Date.now() - 1000) }).workflowState,
    ).toBe("EXPIRED");
    expect(projectLink({ archivedAtUtc: new Date() }).searchableTags).toContain(
      "archived",
    );
  });
});

// ===========================================================================
// 2. Who may match on what
// ===========================================================================
describe("the two halves of intake identity", () => {
  it("Customer ID and recipient label are in the open body", () => {
    const p = projectLink();
    expect(p.searchableText).toContain(CUSTOMER);
    expect(p.searchableText).toContain("John Search Doe");
  });

  it("the address and the number are NOT in the open body", () => {
    const p = projectLink();
    expect(p.searchableText ?? "").not.toContain("Example.Test");
    expect(p.searchableText ?? "").not.toContain("17612345678");
    // Nor anywhere else a response could reach: title, subtitle, summary are
    // all projected onto the result row.
    for (const field of [p.title, p.subtitle ?? "", p.summary ?? ""]) {
      expect(field.toLowerCase()).not.toContain("example.test");
      expect(field).not.toContain("17612345678");
    }
  });

  it("they are in the gated haystack instead, lower-cased", () => {
    const meta = projectLink().searchableMetadata ?? {};
    const haystack = String(meta[SEARCH_CONTACT_HAYSTACK_KEY] ?? "");
    expect(haystack).toContain(EMAIL.toLowerCase());
    expect(haystack).toContain(PHONE_E164);
    // Lower-cased at write time because a JSON `string_contains` has no
    // case-insensitive mode, and an address that only matched in the case it
    // was stored in is a correct query answered with "no results".
    expect(haystack).toBe(haystack.toLowerCase());
  });

  it("a request with no contact has no haystack at all", () => {
    // Not an empty string: an empty key still confirms the shape.
    expect(
      buildIntakeContactHaystack({
        recipientEmail: null,
        recipientPhone: null,
        recipientPhoneE164: null,
      }),
    ).toBeNull();
    expect(buildIntakeContactHaystack(null)).toBeNull();
  });

  it("evidence follows the same split", () => {
    const result = buildEvidenceProjection({
      teamId: LINK.teamId,
      evidenceId: "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
      evidence: {
        id: "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
        teamId: LINK.teamId,
        title: "claim photo",
        displayFileName: "claim-photo.png",
        originalFileName: "claim-photo.png",
        type: "PHOTO",
        mimeType: "image/png",
        captureMethod: "EXTERNAL_INTAKE_UPLOAD",
        caseId: null,
        deletedAt: null,
        lifecycleState: "ACTIVE",
        archivedAt: null,
        lockedAt: null,
        publicVerifyState: null,
        storageObjectLockLegalHoldStatus: null,
        retentionPolicySource: null,
        retentionUntilUtc: null,
        reviewReadyAtUtc: null,
        updatedAt: new Date("2026-09-01T10:00:00.000Z"),
      },
      intakeIdentity: {
        customerId: CUSTOMER,
        recipientLabel: "John Search Doe",
        recipientEmail: EMAIL,
        recipientPhone: PHONE,
        recipientPhoneE164: PHONE_E164,
      },
      workflowState: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const p = result.projection;
    expect(p.searchableText).toContain(CUSTOMER);
    expect(p.searchableText).toContain("John Search Doe");
    expect(p.searchableText ?? "").not.toContain("17612345678");
    expect(p.searchableText?.toLowerCase() ?? "").not.toContain("example.test");
    const meta = p.searchableMetadata ?? {};
    expect(String(meta[SEARCH_CONTACT_HAYSTACK_KEY] ?? "")).toContain(PHONE_E164);
    expect(meta[SEARCH_CUSTOMER_ID_KEY]).toBe(CUSTOMER);
  });

  it("moving the contact bumped the projection version", () => {
    // Every document written before this change holds the contact in its body.
    // Only a version bump makes the reconciliation sweep revisit them; without
    // it the sweep reports success over documents it never rewrote.
    expect(SEARCH_PROJECTION_VERSION).toBeGreaterThanOrEqual(3);
    expect(PROJECTION).toContain("3 → moves recipient contact OUT of the free-text body");
  });
});

// ===========================================================================
// 3. The query gate
// ===========================================================================
describe("matching on contact is a decision, not a default", () => {
  it("executeSearch takes the disclosure answer and defaults to restricted", () => {
    expect(QUERY).toContain("matchRecipientContact?: boolean;");
    expect(QUERY).toContain("if (input.matchRecipientContact === true) {");
    // `=== true` rather than a truthy check: a caller that forgets to resolve
    // the disclosure gets the restricted behaviour, not the permissive one.
    expect(QUERY).not.toMatch(/if \(input\.matchRecipientContact\)\s*\{/);
  });

  it("the arm is absent for a restricted caller, not filtered afterwards", () => {
    // A post-filter leaks through the result count, which is the whole of what
    // an oracle needs.
    const gate = QUERY.slice(
      QUERY.indexOf("if (input.matchRecipientContact === true) {"),
      QUERY.indexOf("const idNeedle = parseEvidenceIdNeedle"),
    );
    // The arm names the shared constant rather than repeating its value, so
    // the write side and the read side cannot drift apart.
    expect(gate).toContain("path: [SEARCH_CONTACT_HAYSTACK_KEY]");
    expect(gate).toContain("string_contains");
    expect(QUERY).not.toContain("filter((row) => matchRecipientContact");
  });

  it("the route resolves it through the ONE recipient-contact authority", () => {
    expect(ROUTE).toContain("resolveRecipientContactDisclosure");
    expect(ROUTE).toContain('matchRecipientContact: disclosure === "REVEALED"');
  });

  it("one number written three ways still reaches the haystack", () => {
    const gate = QUERY.slice(
      QUERY.indexOf("if (input.matchRecipientContact === true) {"),
      QUERY.indexOf("const idNeedle = parseEvidenceIdNeedle"),
    );
    // The needle as typed, the canonical form, and the digits of a partial.
    expect(gate).toContain("intakePhoneE164(filter.q)");
    expect(gate).toContain("intakePhoneDigits(filter.q)");
    expect(gate).toContain("toLowerCase()");
  });

  it("the type-ahead never reaches the haystack at all", () => {
    // `/v1/search/suggest` queries title + searchableText only, and has no
    // disclosure resolution — so contact must not be reachable through it.
    const suggest = ROUTE.slice(
      ROUTE.indexOf('"/v1/search/suggest"'),
      ROUTE.indexOf('"/v1/search/suggest"') + 2000,
    );
    expect(suggest).not.toContain("SEARCH_CONTACT_HAYSTACK_KEY");
    expect(suggest).not.toContain("searchableMetadataJson");
  });
});

// ===========================================================================
// 4. Indexing — new records and old ones
// ===========================================================================
describe("both new and pre-existing requests reach the index", () => {
  it("there is an indexer for the new type", () => {
    expect(INDEXER).toContain("export async function indexIntakeLink(");
    expect(INDEXER).toContain("buildIntakeLinkProjection");
    // It writes through the same canonical upsert every other type uses.
    expect(INDEXER).toContain("return upsertSearchDocumentProjection(result.projection, client);");
  });

  it("a link that no longer exists loses its document", () => {
    expect(INDEXER).toMatch(
      /if \(!link\) \{[\s\S]*tryDeleteByKey\(client, input\.teamId, "INTAKE_LINK", input\.intakeLinkId\)/,
    );
  });

  it("every mutation that changes a request re-indexes it", () => {
    const calls = LINK_SERVICE.match(/indexIntakeLinkBestEffort\(/g) ?? [];
    // create, revoke, archive, unarchive.
    expect(calls.length).toBe(4);
  });

  it("indexing can never fail an operator's intake request", () => {
    expect(INDEXER).toContain("export function indexIntakeLinkBestEffort(");
    expect(INDEXER).toMatch(/void indexIntakeLink\(input, client\)\.catch\(\(\) => null\);/);
  });

  it("the reconciliation sweep covers requests, orphaned AND stale", () => {
    expect(REINDEX).toContain("document_type = 'INTAKE_LINK'");
    expect(REINDEX).toContain("esd.id IS NULL OR esd.projection_version < $2");
    expect(REINDEX).toContain("intakeLinks: ReindexBucket;");
    // Reported, not silently done: an operator running a reconcile must be
    // able to see that requests were part of it.
    expect(ROUTE).toContain("intakeLinks: result.intakeLinks");
  });
});

// ===========================================================================
// 5. What the operator sees
// ===========================================================================
describe("a result says why it matched", () => {
  it("names the Customer ID, because echoing it back discloses nothing", () => {
    expect(QUERY).toContain("`Customer ID · ${customerId}`");
  });

  it("names the FIELD for contact, never the value", () => {
    expect(QUERY).toContain('reasons.push("Matched recipient email")');
    expect(QUERY).toContain('reasons.push("Matched recipient phone")');
    // No template that could interpolate an address or a number.
    expect(QUERY).not.toMatch(/reasons\.push\(`[^`]*\$\{(email|haystack|phone)/);
  });

  it("the row carries the source id so the UI can open the request", () => {
    expect(QUERY).toContain("sourceId: doc.sourceId,");
    expect(SEARCH_PAGE).toContain('case "INTAKE_LINK":');
    expect(SEARCH_PAGE).toContain("/intake-links?linkId=${row.sourceId}");
  });

  it("the type is offered as a filter chip, not hidden", () => {
    expect(SEARCH_PAGE).toContain('INTAKE_LINK: "Intake request"');
  });
});
