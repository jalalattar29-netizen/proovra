/**
 * PHASE 12 CORRECTIVE PASS §1 — ARCH-001 + LEGACY-001: ONE WORKSPACE LANGUAGE.
 *
 * The finding
 * ---------------------------------------------------------------------------
 * Two vocabularies coexisted. `WorkspaceScopeType = "PERSONAL" | "TEAM"` READ
 * like a tenancy kind, sat beside a `TEAM` PLAN, and was consumed by a flag
 * called `allowsTeamWorkspace` and errors called `TEAM_WORKSPACE_*`. A reader
 * had no way to tell whether "TEAM" meant a workspace kind, a plan, or a
 * capability bundle — and the answer was the last two, because there has never
 * been a TEAM workspace KIND.
 *
 * That ambiguity had already caused real defects: `getTeamWorkspaceScope`
 * stamped every scope `TEAM` including a user's own Personal Space, which made
 * evidence creation refuse a FREE user's own capture and gave a one-occupant
 * workspace seats to sell.
 *
 * The vocabulary now
 * ---------------------------------------------------------------------------
 *   WorkspaceKind          PERSONAL | OWNED | ORGANIZATION — TENANCY, in the
 *                          database, NOT NULL.
 *   WorkspaceBillingShape  SINGLE_OCCUPANT | SHARED — COMMERCE, derived from
 *                          the kind by ONE function, never persisted.
 *   PlanType               FREE | PAYG | PRO | TEAM | ENTERPRISE — what is
 *                          bought. TEAM lives here and nowhere else.
 *
 * WHAT THIS FILE IS
 * ---------------------------------------------------------------------------
 * The gate. Its seven NEGATIVE FIXTURES are the shapes §1.3 names, each fed to
 * the same detector the positive checks use — because a detector that has
 * never been shown to detect is the fictional control this whole exercise
 * keeps finding.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LEGACY_WORKSPACE_VOCABULARY_REMOVAL_CONDITION,
  LEGACY_WORKSPACE_VOCABULARY_VERSION,
  legacyErrorCodeFor,
  legacyVocabularyProjectionCount,
  legacyWorkspaceTypeFor,
  resetLegacyVocabularyProjectionCount,
} from "@proovra/shared";
import { billingShapeForWorkspaceKind } from "@proovra/shared-billing";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const read = (rel: string): string =>
  readFileSync(path.join(REPO, rel), "utf8");

/**
 * Roots whose RUNTIME sources must speak one language. Test files are excluded
 * deliberately: a test may legitimately name the retired vocabulary in order to
 * assert it is gone — this file does exactly that.
 */
const RUNTIME_ROOTS = [
  "services/api/src",
  "services/worker/src",
  "packages/shared/src",
  "packages/shared-billing/src",
  "packages/shared-runtime/src",
];

/**
 * Occurrences classified as PERSISTENCE: a column name the database already
 * carries on every row. §1.2 forbids blindly renaming a historically stable
 * identifier, so these keep their spelling — and are required to stay INERT,
 * which the last case below checks.
 */
const PERSISTED_LEGACY_IDENTIFIERS = [
  // EvidenceReviewWorkflow.workspace_type — a VARCHAR label written once at
  // workflow creation and read back for display. Authorizes nothing.
  "workspaceType",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(REPO, dir), {
    withFileTypes: true,
  })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * The ONE module permitted to contain the retired spellings, because
 * producing them is its entire purpose.
 *
 * Exempting it is not a hole: every OTHER property that makes it safe —
 * read-only, non-authorizing, non-persisting, metered, versioned, removable —
 * is asserted separately below, and the "no runtime module imports it" case
 * bounds who can reach it.
 */
const LEGACY_ADAPTER = "packages/shared/src/legacy-workspace-vocabulary.ts";

/**
 * The modules that read/write the PERSISTED `EvidenceReviewWorkflow
 * .workspace_type` column. Classified PERSISTENCE, so they keep the legacy
 * spelling — bounded by the "only for the persisted column" case below.
 */
const PERSISTED_COLUMN_MODULES = new Set([
  "services/api/src/services/evidence-review/reviewer-workflow.service.ts",
  "services/api/src/services/review-operations/review-operations.service.ts",
]);

const RUNTIME_SOURCES = RUNTIME_ROOTS.flatMap((r) => walk(r))
  .filter((rel) => rel !== LEGACY_ADAPTER)
  .map((rel) => ({ rel, text: read(rel) }));

/** Strip comments — prose about the old vocabulary is documentation, not use. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

// ===========================================================================
// THE DETECTOR — one implementation, used by the positive checks AND by the
// seven negative fixtures.
// ===========================================================================

export type VocabularyViolation = { kind: string; detail: string };

export function detectVocabularyViolations(
  rel: string,
  raw: string,
): VocabularyViolation[] {
  const out: VocabularyViolation[] = [];
  const src = code(raw);

  // 1. TEAM used as a workspace KIND — an enum or union placing it beside the
  //    canonical kinds.
  if (
    /\b(PERSONAL|OWNED|ORGANIZATION)\b[^;\n]{0,80}\|\s*["']TEAM["']/.test(src) ||
    /["']TEAM["'][^;\n]{0,80}\|\s*["'](OWNED|ORGANIZATION)["']/.test(src) ||
    /enum\s+\w*WorkspaceKind\w*\s*\{[^}]*\bTEAM\b/.test(src)
  ) {
    out.push({
      kind: "TEAM_AS_WORKSPACE_KIND",
      detail: `${rel}: TEAM appears as a workspace KIND. TEAM is a plan.`,
    });
  }

  // 2. A TEAM_WORKSPACE_* code in an authorization decision.
  for (const m of src.matchAll(/TEAM_WORKSPACE_[A-Z_]+/g)) {
    out.push({
      kind: "TEAM_WORKSPACE_ERROR_CODE",
      detail: `${rel}: ${m[0]} names a workspace kind that does not exist.`,
    });
  }

  // 3. `allowsTeamWorkspace` granting anything.
  if (/\ballowsTeamWorkspace\b/.test(src)) {
    out.push({
      kind: "ALLOWS_TEAM_WORKSPACE",
      detail: `${rel}: allowsTeamWorkspace is the retired spelling of allowsSharedWorkspace.`,
    });
  }

  // 4. A PLAN choosing a workspace type or kind.
  if (
    /plan\s*===\s*["']TEAM["']\s*\?\s*["'](TEAM|SHARED|ORGANIZATION|OWNED)["']/.test(src) ||
    /billingPlan\s*===\s*["']ENTERPRISE["']\s*\?\s*["']ORGANIZATION["']/.test(src)
  ) {
    out.push({
      kind: "PLAN_DERIVED_WORKSPACE_KIND",
      detail: `${rel}: a commercial plan is deciding a tenancy fact.`,
    });
  }

  // 5. A client fallback interpreting an unknown workspace as TEAM.
  if (
    /\?\?\s*["']TEAM["']/.test(src) ||
    /\|\|\s*["']TEAM["']/.test(src) ||
    /:\s*["']TEAM["']\s*\/\/\s*fallback/i.test(src)
  ) {
    out.push({
      kind: "UNKNOWN_WORKSPACE_DEFAULTS_TO_TEAM",
      detail: `${rel}: an unknown workspace defaults to TEAM instead of failing closed.`,
    });
  }

  // 6/7. The compatibility adapter used to WRITE or to AUTHORIZE.
  if (/legacyWorkspaceTypeFor|legacyErrorCodeFor|legacyWorkspaceVocabularyEnvelope/.test(src)) {
    if (/\.(create|update|updateMany|upsert|createMany)\s*\(/.test(src)) {
      out.push({
        kind: "COMPAT_ADAPTER_IN_A_WRITE",
        detail: `${rel}: the legacy adapter appears in a module that persists.`,
      });
    }
    if (/authoriz|checkOrgAccess|evaluateAccess|requirePermission/i.test(src)) {
      out.push({
        kind: "COMPAT_ADAPTER_IN_AUTHORIZATION",
        detail: `${rel}: the legacy adapter appears in an authorization path.`,
      });
    }
  }

  return out;
}

// ===========================================================================
// NEGATIVE FIXTURES — §1.3's seven shapes. Each MUST be detected.
// ===========================================================================

const NEGATIVE_FIXTURES: ReadonlyArray<{
  name: string;
  expect: string;
  source: string;
}> = [
  {
    name: "enum TEAM used as a Workspace kind",
    expect: "TEAM_AS_WORKSPACE_KIND",
    source: `export type Kind = "PERSONAL" | "OWNED" | "TEAM";`,
  },
  {
    name: "TEAM_WORKSPACE error code in an authorization decision",
    expect: "TEAM_WORKSPACE_ERROR_CODE",
    source: `if (!allowed) { err.code = "TEAM_WORKSPACE_FORBIDDEN"; throw err; }`,
  },
  {
    name: "allowsTeamWorkspace granting access",
    expect: "ALLOWS_TEAM_WORKSPACE",
    source: `if (!caps.allowsTeamWorkspace) return deny();`,
  },
  {
    name: "plan === TEAM choosing the workspace type",
    expect: "PLAN_DERIVED_WORKSPACE_KIND",
    source: `const shape = plan === "TEAM" ? "SHARED" : "SINGLE_OCCUPANT";`,
  },
  {
    name: "client fallback interpreting an unknown workspace as TEAM",
    expect: "UNKNOWN_WORKSPACE_DEFAULTS_TO_TEAM",
    source: `const kind = response.workspaceKind ?? "TEAM";`,
  },
  {
    name: "compatibility adapter used in a write",
    expect: "COMPAT_ADAPTER_IN_A_WRITE",
    source: `const legacy = legacyWorkspaceTypeFor(shape); await prisma.team.update({ data: { legacy } });`,
  },
  {
    name: "compatibility adapter used to authorize",
    expect: "COMPAT_ADAPTER_IN_AUTHORIZATION",
    source: `const legacy = legacyErrorCodeFor(code); if (legacy === "X") return authorizeOrFail(req);`,
  },
];

describe("§1 — ARCH-001 + LEGACY-001: the detector detects", () => {
  for (const fixture of NEGATIVE_FIXTURES) {
    it(`REJECTS: ${fixture.name}`, () => {
      const found = detectVocabularyViolations("fixture.ts", fixture.source);
      expect(
        found.map((f) => f.kind),
        `the detector must flag ${fixture.expect}`,
      ).toContain(fixture.expect);
    });
  }

  it("ACCEPTS the canonical vocabulary", () => {
    const clean = `
      export type WorkspaceKind = "PERSONAL" | "OWNED" | "ORGANIZATION";
      const shape = billingShapeForWorkspaceKind(kind);
      if (!caps.allowsSharedWorkspace) { err.code = "PLAN_NOT_ALLOWED_FOR_SHARED_WORKSPACE"; }
    `;
    expect(detectVocabularyViolations("clean.ts", clean)).toEqual([]);
  });
});

describe("§1 — the runtime speaks one language", () => {
  it("TeamWorkspaceRuntimeConcepts = 0", () => {
    const violations = RUNTIME_SOURCES.filter(
      ({ rel }) => !PERSISTED_COLUMN_MODULES.has(rel),
    ).flatMap(({ rel, text }) => detectVocabularyViolations(rel, text));
    expect(
      violations.map((v) => v.detail),
      `retired workspace vocabulary in runtime sources:\n${violations
        .map((v) => v.detail)
        .join("\n")}`,
    ).toEqual([]);
  });

  /**
   * The exemption above is narrow and this case is what keeps it narrow.
   *
   * Two modules read and write `EvidenceReviewWorkflow.workspace_type`, a
   * persisted VARCHAR carrying "PERSONAL"/"TEAM" on every existing row. §1.2
   * forbids blindly renaming a historically stable identifier, so they keep
   * the old words — but ONLY for that column. Every legacy literal in them
   * must sit within a few lines of the column name; a "TEAM" that has drifted
   * away from it is a new concept wearing an exemption.
   */
  it("the exempted modules use the legacy words ONLY for the persisted column", () => {
    const strays: string[] = [];
    for (const rel of PERSISTED_COLUMN_MODULES) {
      const lines = code(read(rel)).split("\n");
      lines.forEach((line, i) => {
        if (!/["'](PERSONAL|TEAM)["']/.test(line)) return;
        const window = lines.slice(Math.max(0, i - 4), i + 5).join("\n");
        if (!/workspaceType|workspace_type/.test(window)) {
          strays.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
        }
      });
    }
    expect(
      strays,
      `a legacy literal not attached to the persisted column:\n${strays.join("\n")}`,
    ).toEqual([]);
  });

  it("ParallelWorkspaceVocabularyAuthorities = 0 — one derivation, one place", () => {
    const derivers = RUNTIME_SOURCES.filter(({ rel, text }) => {
      if (rel === "packages/shared-billing/src/workspace.ts") return false;
      const src = code(text);
      // Any OTHER module mapping a kind to a shape by hand.
      return /["'](PERSONAL)["']\s*\?\s*["']SINGLE_OCCUPANT["']/.test(src);
    });
    expect(
      derivers.map((d) => d.rel),
      "tenancy becomes commerce in exactly one function",
    ).toEqual([]);

    // …and that function is total and correct.
    expect(billingShapeForWorkspaceKind("PERSONAL")).toBe("SINGLE_OCCUPANT");
    expect(billingShapeForWorkspaceKind("OWNED")).toBe("SHARED");
    expect(billingShapeForWorkspaceKind("ORGANIZATION")).toBe("SHARED");
  });

  it("PlanDerivedWorkspaceKinds = 0", () => {
    const offenders = RUNTIME_SOURCES.flatMap(({ rel, text }) =>
      detectVocabularyViolations(rel, text).filter(
        (v) => v.kind === "PLAN_DERIVED_WORKSPACE_KIND",
      ),
    );
    expect(offenders.map((o) => o.detail)).toEqual([]);
  });
});

describe("§1 — the compatibility adapter is bounded", () => {
  it("is READ-ONLY: there is no legacy → canonical direction", () => {
    const src = read("packages/shared/src/legacy-workspace-vocabulary.ts");
    expect(src).not.toMatch(/export function legacy\w*To(Canonical|Shape|Kind)/);
    expect(src).not.toMatch(/canonicalWorkspaceTypeFor/);
    // A request can never enter the system speaking the old language.
    expect(src).toMatch(/ONE DIRECTION ONLY/);
  });

  it("is NON-AUTHORIZING and NON-PERSISTING", () => {
    const src = code(read("packages/shared/src/legacy-workspace-vocabulary.ts"));
    expect(src).not.toMatch(/prisma|PrismaClient|\.create\(|\.update\(/);
    expect(src).not.toMatch(/authoriz|permission|actorUserId|workspaceId/i);
  });

  it("is VERSIONED and states its REMOVAL CONDITION", () => {
    expect(LEGACY_WORKSPACE_VOCABULARY_VERSION).toBe(1);
    expect(LEGACY_WORKSPACE_VOCABULARY_REMOVAL_CONDITION).toMatch(
      /zero across a full release observation window/,
    );
  });

  it("is METERED — every projection is counted", () => {
    resetLegacyVocabularyProjectionCount();
    expect(legacyVocabularyProjectionCount()).toBe(0);

    expect(legacyWorkspaceTypeFor("SINGLE_OCCUPANT")).toBe("PERSONAL");
    expect(legacyWorkspaceTypeFor("SHARED")).toBe("TEAM");
    expect(legacyErrorCodeFor("SHARED_WORKSPACE_LIMIT_REACHED")).toBe(
      "TEAM_WORKSPACE_LIMIT_REACHED",
    );
    expect(legacyVocabularyProjectionCount()).toBe(3);

    // An unmapped code passes through and is NOT counted — inventing a legacy
    // spelling for a code that never had one would manufacture a problem.
    resetLegacyVocabularyProjectionCount();
    expect(legacyErrorCodeFor("SOMETHING_ELSE")).toBe("SOMETHING_ELSE");
    expect(legacyVocabularyProjectionCount()).toBe(0);
  });

  it("no runtime module imports the adapter yet", () => {
    // It exists for a client that needs it; nothing on the server does today.
    // If that changes, the importing module must be classified here first.
    const importers = RUNTIME_SOURCES.filter(({ text }) =>
      /legacy-workspace-vocabulary|legacyWorkspaceTypeFor|legacyErrorCodeFor/.test(
        code(text),
      ),
    ).map((s) => s.rel);
    expect(
      importers.filter((r) => r !== "packages/shared/src/index.ts"),
      "an unclassified consumer of the legacy adapter",
    ).toEqual([]);
  });
});

// ===========================================================================
// ARCH-003 — the context gate. Extends this file rather than adding another,
// because it asks the same question about the same vocabulary: does one field
// carry one meaning?
// ===========================================================================

describe("§1 — ARCH-003: the platform context is versioned and unambiguous", () => {
  const TYPES = read("services/api/src/services/platform-context/types.ts");
  const BUILDER = read(
    "services/api/src/services/platform-context/platform-context.service.ts",
  );

  it("the canonical envelope declares every required field", () => {
    const block = /export type CanonicalPlatformContext = \{[\s\S]*?\n\};/.exec(
      TYPES,
    );
    expect(block, "CanonicalPlatformContext must exist").toBeTruthy();
    for (const field of [
      "contextVersion",
      "account",
      "personalSpace",
      "ownedWorkspaces",
      "organizations",
      "organizationMemberships",
      "organizationWorkspaces",
      "currentWorkspace",
      "currentOrganization",
      "capabilities",
      "commercialContext",
    ]) {
      expect(block![0], `${field} must be declared`).toMatch(
        new RegExp(`^\\s*${field}[?]?:`, "m"),
      );
    }
  });

  it("WorkspaceIdsInOrganizationFields = 0 — the types keep the id spaces apart", () => {
    const org = /export type CanonicalContextOrganization = \{[\s\S]*?\n\};/.exec(
      TYPES,
    )![0];
    // An Organization carries no workspace id and no workspace member count —
    // the legacy field carried both, which IS the finding.
    expect(org).toMatch(/organizationId: string;/);
    expect(org).not.toMatch(/\bworkspaceId\b/);
    expect(org).not.toMatch(/\bmemberCount\b/);
    expect(org).not.toMatch(/\bteamId\b/);

    const ws = /export type CanonicalContextWorkspace = \{[\s\S]*?\n\};/.exec(
      TYPES,
    )![0];
    expect(ws).toMatch(/workspaceId: string;/);
    // A workspace MAY name its Organization — that is a relation, not an
    // overload — but it must never be called an organization itself.
    expect(ws).not.toMatch(/^\s*id: string;/m);
  });

  it("ContextFieldsWithMultipleMeanings = 0 — membership id spaces are named apart", () => {
    expect(TYPES).toMatch(/organizationMembershipId: string;/);
    expect(TYPES).toMatch(/workspaceMembershipId: string \| null;/);
    const orgMembership =
      /export type CanonicalContextOrganizationMembership = \{[\s\S]*?\n\};/.exec(
        TYPES,
      )![0];
    expect(
      orgMembership,
      "a governance membership must not also carry a workspace membership id",
    ).not.toMatch(/workspaceMembershipId/);
  });

  it("ClientContextAuthorities = 0 — the builder trusts no client id", () => {
    // The builder's ONLY input is the authenticated user id and a request id.
    const input = /export type BuildPlatformContextInput = \{[\s\S]*?\n\};/.exec(
      BUILDER,
    )!;
    expect(input[0]).toMatch(/userId: string;/);
    expect(
      input[0],
      "a client-supplied workspace or organization id must never reach the builder",
    ).not.toMatch(/workspaceId|organizationId|teamId/);
  });

  it("StaleContextPrivilegeEscapes = 0 — the repair is reported, and bounded", () => {
    expect(TYPES).toMatch(
      /currentWorkspaceSource: "POINTER" \| "REPAIRED_TO_PERSONAL" \| "NONE";/,
    );
    // The healed target is looked up among workspaces already proven enterable,
    // so a repair can never widen the set.
    expect(BUILDER).toMatch(
      /canonicalCurrentWorkspace[\s\S]{0,400}?\[canonicalPersonal, \.\.\.canonicalOwned, \.\.\.canonicalOrgWorkspaces\]/,
    );
    // …and the source is derived from the POINTER, not asserted.
    expect(BUILDER).toMatch(
      /userRow\.currentWorkspaceId === canonicalCurrentWorkspace\.workspaceId/,
    );
  });

  it("the canonical governance read is ACTIVE-only and CUSTOMER-only", () => {
    const query =
      /const govRows = await prisma\.organizationMembership\.findMany\(\{[\s\S]*?\}\);/.exec(
        BUILDER,
      );
    expect(query, "the canonical governance read must exist").toBeTruthy();
    expect(query![0]).toMatch(/status: "ACTIVE"/);
    expect(
      query![0],
      "a SYSTEM container is not an Organization the user belongs to",
    ).toMatch(/kind: "CUSTOMER"/);
  });

  it("the legacy `organizations` field is deprecated with a removal condition", () => {
    const envelope = /export type PlatformContextEnvelope = \{[\s\S]*?\n\};/.exec(
      TYPES,
    )![0];
    const legacy = envelope.slice(
      envelope.indexOf("ARCH-003"),
      envelope.indexOf("canonical: CanonicalPlatformContext;"),
    );
    expect(legacy).toMatch(/@deprecated/);
    expect(legacy).toMatch(/REMOVAL CONDITION/);
  });
});

describe("§1 — the persisted identifier is classified and INERT", () => {
  it("EvidenceReviewWorkflow.workspaceType is documented as persistence", () => {
    const schema = read("services/api/prisma/schema.prisma");
    const model = /model EvidenceReviewWorkflow \{[\s\S]*?\n\}/.exec(schema)![0];
    expect(model).toMatch(/workspaceType\s+String/);
    expect(
      model,
      "a retained legacy identifier must say WHY it is retained",
    ).toMatch(/CLASSIFIED AS\s*\n\s*\*\s*PERSISTENCE|classified PERSISTENCE|CLASSIFIED AS/i);
  });

  it("it authorizes nothing, selects no tenant and grants no entitlement", () => {
    const offenders: string[] = [];
    for (const { rel, text } of RUNTIME_SOURCES) {
      const src = code(text);
      for (const ident of PERSISTED_LEGACY_IDENTIFIERS) {
        // The retained identifier must never appear in a decision.
        const decisionShapes = new RegExp(
          `${ident}\\s*(===|!==)\\s*["'][A-Z_]+["'][^\\n]{0,60}(deny|forbid|throw|authoriz|permission|entitle)`,
          "i",
        );
        if (decisionShapes.test(src)) {
          offenders.push(`${rel}: ${ident} participates in a decision`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
