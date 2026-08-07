/**
 * Phase IA-home-acceptance — shared persona definitions.
 *
 * Single source of truth for the four Home-acceptance personas. Both
 * the seed script (`scripts/seed-home-personas.ts`) and the dev-login
 * route (`routes/dev-auth.routes.ts`) import this so the persona keys,
 * user ids, workspace ids and plans never drift out of sync.
 *
 * The ids are fixed (deterministic) so the seed is idempotent and the
 * dev-login route can mint a token for a persona by name without a DB
 * lookup.
 *
 * This module contains NO secrets and NO auth logic — it is a plain
 * data table that is safe to import anywhere.
 */

export type HomePersonaKey =
  | "pro-empty"
  | "pro-populated"
  | "pro-issues"
  | "team-org";

export type HomePersona = {
  key: HomePersonaKey;
  userId: string;
  email: string;
  /** Account entitlement plan written to the Entitlement table. */
  plan: "PRO" | "TEAM";
  /** The workspace the user lands in. */
  workspaceId: string;
  /** PERSONAL → Team.isPersonal=true; ORGANIZATION → a team workspace. */
  workspaceKind: "PERSONAL" | "ORGANIZATION";
  workspaceName: string;
};

export const HOME_PERSONAS: Record<HomePersonaKey, HomePersona> = {
  "pro-empty": {
    key: "pro-empty",
    userId: "0e000000-0000-4000-8000-000000000001",
    email: "pro-empty@home-personas.local",
    plan: "PRO",
    workspaceId: "0e000000-0000-4000-8000-0000000000a1",
    workspaceKind: "PERSONAL",
    workspaceName: "Personal Space",
  },
  "pro-populated": {
    key: "pro-populated",
    userId: "0e000000-0000-4000-8000-000000000002",
    email: "pro-populated@home-personas.local",
    plan: "PRO",
    workspaceId: "0e000000-0000-4000-8000-0000000000a2",
    workspaceKind: "PERSONAL",
    workspaceName: "Personal Space",
  },
  // Phase HOME-PROOF — the "issues" acceptance persona: every
  // operational problem state Home must surface (TSA failed, OTS
  // pending, unsigned record, report-without-package,
  // package-without-publication, failed delivery) plus all four
  // evidence types for the by-type donut.
  "pro-issues": {
    key: "pro-issues",
    userId: "0e000000-0000-4000-8000-000000000004",
    email: "pro-issues@home-personas.local",
    plan: "PRO",
    workspaceId: "0e000000-0000-4000-8000-0000000000a4",
    workspaceKind: "PERSONAL",
    workspaceName: "Personal Space",
  },
  "team-org": {
    key: "team-org",
    userId: "0e000000-0000-4000-8000-000000000003",
    email: "team-org@home-personas.local",
    plan: "TEAM",
    workspaceId: "0e000000-0000-4000-8000-0000000000a3",
    workspaceKind: "ORGANIZATION",
    workspaceName: "Acme Investigations",
  },
};

export const HOME_PERSONA_KEYS: HomePersonaKey[] = [
  "pro-empty",
  "pro-populated",
  "pro-issues",
  "team-org",
];

export function isHomePersonaKey(value: string): value is HomePersonaKey {
  return HOME_PERSONA_KEYS.includes(value as HomePersonaKey);
}
