/**
 * CANONICAL NATIVE PLATFORM CONTEXT — the ONE reader of GET /v1/platform/context
 * (Law of One). Every data endpoint the app calls is workspace-scoped and needs
 * the active workspace id (`teamId`); Search and the dashboard REQUIRE it. This
 * module resolves it from the canonical envelope and nothing re-derives it.
 *
 * `projectPlatformContext` is PURE (no React/RN, no fetch) so it is unit-testable
 * and is the single authority for reading the envelope's documented fields:
 *   - activeSpace.id            → the active workspace/`teamId`
 *   - activeSpace.type          → PERSONAL | ORGANIZATION
 *   - activeSpace.plan          → server-resolved plan of the ACTIVE space
 *   - personalSpaceAllowed      → managed-policy gate (mirrors web)
 * See services/api/src/services/platform-context/types.ts (the authority).
 *
 * usePersonalSpaceAllowed is a thin selector over this hook, so a screen makes at
 * most one /v1/platform/context fetch. The state itself is shared: see below.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { apiFetch, setActiveWorkspaceId } from "../api";
import { useAuth } from "../auth-context";
import { isPersonalSpaceDisallowed } from "../personal-space";

export type ActiveSpaceType = "PERSONAL" | "ORGANIZATION";

export interface PlatformContextProjection {
  /** Active workspace id — pass as `teamId` to workspace-scoped endpoints. Null
   *  for a personal space whose bootstrap has not resolved an id yet. */
  readonly activeTeamId: string | null;
  readonly activeSpaceType: ActiveSpaceType | null;
  /** Server-resolved plan of the ACTIVE space (never the owner's account plan). */
  readonly activeSpacePlan: string | null;
  /** Managed-policy gate: false only when the server explicitly disallows it. */
  readonly personalSpaceAllowed: boolean;
  readonly displayName: string | null;
  /**
   * The SERVER-projected enterprise-surface gate, read exactly as the web
   * reads it: `platform.isPlatformAdmin === true || flags.isEnterpriseWorkspace === true`.
   *
   * It decides whether ENTERPRISE surfaces — governance, intelligence,
   * investigation — are shown. Nothing native derives it: a client that
   * inferred "enterprise" from a plan name would be a second authority that
   * disagrees the moment either changes. Absent reads as false, which
   * withholds rather than offers.
   */
  readonly enterpriseSurfaces: boolean;
  /**
   * Reviewer operations — reviewer comments, legal notes, annotations.
   *
   * A COMMERCIAL entitlement, not an Enterprise surface. The catalog includes
   * it for TEAM and above (`PlanCapabilities.reviewerOperationsIncluded`) and
   * `reviewer-workspace.routes.ts` enforces that same field, so reading
   * `enterpriseSurfaces` here hid the internal materials from every TEAM
   * workspace that pays for them.
   *
   * A platform admin passes, matching `usePlanFeatureGate` on the web.
   * Absent reads as false.
   */
  readonly reviewerOperations: boolean;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Pure projection of the canonical envelope. Reads documented fields only. */
export function projectPlatformContext(envelope: unknown): PlatformContextProjection {
  const env = (envelope && typeof envelope === "object" ? envelope : {}) as Record<string, unknown>;
  const active = (env["activeSpace"] && typeof env["activeSpace"] === "object"
    ? (env["activeSpace"] as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const typeRaw = str(active["type"]);
  const activeSpaceType: ActiveSpaceType | null =
    typeRaw === "PERSONAL" || typeRaw === "ORGANIZATION" ? typeRaw : null;
  return {
    activeTeamId: str(active["id"]),
    activeSpaceType,
    activeSpacePlan: str(active["plan"]),
    // Absent defaults to allowed — the server only ever sets false explicitly
    // (the pure gate in personal-space.ts is the ONE rule for this).
    personalSpaceAllowed: !isPersonalSpaceDisallowed(env as { personalSpaceAllowed?: boolean }),
    displayName: str(active["displayName"]),
    enterpriseSurfaces: readEnterpriseSurfaces(env),
    reviewerOperations: readReviewerOperations(env),
  };
}

function envObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function readEnterpriseSurfaces(env: Record<string, unknown>): boolean {
  return envObject(env["platform"])["isPlatformAdmin"] === true ||
    envObject(env["flags"])["isEnterpriseWorkspace"] === true;
}

/** `planFeatures.reviewerOperationsIncluded`, with the platform-admin pass. */
function readReviewerOperations(env: Record<string, unknown>): boolean {
  if (envObject(env["platform"])["isPlatformAdmin"] === true) return true;
  return envObject(env["planFeatures"])["reviewerOperationsIncluded"] === true;
}

export interface PlatformContextState {
  readonly loading: boolean;
  readonly error: boolean;
  readonly context: PlatformContextProjection | null;
  /**
   * The envelope as it arrived.
   *
   * `context` is the small projection nearly every screen wants. The Spaces
   * surface wants the canonical block — personalSpace / ownedWorkspaces /
   * organizations / organizationWorkspaces — and Law of One says it may not
   * fetch `/v1/platform/context` for itself. So the raw body is kept here and
   * projected by `src/product/spaces.ts`, which means one reader still.
   */
  readonly envelope: unknown;
  readonly refresh: () => void;
}

/**
 * One request shared by every hook instance mounted while it is in flight.
 *
 * T-09f — the shell's navigation, the header and the screen beneath them all
 * read this envelope, and each instance used to issue its own GET, so a single
 * navigation cost three identical round trips. Only the IN-FLIGHT request is
 * shared: it is dropped the moment it settles, so nothing here can serve a
 * stale envelope, and `refresh()` always forces a fresh read.
 */
let inflight: { token: string; promise: Promise<unknown> } | null = null;

export function sharedPlatformContextRequest(token: string, force: boolean): Promise<unknown> {
  if (!force && inflight && inflight.token === token) return inflight.promise;
  const promise = apiFetch("/v1/platform/context", { method: "GET" }).then((envelope) => {
    setActiveWorkspaceId(projectPlatformContext(envelope).activeTeamId);
    return envelope;
  });
  const entry = { token, promise };
  inflight = entry;
  const clear = () => {
    if (inflight === entry) inflight = null;
  };
  promise.then(clear, clear);
  return promise;
}

/**
 * WHICH WORKSPACE THIS IS, OR THAT NOBODY KNOWS YET (MOBILE-003).
 *
 * A null `activeTeamId` used to mean both "personal" and "unknown", and a capture
 * that sent nothing was filed in Personal by the server. Evidence then sat outside
 * the organization's retention, review and audit because of a network hiccup. So
 * the two are different states here: a write that needs a workspace acts only on
 * `resolved`, where a null `teamId` is a confirmed Personal Space.
 */
export type WorkspaceResolution =
  | { readonly state: "resolving" }
  | { readonly state: "unavailable" }
  | { readonly state: "resolved"; readonly teamId: string | null; readonly name: string | null };

export function resolveWorkspace(input: {
  readonly loading: boolean;
  readonly error: boolean;
  readonly context: PlatformContextProjection | null;
}): WorkspaceResolution {
  const { context } = input;
  if (context?.activeTeamId || context?.activeSpaceType === "PERSONAL") {
    return { state: "resolved", teamId: context.activeTeamId, name: context.displayName };
  }
  // An envelope with no active space answers nothing, and the server always sends one.
  if (context || input.error) return { state: "unavailable" };
  return { state: "resolving" };
}

/** The workspace to file into, or null when nobody can say. */
export function confirmedWorkspace(
  workspace: WorkspaceResolution,
): { teamId: string | null; name: string | null } | null {
  return workspace.state === "resolved" ? { teamId: workspace.teamId, name: workspace.name } : null;
}

/** What a refused write says. Nothing was filed, and nothing staged was lost. */
export const WORKSPACE_UNCONFIRMED_MESSAGE =
  "PROOVRA could not confirm which workspace this belongs to, so nothing has been filed. What you captured stays on this device. Check your connection and try again.";

/*
 * ONE CONTEXT, FOR EVERYTHING MOUNTED (MOBILE-013).
 *
 * Each hook instance used to keep its own copy, and `refresh()` reached only its
 * own. Tab screens, the header and the shell stay mounted, so after a switch they
 * went on naming the old workspace while requests that name no team followed the
 * new server pointer. The pointer is one per user, so a switch on the web did the
 * same to a running phone.
 *
 * So the state lives here, once. It belongs to the session token that read it,
 * a screen mounting revalidates it, the app returning to the foreground
 * revalidates it, and `refresh()` reaches every subscriber.
 *
 * A revalidation is silent. `loading` means "nothing is known yet": a screen that
 * shows a spinner on it must not lose its controls because a header remounted,
 * and a capture in progress must not flicker. A background failure keeps what is
 * known, but a failed forced read does not, because that read was asked for
 * precisely because what is known may be wrong.
 */
type ContextSnapshot = Omit<PlatformContextState, "refresh"> & { readonly owner: string | null };

const NOTHING_KNOWN: ContextSnapshot = { owner: null, loading: false, error: false, context: null, envelope: null };
let snapshot: ContextSnapshot = NOTHING_KNOWN;
const subscribers = new Set<() => void>();
let readSequence = 0;
let appliedRead = 0;
let foreground: { remove: () => void } | null = null;

function publish(next: ContextSnapshot): void {
  snapshot = next;
  for (const notify of [...subscribers]) notify();
}

function readContext(token: string, force: boolean): void {
  const mine = ++readSequence;
  if (snapshot.owner !== token) {
    publish({ owner: token, loading: true, error: false, context: null, envelope: null });
  } else if (!snapshot.context) {
    publish({ ...snapshot, loading: true, error: false });
  }
  const superseded = () => snapshot.owner !== token || mine < appliedRead;
  sharedPlatformContextRequest(token, force).then(
    (envelope) => {
      if (superseded()) return;
      appliedRead = mine;
      publish({ owner: token, loading: false, error: false, context: projectPlatformContext(envelope), envelope });
    },
    () => {
      if (superseded()) return;
      appliedRead = mine;
      publish(
        snapshot.context && !force
          ? { ...snapshot, loading: false }
          : { owner: token, loading: false, error: true, context: null, envelope: null },
      );
    },
  );
}

function subscribeToContext(notify: () => void): () => void {
  subscribers.add(notify);
  if (!foreground) {
    foreground = AppState.addEventListener("change", (next) => {
      if (next === "active" && snapshot.owner) readContext(snapshot.owner, false);
    });
  }
  return () => {
    subscribers.delete(notify);
    if (subscribers.size > 0) return;
    foreground?.remove();
    foreground = null;
    // Nothing is reading it, so nothing keeps it current.
    readSequence += 1;
    appliedRead = readSequence;
    snapshot = NOTHING_KNOWN;
  };
}

const readSnapshot = (): ContextSnapshot => snapshot;

/** Force a fresh read for every mounted screen: after a switch, or a Retry. */
export function refreshPlatformContext(): void {
  if (snapshot.owner) readContext(snapshot.owner, true);
}

/**
 * The canonical envelope and its projection, shared by every caller. On a failed
 * first read `context` is null and `error` is true. Null context never means
 * "personal": a caller that needs to know says so with `resolveWorkspace`.
 */
export function usePlatformContext(): PlatformContextState {
  const { token, authReady } = useAuth();
  const held = useSyncExternalStore(subscribeToContext, readSnapshot, readSnapshot);
  const live = authReady && !!token;

  useEffect(() => {
    if (live && token) readContext(token, false);
  }, [live, token]);

  if (!live) return { ...NOTHING_KNOWN, refresh: refreshPlatformContext };
  // The first render under a new token, before the effect above has run.
  if (held.owner !== token) {
    return { loading: true, error: false, context: null, envelope: null, refresh: refreshPlatformContext };
  }
  return { loading: held.loading, error: held.error, context: held.context, envelope: held.envelope, refresh: refreshPlatformContext };
}

/**
 * Counts changes of the active workspace, from one known workspace to another.
 *
 * For a screen whose requests name no team and follow the server pointer: it has
 * nothing keyed on the workspace, so it would keep showing the previous one's rows.
 * The first resolution is not a change, so a mount costs one read, not two.
 */
export function useWorkspaceChangeCount(): number {
  const activeTeamId = usePlatformContext().context?.activeTeamId ?? null;
  const last = useRef(activeTeamId);
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    if (!activeTeamId) return;
    if (last.current && last.current !== activeTeamId) setChanges((n) => n + 1);
    last.current = activeTeamId;
  }, [activeTeamId]);
  return changes;
}
