/**
 * Track 1B — Case ↔ Evidence relationship CANONICAL AUTHORITY (closure).
 *
 * Part 1 — behavioral matrix (mocked prisma transport, REAL service):
 *   * attach success → link row created + relationship audit emitted,
 *     atomically. NO evidence-row write of any kind (writers = 0);
 *   * idempotent re-attach → no-op success, ZERO mutation;
 *   * duplicate ACTIVE link denied → a second row is never created,
 *     even when a different role is requested;
 *   * cross-workspace attach denied (anti-enumeration) → ZERO mutation;
 *   * detach idempotent → nothing bound = no-op success, ZERO mutation;
 *   * detach success → link removed + audit; teamId reset only when the
 *     caller opts in AND no link to another case remains;
 *   * zero mutation on every denial.
 *
 * Part 2 — authority guard (grep-level): the legacy Evidence.caseId
 * column is GONE (migration 20271105000000_evidence_case_id_removal).
 *   * ZERO evidence-query blocks anywhere under src contain a `caseId`
 *     token (reads AND writes — where / select / orderBy / groupBy /
 *     data alike). No canonical exemption: the link table is the ONE
 *     truth and nothing reads or writes a scalar mirror.
 *   * schema.prisma's Evidence model contains no caseId scalar line.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory prisma transport
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => ({
  cases: new Map<string, { id: string; teamId: string | null }>(),
  evidence: new Map<
    string,
    { id: string; teamId: string | null; deletedAt: Date | null }
  >(),
  links: [] as Array<{
    id: string;
    teamId: string | null;
    caseId: string;
    evidenceId: string;
    role: string;
    source: string;
    linkedByUserId: string | null;
    linkedAtUtc: Date;
    reason: string | null;
  }>,
  mutations: 0,
  evidenceWrites: 0,
  audits: [] as Array<{ action: string; outcome: string; metadata: Record<string, unknown> }>,
  linkSeq: 0,
}));

vi.mock("../src/services/audit/tenant-audit.service.js", () => ({
  emitTenantAudit: async (env: {
    action: string;
    outcome: string;
    metadata?: Record<string, unknown>;
  }) => {
    H.audits.push({
      action: env.action,
      outcome: env.outcome,
      metadata: env.metadata ?? {},
    });
  },
}));

vi.mock("../src/db.js", () => {
  const matchesLinkWhere = (
    l: (typeof H.links)[number],
    where: {
      caseId?: string;
      evidenceId?: string;
      NOT?: { caseId?: string };
    },
  ) => {
    if (where.caseId !== undefined && l.caseId !== where.caseId) return false;
    if (where.evidenceId !== undefined && l.evidenceId !== where.evidenceId) return false;
    if (where.NOT?.caseId !== undefined && l.caseId === where.NOT.caseId) return false;
    return true;
  };

  const client = {
    case: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        H.cases.get(where.id) ?? null,
    },
    evidence: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        H.evidence.get(where.id) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = H.evidence.get(where.id);
        if (!row) throw new Error("NotFound");
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { teamId?: string | null };
      }) => {
        const row = H.evidence.get(where.id);
        if (!row) throw new Error("NotFound");
        if ("teamId" in data) row.teamId = data.teamId ?? null;
        H.mutations += 1;
        H.evidenceWrites += 1;
        return row;
      },
      updateMany: async () => {
        H.mutations += 1;
        H.evidenceWrites += 1;
        return { count: 0 };
      },
    },
    caseEvidenceLink: {
      findFirst: async ({
        where,
      }: {
        where: { caseId?: string; evidenceId?: string; NOT?: { caseId?: string } };
        orderBy?: unknown;
        select?: unknown;
      }) => {
        const found = [...H.links]
          .sort((a, b) => b.linkedAtUtc.getTime() - a.linkedAtUtc.getTime())
          .find((l) => matchesLinkWhere(l, where));
        return found ?? null;
      },
      findMany: async ({
        where,
      }: {
        where: { caseId?: string; evidenceId?: string };
        select?: unknown;
      }) => H.links.filter((l) => matchesLinkWhere(l, where)),
      create: async ({
        data,
      }: {
        data: Omit<
          (typeof H.links)[number],
          "id" | "linkedAtUtc"
        > & { linkedAtUtc?: Date };
      }) => {
        H.linkSeq += 1;
        const row = {
          id: `link-${H.linkSeq}`,
          linkedAtUtc: new Date(2026, 0, H.linkSeq),
          ...data,
          linkedByUserId: data.linkedByUserId ?? null,
          reason: data.reason ?? null,
        };
        H.links.push(row);
        H.mutations += 1;
        return row;
      },
      deleteMany: async ({
        where,
      }: {
        where: { caseId?: string; evidenceId?: string };
      }) => {
        const before = H.links.length;
        const keep = H.links.filter((l) => !matchesLinkWhere(l, where));
        const count = before - keep.length;
        H.links.length = 0;
        H.links.push(...keep);
        H.mutations += 1;
        return { count };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };
  return { prisma: client };
});

import {
  attachEvidenceToCase,
  detachEvidenceFromCase,
  detachAllEvidenceFromCase,
  CaseEvidenceAuthorityError,
} from "../src/services/cases/case-evidence-link.service.js";

const TEAM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CASE_TEAM = "11111111-1111-4111-8111-111111111111";
const CASE_TEAM_2 = "22222222-2222-4222-8222-222222222222";
const CASE_PERSONAL = "33333333-3333-4333-8333-333333333333";
const EV_TEAM = "44444444-4444-4444-8444-444444444444";
const EV_PERSONAL = "55555555-5555-4555-8555-555555555555";
const ACTOR = "99999999-9999-4999-8999-999999999999";

function seed(input?: {
  evidenceTeamId?: string | null;
  evidenceDeleted?: boolean;
  links?: Array<{ caseId: string; evidenceId: string; role?: string }>;
}) {
  H.cases.clear();
  H.evidence.clear();
  H.links.length = 0;
  H.audits.length = 0;
  H.mutations = 0;
  H.evidenceWrites = 0;
  H.linkSeq = 0;
  H.cases.set(CASE_TEAM, { id: CASE_TEAM, teamId: TEAM_A });
  H.cases.set(CASE_TEAM_2, { id: CASE_TEAM_2, teamId: TEAM_A });
  H.cases.set(CASE_PERSONAL, { id: CASE_PERSONAL, teamId: null });
  H.evidence.set(EV_TEAM, {
    id: EV_TEAM,
    teamId: input?.evidenceTeamId !== undefined ? input.evidenceTeamId : TEAM_A,
    deletedAt: input?.evidenceDeleted ? new Date() : null,
  });
  H.evidence.set(EV_PERSONAL, {
    id: EV_PERSONAL,
    teamId: null,
    deletedAt: null,
  });
  for (const l of input?.links ?? []) {
    H.linkSeq += 1;
    H.links.push({
      id: `seed-${H.linkSeq}`,
      teamId: H.cases.get(l.caseId)?.teamId ?? null,
      caseId: l.caseId,
      evidenceId: l.evidenceId,
      role: l.role ?? "PRIMARY",
      source: "USER",
      linkedByUserId: null,
      linkedAtUtc: new Date(2025, 0, H.linkSeq),
      reason: null,
    });
  }
}

beforeEach(() => seed());

// ---------------------------------------------------------------------------
// Part 1 — behavioral matrix (link-only contract; NO mirror writes)
// ---------------------------------------------------------------------------

describe("Track 1B — attach matrix", () => {
  it("attach success: link created + relationship audit emitted; NO evidence-row write", async () => {
    const result = await attachEvidenceToCase({
      caseId: CASE_TEAM,
      evidenceId: EV_TEAM,
      actorUserId: ACTOR,
    });
    expect(result.created).toBe(true);
    expect(H.links).toHaveLength(1);
    expect(H.links[0]).toMatchObject({
      caseId: CASE_TEAM,
      evidenceId: EV_TEAM,
      teamId: TEAM_A,
      linkedByUserId: ACTOR,
    });
    // Writers = 0: attach never touches the Evidence row.
    expect(H.evidenceWrites).toBe(0);
    // Relationship custody/audit record emitted.
    expect(H.audits).toHaveLength(1);
    expect(H.audits[0].action).toBe("cases.evidence_linked");
    expect(H.audits[0].outcome).toBe("success");
  });

  it("attach success on a PERSONAL case: link row carries teamId null", async () => {
    const result = await attachEvidenceToCase({
      caseId: CASE_PERSONAL,
      evidenceId: EV_PERSONAL,
      actorUserId: ACTOR,
    });
    expect(result.created).toBe(true);
    expect(H.links[0].teamId).toBeNull();
    expect(H.evidenceWrites).toBe(0);
  });

  it("idempotent re-attach: linked pair is a no-op success with ZERO mutation", async () => {
    seed({ links: [{ caseId: CASE_TEAM, evidenceId: EV_TEAM }] });
    const result = await attachEvidenceToCase({
      caseId: CASE_TEAM,
      evidenceId: EV_TEAM,
      actorUserId: ACTOR,
    });
    expect(result.created).toBe(false);
    expect(H.links).toHaveLength(1);
    expect(H.mutations).toBe(0);
    expect(H.audits).toHaveLength(0);
  });

  it("duplicate ACTIVE link denied: a different role never creates a second row", async () => {
    seed({ links: [{ caseId: CASE_TEAM, evidenceId: EV_TEAM, role: "SUPPORTING" }] });
    const result = await attachEvidenceToCase({
      caseId: CASE_TEAM,
      evidenceId: EV_TEAM,
      actorUserId: ACTOR,
      role: "PRIMARY",
    });
    expect(result.created).toBe(false);
    expect(H.links).toHaveLength(1);
    expect(H.links[0].role).toBe("SUPPORTING");
    expect(H.mutations).toBe(0);
  });

  it("cross-workspace attach denied (team evidence → other-team case): ZERO mutation", async () => {
    seed({ evidenceTeamId: TEAM_B });
    await expect(
      attachEvidenceToCase({
        caseId: CASE_TEAM,
        evidenceId: EV_TEAM,
        actorUserId: ACTOR,
      }),
    ).rejects.toMatchObject({ code: "cross_workspace_denied" });
    expect(H.links).toHaveLength(0);
    expect(H.mutations).toBe(0);
    expect(H.audits).toHaveLength(0);
  });

  it("cross-workspace attach denied (team evidence → personal case): ZERO mutation", async () => {
    await expect(
      attachEvidenceToCase({
        caseId: CASE_PERSONAL,
        evidenceId: EV_TEAM,
        actorUserId: ACTOR,
      }),
    ).rejects.toBeInstanceOf(CaseEvidenceAuthorityError);
    expect(H.links).toHaveLength(0);
    expect(H.mutations).toBe(0);
  });

  it("deleted evidence denied: ZERO mutation", async () => {
    seed({ evidenceDeleted: true });
    await expect(
      attachEvidenceToCase({
        caseId: CASE_TEAM,
        evidenceId: EV_TEAM,
        actorUserId: ACTOR,
      }),
    ).rejects.toMatchObject({ code: "evidence_deleted" });
    expect(H.mutations).toBe(0);
  });

  it("unknown case / unknown evidence deny with ZERO mutation", async () => {
    await expect(
      attachEvidenceToCase({
        caseId: "00000000-0000-4000-8000-000000000000",
        evidenceId: EV_TEAM,
        actorUserId: ACTOR,
      }),
    ).rejects.toMatchObject({ code: "case_not_found" });
    await expect(
      attachEvidenceToCase({
        caseId: CASE_TEAM,
        evidenceId: "00000000-0000-4000-8000-000000000001",
        actorUserId: ACTOR,
      }),
    ).rejects.toMatchObject({ code: "evidence_not_found" });
    expect(H.mutations).toBe(0);
  });
});

describe("Track 1B — detach matrix", () => {
  it("detach success: link removed + audit emitted (teamId reset honoured on last link)", async () => {
    seed({ links: [{ caseId: CASE_TEAM, evidenceId: EV_TEAM }] });
    const result = await detachEvidenceFromCase({
      caseId: CASE_TEAM,
      evidenceId: EV_TEAM,
      actorUserId: ACTOR,
      clearEvidenceTeamIdWhenUnlinked: true,
    });
    expect(result.detached).toBe(true);
    expect(result.removedLinkCount).toBe(1);
    expect(H.links).toHaveLength(0);
    expect(H.evidence.get(EV_TEAM)?.teamId).toBeNull();
    expect(H.audits).toHaveLength(1);
    expect(H.audits[0].action).toBe("cases.evidence_unlinked");
  });

  it("detach without opt-in leaves teamId untouched (no evidence write)", async () => {
    seed({ links: [{ caseId: CASE_TEAM, evidenceId: EV_TEAM }] });
    const result = await detachEvidenceFromCase({
      caseId: CASE_TEAM,
      evidenceId: EV_TEAM,
      actorUserId: ACTOR,
    });
    expect(result.detached).toBe(true);
    expect(H.evidence.get(EV_TEAM)?.teamId).toBe(TEAM_A);
    expect(H.evidenceWrites).toBe(0);
  });

  it("detach idempotent: nothing bound = no-op success, ZERO mutation", async () => {
    const result = await detachEvidenceFromCase({
      caseId: CASE_TEAM,
      evidenceId: EV_TEAM,
      actorUserId: ACTOR,
    });
    expect(result.detached).toBe(false);
    expect(result.removedLinkCount).toBe(0);
    expect(H.mutations).toBe(0);
    expect(H.audits).toHaveLength(0);
  });

  it("multi-linked evidence: teamId is NOT reset while another case still links the record", async () => {
    seed({
      links: [
        { caseId: CASE_TEAM, evidenceId: EV_TEAM },
        { caseId: CASE_TEAM_2, evidenceId: EV_TEAM },
      ],
    });
    const result = await detachEvidenceFromCase({
      caseId: CASE_TEAM,
      evidenceId: EV_TEAM,
      actorUserId: ACTOR,
      clearEvidenceTeamIdWhenUnlinked: true,
    });
    expect(result.detached).toBe(true);
    expect(H.evidence.get(EV_TEAM)?.teamId).toBe(TEAM_A);
    expect(H.links).toHaveLength(1);
    expect(H.links[0].caseId).toBe(CASE_TEAM_2);
  });

  it("detachAllEvidenceFromCase removes every link (case deletion); link table is the only truth", async () => {
    seed({ links: [{ caseId: CASE_TEAM, evidenceId: EV_TEAM }] });
    const result = await detachAllEvidenceFromCase({
      caseId: CASE_TEAM,
      actorUserId: ACTOR,
      reason: "case_deleted",
    });
    expect(result.removedLinkCount).toBe(1);
    expect(H.links).toHaveLength(0);
    expect(H.evidenceWrites).toBe(0);
    expect(H.audits[0].action).toBe("cases.evidence_unlinked_all");
  });
});

// ---------------------------------------------------------------------------
// Part 2 — authority guard: the legacy scalar is GONE. ZERO evidence-query
// blocks under src contain a `caseId` token (reads AND writes). No
// canonical exemption. Schema Evidence model carries no caseId scalar.
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".ts"))
    .map((d) => join(d.parentPath ?? (d as unknown as { path: string }).path, d.name));
}

/** Extracts the balanced-paren argument block starting at `openIdx` ("("). */
function balancedBlock(src: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < Math.min(src.length, openIdx + 12000); i += 1) {
    const ch = src[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return src.slice(openIdx, openIdx + 12000);
}

/**
 * Removes every `caseLinks: { ... }` object (brace-balanced) from a
 * block. Relation traversals through the canonical link table are the
 * SANCTIONED read path — `caseId` keys inside them refer to the link
 * row's own column, never to a scalar on Evidence.
 */
function stripCaseLinkTraversals(block: string): string {
  let out = block;
  for (;;) {
    const m = /caseLinks\s*:\s*\{/.exec(out);
    if (!m) return out;
    const start = m.index;
    let depth = 0;
    let end = out.length;
    for (let i = out.indexOf("{", start); i < out.length; i += 1) {
      const ch = out[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    out = out.slice(0, start) + out.slice(end);
  }
}

const EVIDENCE_QUERY_RE =
  /\.evidence\.(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|count|groupBy|aggregate|update|updateMany|create|createMany|upsert|delete|deleteMany)\s*\(/g;

describe("Track 1B closure — authority guard (Evidence.caseId readers = 0, writers = 0)", () => {
  it("NO evidence-query block anywhere under src contains a caseId token (reads AND writes; no exemption)", () => {
    const files = listTsFiles(join(ROOT, "src"));
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file);
      const src = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      EVIDENCE_QUERY_RE.lastIndex = 0;
      while ((m = EVIDENCE_QUERY_RE.exec(src)) !== null) {
        const openIdx = src.indexOf("(", m.index + m[0].length - 1);
        const block = stripCaseLinkTraversals(balancedBlock(src, openIdx));
        if (/\bcaseId\b/.test(block)) {
          const line = src.slice(0, m.index).split("\n").length;
          offenders.push(
            `${rel.split(sep).join("/")}:${line} :: evidence.${m[1]}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("schema.prisma Evidence model contains no caseId scalar line", () => {
    const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
    const start = schema.indexOf("model Evidence {");
    expect(start).toBeGreaterThan(-1);
    // The model body ends at the first closing brace at column 0.
    const end = schema.indexOf("\n}", start);
    const body = schema.slice(start, end);
    // No scalar column line like `caseId String? @map("case_id")`.
    expect(body).not.toMatch(/^\s*caseId\s+String/m);
    expect(body).not.toMatch(/@map\("case_id"\)/);
    // The canonical relation is present instead.
    expect(body).toMatch(/caseLinks\s+CaseEvidenceLink\[\]/);
  });

  it("the canonical service performs NO evidence caseId write (link-only truth)", () => {
    const src = readFileSync(
      join(ROOT, "src", "services", "cases", "case-evidence-link.service.ts"),
      "utf8",
    );
    // The service still audits and gates cross-workspace attach…
    expect(src).toMatch(/emitTenantAudit\(/);
    expect(src).toMatch(/evaluateCrossTeamAttach\(/);
    // …but never mirrors relationship state onto the Evidence row.
    // (The only permitted evidence.update is the opt-in teamId reset on
    // final detach, which must not carry a caseId key.)
    let m: RegExpExecArray | null;
    const re = /\.evidence\.(update|updateMany)\s*\(/g;
    while ((m = re.exec(src)) !== null) {
      const openIdx = src.indexOf("(", m.index + m[0].length - 1);
      const block = balancedBlock(src, openIdx);
      expect(block).not.toMatch(/\bcaseId\b/);
    }
    // The drop migration exists and is forward-only.
    const migration = readFileSync(
      join(
        ROOT,
        "prisma",
        "migrations",
        "20271105000000_evidence_case_id_removal",
        "migration.sql",
      ),
      "utf8",
    );
    expect(migration).toMatch(/DROP COLUMN case_id/);
    expect(migration).toMatch(/20271103000000/);
  });
});
