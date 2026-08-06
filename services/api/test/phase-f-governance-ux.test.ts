/**
 * Phase F — Governance UX (source-contract suite).
 *
 * Asserts:
 *
 *  1. The three new governance endpoints are registered:
 *     - GET /v1/governance/destruction-reviews/:id/preview
 *     - GET /v1/governance/destruction-reviews/:id/certificate
 *     - GET /v1/governance/retention/inheritance
 *
 *  2. Each endpoint is gated by `requireMember(teamId)` +
 *     `governance.policy.read` permission, and emits NO audit
 *     (browsing previews is intentionally not auditable; the
 *     mutating destructive endpoints keep their existing audit).
 *
 *  3. The destruction preview payload includes the operational
 *     impact contract: `evidence`, `policy`, `holds.{evidence,case}`,
 *     `impact.{willDelete,willPersist,irreversible,lifecycleEventCount}`,
 *     `blockedBy`, `guidance`.
 *
 *  4. The destruction certificate payload includes the canonical
 *     certificate fields + the verbatim caveats array.
 *
 *  5. The retention inheritance endpoint surfaces the resolver
 *     verdict (`team_policy` / `org_policy_inherited` / `none`)
 *     unchanged.
 *
 *  6. The frontend components consume the new endpoints, render
 *     operator-safe empty/error states, and never bypass the
 *     audited transition endpoint for destructive actions.
 *
 *  7. Governance UI surfaces the new components on:
 *     - /governance/destruction (preview + certificate modals)
 *     - /governance/retention (inheritance summary)
 *
 *  8. Vocabulary discipline — destruction certificate never claims
 *     legal admissibility, cryptographic erasure proof, or
 *     compliance attestation.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

const ROUTE_SRC = readSource(
  "../src/routes/governance-lifecycle.routes.ts",
);
const PREVIEW_UI = readSource(
  "../../../apps/web/components/governance/DestructionImpactPreview.tsx",
);
const CERT_UI = readSource(
  "../../../apps/web/components/governance/DestructionCertificate.tsx",
);
const INHERIT_UI = readSource(
  "../../../apps/web/components/governance/RetentionInheritanceSummary.tsx",
);
const DESTRUCTION_PAGE = readSource(
  "../../../apps/web/app/(app)/governance/destruction/page.tsx",
);
const RETENTION_PAGE = readSource(
  "../../../apps/web/app/(app)/governance/retention/page.tsx",
);

// ===========================================================================
// 1. Backend endpoint registration
// ===========================================================================

describe("Phase F — backend governance endpoints", () => {
  it("registers GET /v1/governance/destruction-reviews/:id/preview", () => {
    expect(ROUTE_SRC).toMatch(
      /app\.get\(\s*"\/v1\/governance\/destruction-reviews\/:id\/preview"/,
    );
  });

  it("registers GET /v1/governance/destruction-reviews/:id/certificate", () => {
    expect(ROUTE_SRC).toMatch(
      /app\.get\(\s*"\/v1\/governance\/destruction-reviews\/:id\/certificate"/,
    );
  });

  it("registers GET /v1/governance/retention/inheritance", () => {
    expect(ROUTE_SRC).toMatch(
      /app\.get\(\s*"\/v1\/governance\/retention\/inheritance"/,
    );
  });

  it("imports resolveTeamRetentionPolicy from the B0 service", () => {
    expect(ROUTE_SRC).toMatch(
      /import\s*\{\s*resolveTeamRetentionPolicy\s*\}\s*from\s+"\.\.\/services\/organization\/retention-inheritance\.service\.js"/,
    );
  });
});

// ===========================================================================
// 2. Access gates + read-only
// ===========================================================================

describe("Phase F — governance read endpoints are gated + audit-free", () => {
  const newHandlers = [
    "destruction-reviews/:id/preview",
    "destruction-reviews/:id/certificate",
    "retention/inheritance",
  ];

  it("each new handler invokes requireMember + governance.policy.read", () => {
    for (const tag of newHandlers) {
      const block = ROUTE_SRC.match(
        new RegExp(
          `${tag.replace(/[/:]/g, "\\$&")}[\\s\\S]*?\\}\\s*,\\s*\\)\\s*;`,
        ),
      );
      expect(block, `handler for ${tag}`).toBeTruthy();
      expect(block![0]).toContain("requireMember");
      expect(block![0]).toMatch(/"governance\.policy\.read"/);
    }
  });

  it("each new handler emits no audit (reads are not auditable)", () => {
    for (const tag of newHandlers) {
      const block = ROUTE_SRC.match(
        new RegExp(
          `${tag.replace(/[/:]/g, "\\$&")}[\\s\\S]*?\\}\\s*,\\s*\\)\\s*;`,
        ),
      );
      expect(block).toBeTruthy();
      expect(block![0]).not.toMatch(
        /appendCustodyEvent|appendPlatformAuditLog|writeAnalyticsEvent|appendReviewerAuditEvent/,
      );
    }
  });
});

// ===========================================================================
// 3. Destruction impact preview contract
// ===========================================================================

describe("Phase F — destruction impact preview payload", () => {
  it("returns the operational impact contract", () => {
    // The preview handler sends every contract field. Anchor on
    // the unique `blockedBy.length === 0` ternary inside guidance
    // to bound the block we inspect.
    const guidancePos = ROUTE_SRC.indexOf("blockedBy.length === 0");
    expect(guidancePos).toBeGreaterThan(0);
    const previewPos = ROUTE_SRC.indexOf("/preview");
    expect(previewPos).toBeGreaterThan(0);
    const block = ROUTE_SRC.slice(previewPos, guidancePos + 400);
    expect(block).toContain("review:");
    expect(block).toContain("evidence:");
    expect(block).toContain("policy");
    expect(block).toContain("holds:");
    expect(block).toContain("impact:");
    expect(block).toContain("blockedBy");
    expect(block).toContain("guidance");
  });

  it("computes blockers from active holds + immutable policy + destroyed state", () => {
    expect(ROUTE_SRC).toMatch(
      /blockedBy\.push\("evidence_legal_hold"\)/,
    );
    expect(ROUTE_SRC).toMatch(/blockedBy\.push\("case_legal_hold"\)/);
    expect(ROUTE_SRC).toMatch(
      /blockedBy\.push\("retention_policy_immutable"\)/,
    );
    expect(ROUTE_SRC).toMatch(/blockedBy\.push\("already_destroyed"\)/);
  });

  it("emits the persistence contract — destruction is never total erasure", () => {
    expect(ROUTE_SRC).toContain("evidence_record_tombstone");
    expect(ROUTE_SRC).toContain("lifecycle_event_ledger");
    expect(ROUTE_SRC).toContain("destruction_certificate");
    expect(ROUTE_SRC).toContain("audit_log_references");
  });

  it("resolves inherited case-level holds via CaseEvidenceLink", () => {
    // The handler must not rely on a `case.evidenceLinks` back
    // relation (it doesn't exist in the schema). It queries
    // CaseEvidenceLink → caseLegalHold by caseId IN (...).
    expect(ROUTE_SRC).toMatch(/caseEvidenceLink\.findMany/);
    // PHASE 12 POINT 3 — the inherited-hold lookup reads the ONE canonical
    // table. The invariant is unchanged and still the point of this test: the
    // linked case ids come from CaseEvidenceLink and are passed as `caseId IN
    // (...)`, so a hold on ANY linked case is inherited by the evidence.
    expect(ROUTE_SRC).toMatch(
      /evidenceLegalHold\.findMany[\s\S]*?caseId:\s*\{\s*in:/,
    );
    expect(ROUTE_SRC).toMatch(/scope: "CASE"/);
    expect(ROUTE_SRC).not.toMatch(/caseLegalHold\.findMany/);
  });
});

// ===========================================================================
// 4. Destruction certificate contract
// ===========================================================================

describe("Phase F — destruction certificate payload", () => {
  it("only serves certificates for EXECUTED reviews (409 otherwise)", () => {
    expect(ROUTE_SRC).toMatch(
      /review\.status\s*!==\s*"EXECUTED"[\s\S]*?reply\.code\(409\)\.send\(\{\s*error:\s*\{\s*code:\s*"certificate_unavailable"/,
    );
  });

  it("emits the canonical certificate fields + caveats", () => {
    const handler = ROUTE_SRC.match(
      /certificate[\s\S]*?reply\.code\(200\)\.send\(\{[\s\S]*?caveats:/,
    );
    expect(handler).toBeTruthy();
    expect(handler![0]).toContain("reviewId");
    expect(handler![0]).toContain("evidenceId");
    expect(handler![0]).toContain("certificateHash");
    expect(handler![0]).toContain("lineageHash");
    expect(handler![0]).toContain("lifecycleEventId");
  });

  it("caveats explicitly disclaim legal admissibility + cryptographic proof + total erasure", () => {
    expect(ROUTE_SRC).toMatch(/not a legal admissibility statement/);
    expect(ROUTE_SRC).toMatch(/lifecycle event ledger entries[\s\S]*?PERSIST/);
    expect(ROUTE_SRC).toMatch(/cryptographic proof of total erasure/i);
  });
});

// ===========================================================================
// 5. Retention inheritance endpoint
// ===========================================================================

describe("Phase F — retention inheritance endpoint", () => {
  it("delegates entirely to the existing resolveTeamRetentionPolicy", () => {
    const handler = ROUTE_SRC.match(
      /retention\/inheritance[\s\S]*?\}\s*,\s*\)\s*;/,
    );
    expect(handler).toBeTruthy();
    expect(handler![0]).toMatch(
      /resolveTeamRetentionPolicy\(query\.teamId\)/,
    );
  });

  it("returns the resolver verdict verbatim under `resolution`", () => {
    expect(ROUTE_SRC).toMatch(
      /retention\/inheritance[\s\S]*?reply\.code\(200\)\.send\(\{\s*resolution\s*\}\)/,
    );
  });
});

// ===========================================================================
// 6. Frontend components
// ===========================================================================

describe("Phase F — DestructionImpactPreview component", () => {
  it("consumes the new preview endpoint", () => {
    // The component splits `encodeURIComponent(reviewId)` across
    // multiple lines for readability; we assert by checking the
    // path + reviewId interpolation independently.
    expect(PREVIEW_UI).toContain("/v1/governance/destruction-reviews/");
    expect(PREVIEW_UI).toMatch(
      /encodeURIComponent\(\s*\n?\s*reviewId,?\s*\n?\s*\)/,
    );
    expect(PREVIEW_UI).toContain("/preview?teamId=");
  });

  it("renders the blockers list with operator-readable labels", () => {
    expect(PREVIEW_UI).toContain("evidence_legal_hold");
    expect(PREVIEW_UI).toContain("case_legal_hold");
    expect(PREVIEW_UI).toContain("retention_policy_immutable");
    expect(PREVIEW_UI).toContain("already_destroyed");
  });

  it("explicitly disclaims legal admissibility", () => {
    // The disclaimer is rendered as JSX text that may be split
    // across lines by the formatter. Strip whitespace before
    // matching so we tolerate either form.
    expect(PREVIEW_UI.replace(/\s+/g, " ")).toMatch(
      /not a legal admissibility statement/,
    );
  });

  it("is read-only — never mutates state", () => {
    const code = stripComments(PREVIEW_UI);
    expect(code).not.toMatch(/method:\s*"POST"/);
    expect(code).not.toMatch(/method:\s*"PATCH"/);
    expect(code).not.toMatch(/method:\s*"DELETE"/);
  });

  it("renders empty / loading / error states", () => {
    expect(PREVIEW_UI).toContain('data-destruction-preview-empty="no-workspace"');
    expect(PREVIEW_UI).toContain("data-destruction-preview-loading");
    expect(PREVIEW_UI).toContain("data-destruction-preview-error");
  });
});

describe("Phase F — DestructionCertificate component", () => {
  it("consumes the new certificate endpoint", () => {
    expect(CERT_UI).toContain("/v1/governance/destruction-reviews/");
    expect(CERT_UI).toMatch(
      /encodeURIComponent\(\s*\n?\s*reviewId,?\s*\n?\s*\)/,
    );
    expect(CERT_UI).toContain("/certificate?teamId=");
  });

  it("renders caveats as a bounded list and downloads canonical JSON", () => {
    expect(CERT_UI).toContain("data-destruction-cert-caveat");
    expect(CERT_UI).toContain("data-destruction-cert-download");
    expect(CERT_UI).toMatch(/Blob\(\[JSON\.stringify\(/);
  });

  it("handles the 409 unavailable response with operator-safe copy", () => {
    expect(CERT_UI).toMatch(/statusCode === 409/);
    expect(CERT_UI).toMatch(/only generated once a review is EXECUTED/);
  });

  it("is read-only", () => {
    const code = stripComments(CERT_UI);
    expect(code).not.toMatch(/method:\s*"POST"/);
    expect(code).not.toMatch(/method:\s*"PATCH"/);
    expect(code).not.toMatch(/method:\s*"DELETE"/);
  });
});

describe("Phase F — RetentionInheritanceSummary component", () => {
  it("consumes the new inheritance endpoint", () => {
    expect(INHERIT_UI).toMatch(
      /\/v1\/governance\/retention\/inheritance\?teamId=/,
    );
  });

  it("renders the three deterministic sources", () => {
    expect(INHERIT_UI).toMatch(/source\s*===\s*"team_policy"/);
    expect(INHERIT_UI).toMatch(/source\s*===\s*"org_policy_inherited"/);
    expect(INHERIT_UI).toMatch(/source\s*===\s*"none"/);
  });
});

// ===========================================================================
// 7. Page mounts
// ===========================================================================

describe("Phase F — governance page integration", () => {
  it("destruction page mounts the impact-preview + certificate buttons", () => {
    expect(DESTRUCTION_PAGE).toContain("DestructionImpactPreview");
    expect(DESTRUCTION_PAGE).toContain("DestructionCertificate");
    expect(DESTRUCTION_PAGE).toContain('data-action="preview-impact"');
    expect(DESTRUCTION_PAGE).toContain('data-action="view-certificate"');
  });

  it("destruction page gates certificate button on r.status === EXECUTED", () => {
    expect(DESTRUCTION_PAGE).toMatch(
      /r\.status\s*===\s*"EXECUTED"[\s\S]{0,400}view-certificate/,
    );
  });

  it("retention page mounts the inheritance summary", () => {
    expect(RETENTION_PAGE).toContain("RetentionInheritanceSummary");
    expect(RETENTION_PAGE).toMatch(
      /<RetentionInheritanceSummary\s+teamId=\{teamId\s*\?\?\s*null\}/,
    );
  });
});

// ===========================================================================
// 8. Vocabulary discipline
// ===========================================================================

describe("Phase F — vocabulary discipline", () => {
  const surfaces: Array<{ name: string; src: string }> = [
    { name: "PreviewComponent", src: PREVIEW_UI },
    { name: "CertificateComponent", src: CERT_UI },
    { name: "InheritanceComponent", src: INHERIT_UI },
  ];

  const banned: Array<{ name: string; re: RegExp }> = [
    { name: "tampered", re: /\btampered?\b/i },
    { name: "tamper-proof", re: /\btamper-?proof\b/i },
    { name: "authentic", re: /\bauthentic\b/i },
    { name: "admissible", re: /\badmissible\b/i },
    { name: "court-ready", re: /\bcourt-?ready\b/i },
    { name: "forensic proof", re: /\bforensic\s+proof\b/i },
    { name: "legally valid", re: /\blegally\s+valid\b/i },
    { name: "cryptographic erasure proof claim", re: /\bproof of total erasure\b/i },
    { name: "compliance attestation", re: /\bcompliance attestation\b/i },
    { name: "Slack", re: /\bSlack\b/i },
    { name: "Dropbox", re: /\bDropbox\b/i },
  ];

  for (const { name, src } of surfaces) {
    for (const { name: bn, re } of banned) {
      it(`${name} contains no '${bn}' (after stripping doc comments)`, () => {
        expect(stripComments(src)).not.toMatch(re);
      });
    }
  }
});
