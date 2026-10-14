/**
 * EVERY PERSONA SEES ONLY THE ACTIONS ITS ROLE CAN TAKE (2026-10-14).
 *
 * The remediation projection is the ONE authority on what a condition offers a
 * reader; the canonical `roleHasPermission` is the ONE authority on what a role
 * may open. This matrix runs every produced tenant source past every workspace
 * role (PRO owner, TEAM and ENTERPRISE owner/admin/member/reviewer/viewer map
 * onto the same canonical roles — a plan changes which workspaces exist, not
 * what a role may open) and proves:
 *
 *   - a deep link is offered exactly when the role holds its permission;
 *   - a record-scoped link names the record, and is withheld when the record
 *     is gone (whatever the role);
 *   - no role, ever, is offered an Intake Links action for a stalled upload or
 *     for the "Uploads could not be started or resumed" source;
 *   - a closed or read-only condition offers no mutating action to anyone.
 */
import { describe, expect, it } from "vitest";

import { CANONICAL_ROLES, DB_TEAM_ROLES, roleHasPermission, type Permission } from "@proovra/shared";
import { OPERATIONS_SOURCE_LIFECYCLES } from "@proovra/shared-runtime";

import { entryForIncident, resolveRemediations } from "../src/services/operations/remediation-registry.js";

const EVIDENCE = "9f1d2c3b-0000-4000-8000-000000000002";
const PERSONAS: Array<{ persona: string; role: (typeof CANONICAL_ROLES)[number] | (typeof DB_TEAM_ROLES)[number] }> = [
  { persona: "PRO owner", role: "OWNER" },
  { persona: "TEAM owner", role: "OWNER" },
  { persona: "TEAM admin", role: "ADMIN" },
  { persona: "TEAM member", role: "MEMBER" },
  { persona: "TEAM reviewer", role: "REVIEWER" },
  { persona: "TEAM viewer", role: "VIEWER" },
  { persona: "ENTERPRISE owner", role: "OWNER" },
  { persona: "ENTERPRISE admin", role: "ADMIN" },
  { persona: "ENTERPRISE member", role: "MEMBER" },
  { persona: "ENTERPRISE reviewer", role: "REVIEWER" },
  { persona: "ENTERPRISE viewer", role: "VIEWER" },
];

const produced = OPERATIONS_SOURCE_LIFECYCLES.filter(
  (l) => l.discoveryState === "ACTIVE" && l.audience !== "PLATFORM_INTERNAL",
);

function project(
  role: (typeof PERSONAS)[number]["role"],
  sourceId: string,
  over: { status?: string; subjectAvailable?: boolean; canMutate?: boolean } = {},
) {
  const l = OPERATIONS_SOURCE_LIFECYCLES.find((x) => x.sourceId === sourceId)!;
  const has = (p: string) => roleHasPermission(role as never, p as Permission);
  return resolveRemediations(
    { sourceId, category: l.category, fingerprint: `${sourceId}:${EVIDENCE}`, relatedEvidenceId: EVIDENCE },
    {
      can: has as never,
      hasPermission: has,
      workspaceCanMutate: over.canMutate ?? true,
      incidentStatus: over.status ?? "OPEN",
      ...(over.subjectAvailable !== undefined ? { subjectAvailable: over.subjectAvailable } : {}),
    },
  );
}

describe("persona × source — deep links follow the canonical permission", () => {
  for (const { persona, role } of PERSONAS) {
    it(persona, () => {
      for (const l of produced) {
        const entry = entryForIncident({ sourceId: l.sourceId, category: l.category, fingerprint: `${l.sourceId}:probe` });
        const declared = entry?.deepLink;
        const got = project(role, l.sourceId).deepLink;
        if (!declared) {
          expect(got, `${persona} / ${l.sourceId}`).toBeNull();
          continue;
        }
        const allowed =
          declared.requiredPermission === null || roleHasPermission(role as never, declared.requiredPermission as Permission);
        if (!allowed) {
          expect(got, `${persona} / ${l.sourceId}`).toBeNull();
          continue;
        }
        expect(got, `${persona} / ${l.sourceId}`).not.toBeNull();
        if (declared.recordScoped) expect(got!.href, `${persona} / ${l.sourceId}`).toContain(`/${EVIDENCE}`);
        expect(got!.href, `${persona} / ${l.sourceId}`).not.toMatch(/intake-links/);
      }
    });
  }
});

describe("the stalled upload, for every persona", () => {
  it("anyone who may read records is linked to THAT record; nobody to Intake Links", () => {
    for (const { persona, role } of PERSONAS) {
      const r = project(role, "capture.upload_stalled");
      if (roleHasPermission(role as never, "evidence.read")) {
        expect(r.deepLink?.href, persona).toBe(`/evidence/${EVIDENCE}`);
      } else {
        expect(r.deepLink, persona).toBeNull();
      }
      expect(JSON.stringify(r), persona).not.toMatch(/intake/i);
      // Its recovery closes it; there is no manual repair to offer.
      expect(r.actions, persona).toEqual([]);
    }
  });

  it("a record that is gone is linked for nobody", () => {
    for (const { persona, role } of PERSONAS) {
      expect(project(role, "capture.upload_stalled", { subjectAvailable: false }).deepLink, persona).toBeNull();
    }
  });

  it("the upload-start/resume source offers truthful guidance and no Intake Links, for everyone", () => {
    for (const { persona, role } of PERSONAS) {
      const r = project(role, "intake.delivery_failed");
      expect(r.deepLink, persona).toBeNull();
      expect(r.actions, persona).toEqual([]);
      expect(r.guidance ?? "", persona).not.toMatch(/intake link/i);
    }
  });
});

describe("closed and read-only conditions", () => {
  it("offer no mutating action to any persona", () => {
    for (const { persona, role } of PERSONAS) {
      for (const l of produced) {
        expect(project(role, l.sourceId, { status: "RESOLVED" }).actions, `${persona} / ${l.sourceId} resolved`).toEqual([]);
        expect(project(role, l.sourceId, { canMutate: false }).actions, `${persona} / ${l.sourceId} read-only`).toEqual([]);
      }
    }
  });
});
