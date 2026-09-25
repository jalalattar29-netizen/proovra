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
 * most one /v1/platform/context fetch.
 */
import { useEffect, useState } from "react";
import { apiFetch } from "../api";
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
  const promise = apiFetch("/v1/platform/context", { method: "GET" });
  const entry = { token, promise };
  inflight = entry;
  const clear = () => {
    if (inflight === entry) inflight = null;
  };
  promise.then(clear, clear);
  return promise;
}

/**
 * Fetches the canonical envelope once per authenticated session and projects it.
 * Fails soft: on a transient error `context` is null and `error` is true; callers
 * decide whether a missing teamId means "personal scope" or "retry".
 */
export function usePlatformContext(): PlatformContextState {
  const { token, authReady } = useAuth();
  const [state, setState] = useState<Omit<PlatformContextState, "refresh">>({
    loading: true,
    error: false,
    context: null,
    envelope: null,
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    if (!authReady || !token) {
      setState({ loading: false, error: false, context: null, envelope: null });
      return;
    }
    setState((prev) => ({ ...prev, loading: true, error: false }));
    sharedPlatformContextRequest(token, nonce > 0)
      .then((envelope) => {
        if (!alive) return;
        setState({
          loading: false,
          error: false,
          context: projectPlatformContext(envelope),
          envelope,
        });
      })
      .catch(() => {
        if (!alive) return;
        setState({ loading: false, error: true, context: null, envelope: null });
      });
    return () => {
      alive = false;
    };
  }, [authReady, token, nonce]);

  return { ...state, refresh: () => setNonce((n) => n + 1) };
}
