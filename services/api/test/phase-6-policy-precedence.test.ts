/**
 * PHASE 6 §9.4 (2026-07-22) — canonical policy-precedence engine +
 * first adopter (retention inheritance).
 *
 * Engine rules: deepest defined scope wins; a MANDATORY parent is a
 * floor deeper scopes may strengthen but never weaken; Legal Hold is
 * absolute for destruction decisions.
 *
 * First adopter: an IMMUTABLE org retention template now ENFORCES its
 * floor over a weaker team policy (previously documented as
 * "informational only") — virtually, at resolution time; the team row
 * is never rewritten.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  legalHoldPrevails,
  POLICY_SCOPE_PRECEDENCE,
  resolveEffectivePolicyValue,
  strongerRetentionDays,
} from "../src/services/governance/policy-precedence.js";

const H = vi.hoisted(() => ({
  teamPolicy: null as Record<string, unknown> | null,
  organizationId: "org-1" as string | null,
  orgTemplate: null as Record<string, unknown> | null,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    evidenceRetentionPolicy: { findFirst: async () => H.teamPolicy },
    team: {
      findUnique: async () => ({ organizationId: H.organizationId }),
    },
    organizationPolicy: {
      findUnique: async () =>
        H.orgTemplate ? { value: H.orgTemplate } : null,
    },
  },
}));

import { resolveTeamRetentionPolicy } from "../src/services/organization/retention-inheritance.service.js";

const rd = (v: number | null) => v; // readability helper

describe("Phase 6 §9.4 — canonical precedence engine", () => {
  it("scope chain is the mandated five-layer order", () => {
    expect(POLICY_SCOPE_PRECEDENCE).toEqual([
      "PLATFORM_BASELINE",
      "ORGANIZATION",
      "WORKSPACE",
      "CASE",
      "EVIDENCE_HOLD",
    ]);
  });

  it("deepest defined scope wins when no floor is involved", () => {
    const r = resolveEffectivePolicyValue<number | null>(
      [
        { scope: "ORGANIZATION", value: rd(90) },
        { scope: "WORKSPACE", value: rd(30) },
      ],
      strongerRetentionDays,
    );
    expect(r).toMatchObject({
      defined: true,
      value: 30,
      scope: "WORKSPACE",
      parentPrevailed: false,
    });
  });

  it("mandatory parent floor overrides a WEAKER child; stronger child passes", () => {
    const weakerChild = resolveEffectivePolicyValue<number | null>(
      [
        { scope: "ORGANIZATION", value: rd(90), mandatory: true },
        { scope: "WORKSPACE", value: rd(30) },
      ],
      strongerRetentionDays,
    );
    expect(weakerChild).toMatchObject({
      defined: true,
      value: 90,
      scope: "ORGANIZATION",
      parentPrevailed: true,
      overriddenScope: "WORKSPACE",
    });

    const strongerChild = resolveEffectivePolicyValue<number | null>(
      [
        { scope: "ORGANIZATION", value: rd(90), mandatory: true },
        { scope: "WORKSPACE", value: rd(365) },
      ],
      strongerRetentionDays,
    );
    expect(strongerChild).toMatchObject({
      defined: true,
      value: 365,
      scope: "WORKSPACE",
      parentPrevailed: false,
    });
  });

  it("indefinite (null) is the strongest retention value in both directions", () => {
    // Indefinite child over a finite mandatory floor: allowed.
    const indefiniteChild = resolveEffectivePolicyValue<number | null>(
      [
        { scope: "ORGANIZATION", value: rd(90), mandatory: true },
        { scope: "WORKSPACE", value: rd(null) },
      ],
      strongerRetentionDays,
    );
    expect(indefiniteChild).toMatchObject({ value: null, scope: "WORKSPACE" });

    // Finite child under an indefinite mandatory floor: parent prevails.
    const finiteChild = resolveEffectivePolicyValue<number | null>(
      [
        { scope: "ORGANIZATION", value: rd(null), mandatory: true },
        { scope: "WORKSPACE", value: rd(30) },
      ],
      strongerRetentionDays,
    );
    expect(finiteChild).toMatchObject({
      value: null,
      scope: "ORGANIZATION",
      parentPrevailed: true,
    });
  });

  it("undefined layers are skipped; nothing defined → undefined policy", () => {
    const r = resolveEffectivePolicyValue<number | null>(
      [
        { scope: "ORGANIZATION", value: undefined },
        { scope: "WORKSPACE", value: rd(30) },
      ],
      strongerRetentionDays,
    );
    expect(r).toMatchObject({ value: 30 });
    expect(
      resolveEffectivePolicyValue<number | null>(
        [{ scope: "WORKSPACE", value: undefined }],
        strongerRetentionDays,
      ),
    ).toEqual({ defined: false });
  });

  it("Legal Hold prevails absolutely for destruction decisions", () => {
    expect(legalHoldPrevails({ hasActiveLegalHold: true })).toEqual({
      destructionAllowed: false,
      reason: "LEGAL_HOLD_ACTIVE",
    });
    expect(legalHoldPrevails({ hasActiveLegalHold: false })).toBeNull();
  });
});

describe("Phase 6 §9.4 — retention inheritance enforces the immutable org floor", () => {
  beforeEach(() => {
    H.teamPolicy = null;
    H.organizationId = "org-1";
    H.orgTemplate = null;
  });

  it("weaker team policy under an immutable template → floor applied virtually", async () => {
    H.teamPolicy = { id: "p1", retentionDays: 30, immutable: false };
    H.orgTemplate = { retentionDays: 90, immutable: true, description: null };
    const r = await resolveTeamRetentionPolicy("t1");
    expect(r).toMatchObject({
      source: "team_policy",
      retentionDays: 90,
      mandatoryFloorApplied: true,
    });
  });

  it("team policy at least as strong keeps winning (child may strengthen)", async () => {
    H.teamPolicy = { id: "p1", retentionDays: 365, immutable: false };
    H.orgTemplate = { retentionDays: 90, immutable: true, description: null };
    const r = await resolveTeamRetentionPolicy("t1");
    expect(r).toMatchObject({ source: "team_policy", retentionDays: 365 });
    expect(
      (r as { mandatoryFloorApplied?: boolean }).mandatoryFloorApplied,
    ).toBeUndefined();
  });

  it("non-immutable template stays advisory (previous behavior unchanged)", async () => {
    H.teamPolicy = { id: "p1", retentionDays: 30, immutable: false };
    H.orgTemplate = { retentionDays: 90, immutable: false, description: null };
    const r = await resolveTeamRetentionPolicy("t1");
    expect(r).toMatchObject({ source: "team_policy", retentionDays: 30 });
  });

  it("no team policy → org template inherited; nothing anywhere → none", async () => {
    H.orgTemplate = { retentionDays: 90, immutable: true, description: null };
    expect(await resolveTeamRetentionPolicy("t1")).toMatchObject({
      source: "org_policy_inherited",
    });
    H.orgTemplate = null;
    expect(await resolveTeamRetentionPolicy("t1")).toMatchObject({
      source: "none",
    });
  });
});
