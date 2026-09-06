const DEFAULT_API_BASE = "https://api.proovra.com";
const RAW_API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? DEFAULT_API_BASE;
const API_BASE = RAW_API_BASE.replace(/\/+$/, "");

/**
 * THE API ORIGIN — one authority.
 *
 * AUDIT-002/AUDIT-003 (2026-08-15): this used to be module-private, so callers
 * that cannot use `apiFetch` (binary downloads, the unauthenticated citizen
 * capture flow) either re-derived the base inline — duplicating the production
 * default, which then has to be changed in two places — or, worse, issued a
 * RELATIVE `fetch("/v1/…")`.
 *
 * A relative call is not a style preference: the browser resolves it against the WEB
 * origin, and there is no `/v1` rewrite in next.config, so it 404s against Next
 * and never reaches the API at all. Three call sites were doing exactly that.
 *
 * Callers that need the raw origin must read it HERE.
 */
export function apiBaseUrl(): string {
  return API_BASE;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    requestId?: string;
    timestamp: string;
    details?: Record<string, unknown>;
    /**
     * PHASE 13 §2 — NEW-032. Routes attach ACTIONABLE fields beside the code
     * that no fixed shape can enumerate: `methods` on a step-up challenge,
     * `plan` on a billing wall, `blockers` on a refused closure. Dropping
     * them left the component with a code it could not act on — a step-up
     * panel that knows it must re-prompt but not with which factor.
     *
     * Whatever the server sent alongside the code is preserved verbatim; the
     * named fields above stay authoritative where both exist.
     */
    [extra: string]: unknown;
  };
}

export class ApiError extends Error {
  code: string;
  statusCode: number;
  requestId?: string;
  details?: Record<string, unknown>;
  /**
   * The normalized error envelope this error was built from.
   *
   * PHASE 13 §2 — NEW-030. Sixteen call sites across the app branch on
   * `err.body?.error?.code` — the settings privacy panel's
   * `export_request_active`, the workspace-closure card's confirmation-phrase
   * message, the reviewer-ops and workflows consoles, the SIU worklist, and the
   * SHARED `extractStepUp()` that every step-up flow re-drives on. `body` was
   * never assigned, so `err.body` was `undefined` at every one of them: the
   * specific, actionable message was silently replaced by the generic fallback,
   * and a step-up challenge that should have re-prompted simply failed.
   *
   * It is the SAME object the code/message/details fields are read from, so
   * there is no second shape to keep in sync.
   */
  body: ApiErrorResponse;

  constructor(response: ApiErrorResponse, statusCode: number) {
    super(response.error.message);
    this.code = response.error.code;
    this.statusCode = statusCode;
    this.requestId = response.error.requestId;
    this.details = response.error.details;
    this.body = response;
    this.name = "ApiError";
  }
}

type GenericApiError = Error & {
  code?: string;
  statusCode?: number;
  requestId?: string;
  details?: Record<string, unknown>;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

type ApiFetchOpts = {
  auth?: boolean;
  retryAuthOnce?: boolean;
};

/**
 * In-memory only. The web app authenticates via the HttpOnly `proovra_session`
 * cookie that the backend sets after login/register/OAuth. We retain a short-
 * lived in-memory token slot for two reasons:
 *   1. immediate post-OAuth requests where the cookie may still be in flight,
 *   2. the guest-evidence-claim flow that needs to forward the guest JWT.
 *
 * NEVER persist this value to localStorage / sessionStorage / IndexedDB.
 */
let inMemoryToken: string | null = null;

export function setApiToken(token: string | null): void {
  inMemoryToken = token && token.trim() ? token : null;
}

export function readApiToken(): string | null {
  return inMemoryToken;
}

function readToken(): string | null {
  return inMemoryToken;
}

/**
 * THE ACTIVE WORKSPACE, SENT ON EVERY REQUEST.
 *
 * The client used to send no workspace identity at all — not a header, not a
 * parameter, nothing. Surfaces that needed one passed `?teamId=` by hand, and
 * the ones that forgot (every Collaboration Teams page) reached a server-side
 * resolver that answered "your Personal Space". So the product could show
 * "Northwind Legal — Organization • OWNER" in its header while reading and
 * writing a different tenant.
 *
 * Kept module-level, in memory, exactly like the auth token above: `apiFetch`
 * is a plain function called from hooks, effects, event handlers and route
 * loaders, and threading a workspace id through every one of those call sites
 * is how surfaces come to disagree about which workspace they are in. One
 * writer — `PlatformContextProvider`, when it applies an envelope — and one
 * reader.
 *
 * It is a CANDIDATE, never an authorization. The server revalidates it against
 * membership, status, expiry and organization lifecycle on every request
 * (`authorizeWorkspaceOrFail`), and a workspace the caller cannot act in is
 * refused rather than quietly swapped for one they can.
 */
export const WORKSPACE_HEADER = "x-proovra-workspace-id";

let activeWorkspaceId: string | null = null;

export function setActiveWorkspaceId(workspaceId: string | null): void {
  activeWorkspaceId =
    workspaceId && workspaceId.trim() ? workspaceId.trim() : null;
}

export function readActiveWorkspaceId(): string | null {
  return activeWorkspaceId;
}

/**
 * Does this 401 carry a code the server chose, rather than "no credential"?
 *
 * Read from a CLONE so the caller still owns an unconsumed body. A body that
 * is absent, unparseable or carries the generic `UNAUTHORIZED` code is the
 * credential-in-flight case the retry was written for; anything else is a
 * decision.
 */
async function namesADeliberateDenial(res: Response): Promise<boolean> {
  let text = "";
  try {
    text = await res.clone().text();
  } catch {
    // A body that cannot be read tells us nothing; fall back to the historical
    // behaviour rather than suppressing a retry that may be legitimate.
    return false;
  }
  if (!text.trim()) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const envelope = parsed as
    | { error?: { code?: unknown }; code?: unknown }
    | null;
  const code =
    typeof envelope?.error?.code === "string"
      ? envelope.error.code
      : typeof envelope?.code === "string"
        ? envelope.code
        : null;
  if (!code) return false;
  return code !== "UNAUTHORIZED";
}

async function fetchWithAuthRetry(
  url: string,
  init: RequestInit,
  opts: Required<Pick<ApiFetchOpts, "auth" | "retryAuthOnce">>
) {
  const makeHeaders = () => {
    const headers = new Headers(init.headers);

    if (!headers.has("content-type") && init.body) {
      headers.set("content-type", "application/json");
    }

    if (typeof window !== "undefined") {
      headers.set("x-web-client", "1");
    }

    // The workspace the operator is looking at. Never overrides an explicit
    // per-request binding a caller has already set.
    if (!headers.has(WORKSPACE_HEADER)) {
      const workspaceId = readActiveWorkspaceId();
      if (workspaceId) headers.set(WORKSPACE_HEADER, workspaceId);
    }

    const token = readToken();
    if (opts.auth && token) {
      headers.set("authorization", `Bearer ${token}`);
    } else {
      headers.delete("authorization");
    }

    return headers;
  };

  const first = await fetch(url, {
    ...init,
    headers: makeHeaders(),
    credentials: "include",
    cache: "no-store",
  });

  if (first.status !== 401 || !opts.retryAuthOnce) {
    return first;
  }

  /**
   * PHASE 13 (NEW-035) — a 401 that NAMES a decision is not replayed.
   *
   * This retry exists for exactly one situation: the credential had not
   * arrived yet (the post-OAuth window where the `proovra_session` cookie is
   * still in flight), which the server answers with the generic `UNAUTHORIZED`
   * envelope. Re-issuing then is harmless, because the first request was
   * refused before it did anything.
   *
   * It was replaying EVERY 401, and step-up denials are 401s. So every
   * sensitive mutation the step-up gate challenged — workspace closure,
   * ownership transfer, publication — was SENT TWICE with no user intent: two
   * of the five-per-minute step-up attempts consumed, two `step_up_denied`
   * audit events for one click, and a second POST at a boundary where the
   * server had already stated its decision.
   *
   * A code other than `UNAUTHORIZED` means the server evaluated the request
   * and refused it deliberately. Repeating it cannot change the answer, so the
   * only thing a replay can produce is a duplicate side effect.
   */
  if (await namesADeliberateDenial(first)) {
    return first;
  }

  const second = await fetch(url, {
    ...init,
    headers: makeHeaders(),
    credentials: "include",
    cache: "no-store",
  });

  return second;
}

/**
 * ONE READ IN FLIGHT PER URL.
 *
 * A single page mount can ask several independent components the same
 * question at the same instant. Measured on /home in an organization
 * workspace: 17 distinct endpoints, but `/v1/billing/overview` requested by
 * three components, and `/v1/ops/incidents` and
 * `/v1/reviewer-ops/escalations` by two each — all within a few milliseconds
 * of one another, because none of them knows the others exist. Each extra
 * copy costs a full round trip and a repeat of the same server work, and on
 * a slow connection those are paid in series with everything else the page
 * is waiting for.
 *
 * So identical GETs that OVERLAP IN TIME share one request. The narrowness
 * is the point:
 *
 *   - It is not a cache. The entry is dropped the moment the request
 *     settles, so a later read always goes to the server and nothing here
 *     can ever serve a stale answer. Two sequential reads still make two
 *     requests, which is what a caller re-reading after a write expects.
 *   - GET only, and only without a body. A POST/PATCH/DELETE is a side
 *     effect; two of them are two intentions and must never be merged.
 *   - Not when the caller passed an `AbortSignal`. A shared request aborted
 *     by whichever caller unmounted first would fail the others, and the
 *     bug that produces is invisible and intermittent.
 *   - The key includes the auth options, so an authenticated read and an
 *     anonymous one of the same path stay separate requests.
 *
 * Every caller after the first gets a structured clone, so no two
 * components end up holding the same mutable object.
 */
const inFlightReads = new Map<string, Promise<unknown>>();

function readKeyFor(
  url: string,
  init: RequestInit,
  opts: ApiFetchOpts | undefined,
): string | null {
  /* Browser only. This module is already a per-browser singleton (it holds
     the in-memory token in a module variable), but a shared map keyed without
     the caller identity would be a cross-request leak in any server runtime,
     so the sharing is switched off where there is no single user to share
     between rather than left to depend on where the module happens to load. */
  if (typeof window === "undefined") return null;

  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET") return null;
  if (init.body != null) return null;
  if (init.signal) return null;
  return `${url}|auth:${opts?.auth !== false}|retry:${opts?.retryAuthOnce !== false}`;
}

function cloneResult(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  try {
    return structuredClone(value);
  } catch {
    /* A payload that cannot be cloned is returned as-is rather than
       dropped — sharing a reference is a far smaller problem than failing
       the read. */
    return value;
  }
}

export async function apiFetch(
  path: string,
  init: RequestInit = {},
  opts?: ApiFetchOpts
) {
  const key = readKeyFor(
    `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`,
    init,
    opts,
  );

  if (!key) return runApiFetch(path, init, opts);

  const existing = inFlightReads.get(key);
  if (existing) return cloneResult(await existing);

  const pending = runApiFetch(path, init, opts);
  inFlightReads.set(key, pending);
  try {
    return await pending;
  } finally {
    inFlightReads.delete(key);
  }
}

async function runApiFetch(
  path: string,
  init: RequestInit = {},
  opts?: ApiFetchOpts
) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${API_BASE}${normalizedPath}`;

  const finalOpts = {
    auth: opts?.auth !== false,
    retryAuthOnce: opts?.retryAuthOnce !== false,
  };

  let res: Response;
  try {
    res = await fetchWithAuthRetry(url, init, finalOpts);
  } catch (err: unknown) {
    const e: GenericApiError = new Error(
      err instanceof Error ? err.message : "Network error while calling API"
    );
    e.code = "NETWORK_ERROR";
    e.statusCode = 0;
    throw e;
  }

  if (!res.ok) {
    const headerReqId = res.headers.get("x-request-id") ?? undefined;

    let raw = "";
    try {
      raw = await res.text();
    } catch {
      raw = "";
    }

    let parsed: unknown = null;
    try {
      parsed = raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      parsed = null;
    }

    const obj = asObject(parsed);
    const errObj = obj ? asObject(obj["error"]) : null;

    /**
     * A NESTED CODE IS THE STANDARD SHAPE, message or not.
     *
     * PHASE 13 §2 — NEW-032. This required BOTH `code` and `message` to be
     * strings, so `{ error: { code: "STEP_UP_REQUIRED", methods: ["totp"] } }`
     * — a real response from the step-up gate — failed the test and fell to the
     * generic branch below, which throws a plain Error carrying NO `body` and
     * a code of "API_ERROR". Every `err.body?.error?.code` branch therefore
     * missed it, the step-up panel never reopened, and `methods` never reached
     * the component. NEW-030 gave `ApiError` a `body`; this is the other half
     * — making sure the error becomes an `ApiError` in the first place.
     *
     * The message is now optional and falls back to a bounded, user-safe
     * sentence rather than to a raw response body.
     */
    const hasNestedCode = !!errObj && typeof errObj["code"] === "string";

    if (hasNestedCode) {
      const requestIdFromBody =
        typeof errObj["requestId"] === "string"
          ? (errObj["requestId"] as string)
          : undefined;

      const timestampFromBody =
        typeof errObj["timestamp"] === "string"
          ? (errObj["timestamp"] as string)
          : undefined;

      const detailsFromBodyRaw = errObj["details"];
      const detailsFromBody =
        detailsFromBodyRaw && typeof detailsFromBodyRaw === "object"
          ? (detailsFromBodyRaw as Record<string, unknown>)
          : undefined;

      const nestedMessage =
        typeof errObj["message"] === "string" && errObj["message"].trim().length > 0
          ? (errObj["message"] as string)
          : `HTTP ${res.status}: API error`;

      const normalized: ApiErrorResponse = {
        error: {
          // Everything the server sent beside the code survives — `methods`,
          // `blockers`, `plan` — then the normalized fields win.
          ...(errObj as Record<string, unknown>),
          code: String(errObj["code"]),
          message: nestedMessage,
          requestId: requestIdFromBody ?? headerReqId,
          timestamp: timestampFromBody ?? new Date().toISOString(),
          details: detailsFromBody,
        },
      };

      throw new ApiError(normalized, res.status);
    }

    const messageFromBody =
      obj && typeof obj["message"] === "string"
        ? (obj["message"] as string)
        : "";

    const codeFromBody =
      obj && typeof obj["code"] === "string" ? (obj["code"] as string) : "";

    const detailsFromBody =
      obj && typeof obj["details"] === "object" && obj["details"] !== null
        ? (obj["details"] as Record<string, unknown>)
        : undefined;

    const billingWall =
      obj && typeof obj["billingWall"] === "object" && obj["billingWall"] !== null
        ? (obj["billingWall"] as Record<string, unknown>)
        : undefined;

    // Evidence Lifecycle REAL FIX — some legacy routes return denial info at
    // TOP LEVEL of the error body (e.g. `{denial: "ENTITLEMENT_REQUIRED",
    // entitlement: "FEATURE_X"}`) instead of nesting it under `details`.
    // Pre-fix, `error.details` was undefined for these responses, so the
    // frontend's denial mapper never matched and rendered a generic error
    // instead of the entitlement panel. We now treat the whole body as
    // `details` when no explicit `details` field is present AND the body
    // contains canonical denial fields. This is additive — routes already
    // sending `details` are unaffected.
    const topLevelDenialFields = ["denial", "entitlement", "requiredTier", "requiredEntitlement"];
    const bodyHasTopLevelDenial =
      obj &&
      !detailsFromBody &&
      topLevelDenialFields.some((k) => typeof obj[k] === "string");
    const promotedDetails = bodyHasTopLevelDenial
      ? (obj as Record<string, unknown>)
      : undefined;

    const message =
      messageFromBody || (raw && raw.trim()) || `HTTP ${res.status}: API error`;

    const requestIdFromBody =
      obj && typeof obj["requestId"] === "string"
        ? (obj["requestId"] as string)
        : undefined;

    const requestId = requestIdFromBody ?? headerReqId;

    // Do NOT inline the requestId into the message (it read like a stack
    // trace). It stays on `error.requestId` for `toSafeUserError` to
    // surface as a copyable support reference.
    const error: GenericApiError = new Error(message);

    error.code =
      codeFromBody ||
      (typeof obj?.["denial"] === "string" ? (obj["denial"] as string) : "") ||
      (res.status === 401 ? "UNAUTHORIZED" : "API_ERROR");
    error.statusCode = res.status;
    error.requestId = requestId;
    error.details = detailsFromBody ?? promotedDetails ?? billingWall;

    throw error;
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return null;
  }

  try {
    return await res.json();
  } catch {
    const error: GenericApiError = new Error("Invalid response format");
    error.code = "PARSE_ERROR";
    error.statusCode = res.status;
    throw error;
  }
}