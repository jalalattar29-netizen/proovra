/**
 * THE AUTHENTICATED SESSION OF THE REQUEST IN PROGRESS (AUTHZ-001).
 *
 * Organization security policy (mandatory SSO, MFA, session lifetime) belongs to
 * the workspace a request acts in. `requireAuth` proves the session but cannot
 * know that workspace, and the authorities that do know it
 * (`evaluateMemberAccessWithSnapshot`, `listAccessibleWorkspaces`) are called
 * from dozens of routes with no request in hand. This scope carries the proven
 * session facts from the one to the others, so no route has to pass them and no
 * route can forget to.
 *
 * There is no session in the scope for a worker, a sweep, an API key or a public
 * token: those are not sessions, and they keep their own authorities.
 *
 * One scope per request. `onRequest` opens it, and it is bound again at
 * `preValidation` because Node delivers the request body from another async
 * context. `requireAuth` writes the facts only after the token has verified.
 */
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import type { FastifyInstance, FastifyRequest } from "fastify";

export type RequestSessionFacts = {
  userId: string;
  /** The server-proven login method in the policy's vocabulary. */
  policyMethod: "PASSWORD" | "OAUTH" | "SSO";
  ssoConnId: string | null;
  authAtMs: number;
  issuedAtSec: number;
  lastSeenAtMs: number;
  /** Set only when a second factor was verified for this session. */
  mfaAtSec: number | null;
  /** The resolved client address of this request, for network policy. */
  clientIp: string | null;
};

export type WorkspaceGateDecision = { allowed: boolean; reason?: string };

type RequestSessionScope = {
  session: RequestSessionFacts | null;
  /** One evaluation per workspace per request. */
  decisions: Map<string, Promise<WorkspaceGateDecision>>;
};

const storage = new AsyncLocalStorage<RequestSessionScope>();
const scopeResource = Symbol("proovra.requestSessionScope");

type ScopedRequest = FastifyRequest & { [scopeResource]?: AsyncResource };

function freshScope(): RequestSessionScope {
  return { session: null, decisions: new Map() };
}

export function registerRequestSessionScope(app: FastifyInstance): void {
  app.addHook("onRequest", (req, _reply, done) => {
    storage.run(freshScope(), () => {
      const resource = new AsyncResource("proovra.request-session");
      (req as ScopedRequest)[scopeResource] = resource;
      resource.runInAsyncScope(done, req.raw);
    });
  });
  app.addHook("preValidation", (req, _reply, done) => {
    const resource = (req as ScopedRequest)[scopeResource];
    if (resource) resource.runInAsyncScope(done, req.raw);
    else done();
  });
}

/**
 * Records the proven session for the rest of this request. An app built without
 * `registerRequestSessionScope` still gets a scope here, so the facts are never
 * silently dropped.
 */
export function bindRequestSession(facts: RequestSessionFacts): void {
  const scope = storage.getStore();
  if (scope) {
    scope.session = facts;
    scope.decisions.clear();
    return;
  }
  storage.enterWith({ session: facts, decisions: new Map() });
}

export function currentRequestSession(): RequestSessionFacts | null {
  return storage.getStore()?.session ?? null;
}

/** The evaluation for one workspace, computed at most once per request. */
export function onceForWorkspace(
  teamId: string,
  evaluate: () => Promise<WorkspaceGateDecision>,
): Promise<WorkspaceGateDecision> {
  const decisions = storage.getStore()?.decisions;
  if (!decisions) return evaluate();
  const known = decisions.get(teamId);
  if (known) return known;
  const pending = evaluate();
  decisions.set(teamId, pending);
  return pending;
}
