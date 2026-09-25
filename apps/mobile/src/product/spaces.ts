/**
 * SPACES — the native port of `/workspaces`
 * (`apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx`).
 *
 * Every space the caller belongs to, and the one they are working in.
 *
 * ===========================================================================
 * THIS EXISTED AS A GAP DESCRIBED, NOT A DECISION
 * ===========================================================================
 * The ledger recorded that "native switches workspace through the account
 * menu rather than administering several at once". It does not: there is no
 * switcher anywhere in the native app. A user with a Personal Space and an
 * organization workspace was pinned to whichever one the server last recorded
 * and could not move between them on the device at all — every
 * workspace-scoped screen reads `activeTeamId` from the platform context, so
 * being unable to change it means being unable to reach the other space's
 * evidence, cases or people.
 *
 * ===========================================================================
 * THE ENVELOPE'S OWN WARNING IS OBSERVED HERE
 * ===========================================================================
 * The legacy `organizations` array is named after organizations but holds
 * EVERY non-personal workspace, with WORKSPACE ids and WORKSPACE member
 * counts. Its own type says so:
 *
 *   "this array is named `organizations` but is populated with EVERY
 *    non-personal workspace ... Consumers that mean 'organizations' in the
 *    product sense must filter on these two fields rather than on the
 *    array's name."
 *
 * So this module reads the CANONICAL block instead, where the distinction is
 * structural rather than a field to remember: `personalSpace`,
 * `ownedWorkspaces`, `organizations` (organization ids ONLY) and
 * `organizationWorkspaces` (workspace ids, each naming its organization).
 *
 * Pure: no React, no react-native, no fetch.
 */

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

export const SWITCH_WORKSPACE_PATH = "/v1/platform/context/switch-workspace";

export function buildSwitchWorkspaceBody(workspaceId: string) {
  return { workspaceId };
}

/**
 * WHY THERE IS NO CREATE HERE.
 *
 * `POST /v1/teams` exists but always refuses: the route is dispositioned
 * COMPATIBILITY_TOMBSTONE and its handler returns
 * 409 WORKSPACE_CREATION_NOT_SELF_SERVICE on every path, because
 * "self-service workspace creation was removed with the commercial allowance
 * that permitted it". It is kept so a stale client gets a code-bearing
 * explanation instead of a 404.
 *
 * An earlier version of this module built a create body for it. A control
 * that can only fail is worse than no control: it teaches the user that the
 * app is broken when the server is doing exactly what it was asked to do.
 * The surface says where a workspace comes from instead.
 */
export const WORKSPACE_CREATION_NOTE =
  "New workspaces are set up with PROOVRA rather than created here. Your organization " +
  "administrator or your account contact can add one.";

export type SpaceKind = "PERSONAL" | "OWNED" | "ORGANIZATION";

export interface Space {
  /** The WORKSPACE id — what `switch-workspace` takes and every scoped read uses. */
  id: string;
  name: string;
  kind: SpaceKind;
  plan: string | null;
  memberCount: number | null;
  role: string | null;
  /**
   * The ORGANIZATION this workspace belongs to, for an ORGANIZATION space.
   *
   * A different identifier from `id`, and deliberately a different field: the
   * envelope's own history records a bug where workspace ids sat in a field
   * named after organizations and were handed to organization endpoints.
   */
  organizationId: string | null;
  organizationName: string | null;
}

export interface SpacesView {
  personal: Space | null;
  owned: Space[];
  organization: Space[];
  activeWorkspaceId: string | null;
  /**
   * True when the caller has no Personal Space AND is not merely loading.
   *
   * An ENTERPRISE identity under a `noPersonalSpace` policy has none, and the
   * envelope says it is "never substituted". A surface that invented one would
   * be offering a space the server would refuse to switch to.
   */
  personalSpaceAbsent: boolean;
}

function workspace(raw: unknown, kind: SpaceKind, orgName: string | null = null): Space | null {
  const w = obj(raw);
  const id = str(w.workspaceId) ?? str(w.id);
  if (!id) return null;
  return {
    id,
    name: str(w.name) ?? str(w.displayName) ?? "Unnamed workspace",
    kind,
    // CanonicalContextWorkspace (platform-context/types.ts) carries neither a plan
    // nor a member count; reading them read keys the server never sends.
    plan: null,
    memberCount: null,
    role: str(w.role) ?? str(w.workspaceRole),
    organizationId: kind === "ORGANIZATION" ? str(w.organizationId) : null,
    organizationName: orgName,
  };
}

export function projectSpaces(envelope: unknown): SpacesView {
  const env = obj(envelope);
  const canonical = obj(env.canonical);

  // Organization NAMES are keyed by organization id, and the workspaces name
  // the organization they belong to — the two arrays are joined here rather
  // than a name being guessed from the workspace.
  const orgNames = new Map<string, string | null>();
  for (const raw of rows(canonical.organizations)) {
    const o = obj(raw);
    const id = str(o.organizationId);
    if (id) orgNames.set(id, str(o.name));
  }

  const personal = workspace(canonical.personalSpace, "PERSONAL");

  const owned = rows(canonical.ownedWorkspaces)
    .map((raw) => workspace(raw, "OWNED"))
    .filter((w): w is Space => w !== null);

  const organization = rows(canonical.organizationWorkspaces)
    .map((raw) => {
      const orgId = str(obj(raw).organizationId);
      return workspace(raw, "ORGANIZATION", orgId ? (orgNames.get(orgId) ?? null) : null);
    })
    .filter((w): w is Space => w !== null);

  const active = obj(env.activeSpace);

  return {
    personal,
    owned,
    organization,
    // The canonical fallback is `currentWorkspace`; `activeContext` is not a canonical key.
    activeWorkspaceId: str(active.id) ?? str(obj(canonical.currentWorkspace).workspaceId),
    personalSpaceAbsent: personal === null && Object.keys(canonical).length > 0,
  };
}

/** Every space, in the order a person reads them: theirs, then shared. */
export function allSpaces(view: SpacesView): Space[] {
  return [...(view.personal ? [view.personal] : []), ...view.owned, ...view.organization];
}

export function isActiveSpace(space: Space, view: SpacesView): boolean {
  return view.activeWorkspaceId !== null && space.id === view.activeWorkspaceId;
}

/** Switching to the space already active is a request with nothing to do. */
export function canSwitchTo(space: Space, view: SpacesView): boolean {
  return !isActiveSpace(space, view);
}

export function spaceKindLabel(kind: SpaceKind): string {
  switch (kind) {
    case "PERSONAL":
      // Never "Team", and never "Organization" — the web card carries the same
      // rule, in the same words: the Personal Space is private to one person.
      return "Personal Space";
    case "OWNED":
      return "Your workspace";
    case "ORGANIZATION":
      return "Organization workspace";
  }
}

/** A one-line summary from what the server actually sent. */
export function spaceSummaryLine(space: Space): string | null {
  const parts: string[] = [];
  if (space.plan) parts.push(space.plan);
  // A Personal Space has one member by definition; saying so is noise. For a
  // shared space it is the number that matters, and an absent count is absent
  // rather than rendered as zero members.
  if (space.kind !== "PERSONAL" && space.memberCount !== null) {
    parts.push(`${space.memberCount} member${space.memberCount === 1 ? "" : "s"}`);
  }
  if (space.organizationName) parts.push(space.organizationName);
  return parts.length > 0 ? parts.join(" · ") : null;
}
