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
  };
}

export interface PlatformContextState {
  readonly loading: boolean;
  readonly error: boolean;
  readonly context: PlatformContextProjection | null;
  readonly refresh: () => void;
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
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    if (!authReady || !token) {
      setState({ loading: false, error: false, context: null });
      return;
    }
    setState((prev) => ({ ...prev, loading: true, error: false }));
    apiFetch("/v1/platform/context", { method: "GET" })
      .then((envelope) => {
        if (!alive) return;
        setState({ loading: false, error: false, context: projectPlatformContext(envelope) });
      })
      .catch(() => {
        if (!alive) return;
        setState({ loading: false, error: true, context: null });
      });
    return () => {
      alive = false;
    };
  }, [authReady, token, nonce]);

  return { ...state, refresh: () => setNonce((n) => n + 1) };
}
