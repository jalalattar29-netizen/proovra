/**
 * PRO-W1C-02 (WS-OUT RG-18) — an exchange package states lifecycle facts about
 * ITS SELECTION only. Behavioural: buildLifecycleAndExchangeManifests runs
 * against an in-memory workspace holding rows for selected AND unselected
 * records (another record's hold, another package, a transfer to a
 * counterparty) and the files it returns are read back.
 *
 *   * allowed: a hold / archive move / destruction request naming a selected
 *     record is stated, with its real state;
 *   * refused: rows about unselected records, other exchange packages and
 *     chain transfers (counterparties) never appear;
 *   * no row for a family = no file, never a placeholder state.
 */
import { describe, expect, it } from "vitest";

import { buildLifecycleAndExchangeManifests } from "../src/verification-package-lifecycle.js";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SELECTED = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

type Row = Record<string, unknown>;

/** Minimal where-matcher for the shapes the builder uses (equality + `in`). */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (cond && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date)) {
      const c = cond as Row;
      if (Array.isArray(c.in)) return (c.in as unknown[]).includes(row[k]);
      return true;
    }
    return row[k] === cond;
  });
}

function fakePrisma(tables: Record<string, Row[]>) {
  const model = (name: string) => {
    const rows = () => tables[name] ?? [];
    return {
      findMany: async (a: { where?: Row; take?: number } = {}) =>
        rows().filter((r) => matches(r, a.where)).slice(0, a.take ?? 1000),
      findFirst: async (a: { where?: Row } = {}) => rows().find((r) => matches(r, a.where)) ?? null,
      count: async (a: { where?: Row } = {}) => rows().filter((r) => matches(r, a.where)).length,
    };
  };
  return new Proxy({}, { get: (_t, k) => (typeof k === "string" ? model(k) : undefined) }) as never;
}

const at = new Date("2026-11-01T10:00:00.000Z");

function workspace() {
  return fakePrisma({
    evidenceLegalHold: [
      // Newest row in the workspace is about ANOTHER record.
      { id: "hold-other", teamId: TEAM, scope: "EVIDENCE", status: "ACTIVE", evidenceId: OTHER, createdAt: new Date("2026-11-05T00:00:00Z"), releasedAtUtc: null },
      { id: "hold-sel", teamId: TEAM, scope: "EVIDENCE", status: "RELEASED", evidenceId: SELECTED, createdAt: at, releasedAtUtc: at },
    ],
    archiveTierTransition: [
      { teamId: TEAM, evidenceId: OTHER, fromTier: "HOT", toTier: "COLD", transitionedAtUtc: new Date("2026-11-05T00:00:00Z"), costEstimateUsdMicros: 5 },
    ],
    destructionRequest: [
      { id: "destr-other", teamId: TEAM, state: "REQUESTED", evidenceIds: [OTHER], certifiedAtUtc: null },
    ],
    destructionCertificate: [],
    evidenceRetentionPolicy: [
      { id: "pol-1", teamId: TEAM, status: "ACTIVE", displayName: "Workspace policy", retentionDays: 365, scope: "WORKSPACE" },
    ],
    evidenceExchangePackage: [
      { id: "pkg-other", teamId: TEAM, kind: "EVIDENCE", state: "READY", evidenceIds: [OTHER], packageSha256: "ab", createdAt: at },
    ],
    chainTransfer: [
      { id: "xfer-1", teamId: TEAM, fromOrganizationId: "org", toOrganizationSlug: "counterparty-llp", state: "COMPLETED", evidenceIds: [OTHER], createdAt: at, completedAtUtc: at },
    ],
  });
}

const byPath = (entries: ReadonlyArray<{ path: string; json: unknown }>) =>
  Object.fromEntries(entries.map((e) => [e.path, e.json as Record<string, unknown>]));

describe("PRO-W1C-02 — exchange lifecycle manifests are scoped to the selection", () => {
  it("allowed: a hold on a selected record is stated with its real state; the other record's newer hold is not", async () => {
    const files = byPath(
      await buildLifecycleAndExchangeManifests({ prisma: workspace(), teamId: TEAM, evidenceIds: [SELECTED] } as never),
    );
    const hold = files["lifecycle/legal-hold-manifest.json"];
    expect(hold).toBeDefined();
    expect(hold.holdId).toBe("hold-sel");
    expect(hold.scopeTargetId).toBe(SELECTED);
    expect(hold.state).toBe("RELEASED");
    expect(files["lifecycle/lifecycle-manifest.json"]).toMatchObject({ totalLegalHolds: 1, totalArchiveTransitions: 0, totalDestructionRequests: 0 });
  });

  it("refused: other records' archive moves and destruction requests, other packages and counterparties never appear", async () => {
    const entries = await buildLifecycleAndExchangeManifests({ prisma: workspace(), teamId: TEAM, evidenceIds: [SELECTED] } as never);
    const files = byPath(entries);
    expect(Object.keys(files)).not.toContain("lifecycle/archive-manifest.json");
    expect(Object.keys(files)).not.toContain("lifecycle/destruction-manifest.json");
    expect(Object.keys(files)).not.toContain("lifecycle/exchange-manifest.json");
    expect(Object.keys(files)).not.toContain("lifecycle/transfer-manifest.json");
    expect(Object.keys(files)).not.toContain("lifecycle/retention-manifest.json");
    const text = JSON.stringify(entries);
    expect(text).not.toContain(OTHER);
    expect(text).not.toContain("counterparty-llp");
    expect(text).not.toContain("pkg-other");
  });

  it("no row for a family: no file and no placeholder state (no invented ACTIVE / REQUESTED / INITIATED)", async () => {
    const empty = fakePrisma({});
    const files = byPath(
      await buildLifecycleAndExchangeManifests({ prisma: empty, teamId: TEAM, evidenceIds: [SELECTED] } as never),
    );
    expect(Object.keys(files).sort()).toEqual(["lifecycle/lifecycle-manifest.json"]);
    expect(files["lifecycle/lifecycle-manifest.json"]).toMatchObject({
      totalLegalHolds: 0,
      totalArchiveTransitions: 0,
      totalDestructionRequests: 0,
    });
  });

  it("control: a destruction request and archive move naming a selected record are stated", async () => {
    const p = fakePrisma({
      archiveTierTransition: [
        { teamId: TEAM, evidenceId: SELECTED, fromTier: "HOT", toTier: "ARCHIVE", transitionedAtUtc: at, costEstimateUsdMicros: 7 },
      ],
      destructionRequest: [{ id: "destr-sel", teamId: TEAM, state: "APPROVED", evidenceIds: [SELECTED, OTHER], certifiedAtUtc: null }],
    });
    const files = byPath(await buildLifecycleAndExchangeManifests({ prisma: p, teamId: TEAM, evidenceIds: [SELECTED] } as never));
    expect(files["lifecycle/archive-manifest.json"]).toMatchObject({ evidenceId: SELECTED, toTier: "ARCHIVE" });
    expect(files["lifecycle/destruction-manifest.json"]).toMatchObject({ requestId: "destr-sel", state: "APPROVED" });
  });
});
