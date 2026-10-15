/**
 * AUD-022 — THE error-telemetry scrubber (Sentry) for every PROOVRA surface:
 * API, worker, web and mobile.
 *
 * Each surface used to carry its own `beforeSend` and they disagreed. The API
 * and worker scrubbed only transaction HEADERS and passed error events through
 * untouched; mobile missed breadcrumb messages, extra, user and exception
 * values; the web scrubber returned the RAW event when it threw. An error
 * report is a copy of runtime state sent to a third party, so it must not carry
 * a credential, a bearer capability or a person's address in ANY field.
 *
 * Every location a Sentry event can carry text is covered:
 *   request.url / query_string / cookies / headers / data / env,
 *   message and logentry, exception values (and frame vars), breadcrumbs
 *   (message + data), extra, contexts, tags, user, transaction name, spans.
 *
 * What is removed:
 *   - credentials by KEY: the canonical log-redaction keys
 *     (`shouldRedactKey`, observability.ts) plus authorization, cookie,
 *     session, signature, credential, password, email, phone and the
 *     Proovra capability headers;
 *   - credentials by SHAPE in free text: JWTs, `Bearer …`, known secret
 *     prefixes (Stripe, webhook, share tokens), `key=value` credentials;
 *   - every URL query string (signed URLs: X-Amz-*, tokens, OAuth codes) and
 *     the bearer segment of token-carrying paths (verify/share/intake/portal,
 *     external intake and review, invites, OAuth callbacks);
 *   - request bodies, entirely; cookies, entirely;
 *   - email addresses; user fields other than an opaque id;
 *   - with `identifiers: true` (the client surfaces, per the web privacy
 *     policy in apps/web/lib/privacy/redact.ts): UUIDs (evidence, case and
 *     record ids) and long opaque tokens.
 *
 * FAILS CLOSED: if scrubbing throws, the event is dropped (null), never sent
 * raw. The module is pure and dependency-free (no `URL`, no Node APIs) so the
 * React Native bundle can use it unchanged.
 */
import { shouldRedactKey } from "./observability.js";

export const TELEMETRY_REDACTED = "[redacted]";

export type TelemetryScrubOptions = {
  /** Also redact UUIDs and long opaque tokens (client surfaces). */
  identifiers?: boolean;
};

const MAX_DEPTH = 8;

/** Keys whose VALUE is never sent, whatever it looks like. */
const SENSITIVE_KEY =
  /(authorization|cookie|session|bearer|signature|credential|passw|secret|private[-_]?key|e-?mail|phone|x-amz|x-api-key|x-internal-key|step-up|portal-session|intake-session|ip_address|remote_addr)/i;

export function isSensitiveTelemetryKey(key: string): boolean {
  return shouldRedactKey(key) || SENSITIVE_KEY.test(key);
}

/** Path prefixes whose NEXT segment is a bearer capability. */
const TOKEN_PATH_PREFIXES: readonly string[] = [
  "/verify/",
  "/v/",
  "/share/",
  "/intake/",
  "/portal/",
  "/public/verify/",
  "/v1/public/verify/",
  "/v1/external-intake/",
  "/external-intake/",
  "/v1/external-review/access/",
  "/external-review/",
  "/v1/org-invites/",
  "/org-invites/",
  "/v1/teams/invites/",
  "/invites/",
  "/v1/collaboration-team-invites/",
  "/collaboration-teams/invites/",
  "/reset-password/",
  "/auth/callback/",
];

const JWT = /\beyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g;
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_PREFIX =
  /\b(?:sk_(?:live|test)_|rk_(?:live|test)_|pk_(?:live|test)_|whsec_|pvs_|re_[A-Za-z0-9]{6}|AKIA|ASIA|ghp_|gho_|xox[abpr]-)[A-Za-z0-9_-]*/g;
const KEY_VALUE_CREDENTIAL =
  /\b([A-Za-z0-9_-]*?(?:x-amz-[a-z-]+|token|code|state|code_verifier|signature|sig|key|secret|passw(?:or)?d|session|credential))=([^&\s"'<>;,]+)/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{24,}\b/g;
/** An absolute URL, or a path that carries a query string. */
const URL_LIKE = /(?:https?:\/\/[^\s"'<>]+|\/[A-Za-z0-9._~%!$&()*+,;=:@/-]*\?[^\s"'<>]*)/gi;

/** Characters that end a path segment, in a URL or in free text. */
const SEGMENT_END = "/?#&= \t\n\r\"'<>,;)]}";

function redactTokenPath(path: string): string {
  const out = path;
  const lower = out.toLowerCase();
  for (const prefix of TOKEN_PATH_PREFIXES) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(prefix, from);
      if (at < 0) break;
      const start = at + prefix.length;
      let end = start;
      while (end < out.length && !SEGMENT_END.includes(out[end]!)) end += 1;
      if (end > start && !out.startsWith(TELEMETRY_REDACTED, start)) {
        return redactTokenPath(out.slice(0, start) + TELEMETRY_REDACTED + out.slice(end));
      }
      from = start;
    }
  }
  return out;
}

/** A URL with its query and fragment removed and bearer path segments redacted. */
export function scrubTelemetryUrl(url: string, options: TelemetryScrubOptions = {}): string {
  const hashAt = url.indexOf("#");
  const noHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const queryAt = noHash.indexOf("?");
  const base = queryAt >= 0 ? noHash.slice(0, queryAt) : noHash;
  const schemeAt = base.indexOf("://");
  const pathStart = schemeAt >= 0 ? base.indexOf("/", schemeAt + 3) : 0;
  const origin = pathStart > 0 ? base.slice(0, pathStart) : schemeAt >= 0 ? base : "";
  const path = pathStart >= 0 ? base.slice(pathStart) : "";
  let safePath = redactTokenPath(path);
  safePath = scrubFreeText(safePath, options, false);
  const safeOrigin = origin.replace(/\/\/[^/@]*@/, "//"); // userinfo
  return `${safeOrigin}${safePath}${queryAt >= 0 ? `?${TELEMETRY_REDACTED}` : ""}`;
}

function scrubFreeText(text: string, options: TelemetryScrubOptions, urls: boolean): string {
  let out = text;
  if (urls) out = redactTokenPath(out.replace(URL_LIKE, (u) => scrubTelemetryUrl(u, options)));
  out = out
    .replace(JWT, "[jwt]")
    .replace(AUTH_SCHEME, (_m, scheme: string) => `${scheme} ${TELEMETRY_REDACTED}`)
    .replace(SECRET_PREFIX, TELEMETRY_REDACTED)
    .replace(KEY_VALUE_CREDENTIAL, (_m, key: string) => `${key}=${TELEMETRY_REDACTED}`)
    .replace(EMAIL, "[email]");
  if (options.identifiers) {
    out = out.replace(UUID, "[uuid]").replace(LONG_TOKEN, (m) => (m.startsWith("[") ? m : "[token]"));
  }
  return out;
}

/** Scrub one free-text string (messages, exception values, transaction names). */
export function scrubTelemetryText(text: string, options: TelemetryScrubOptions = {}): string {
  return scrubFreeText(text, options, true);
}

/**
 * Deep-scrub any value: sensitive KEYS are replaced, every string is scrubbed
 * as free text. Bounded in depth; cycles are cut.
 */
export function scrubTelemetryValue(
  value: unknown,
  options: TelemetryScrubOptions = {},
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === "string") return scrubTelemetryText(value, options);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[max_depth]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => scrubTelemetryValue(v, options, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveTelemetryKey(key)
      ? TELEMETRY_REDACTED
      : scrubTelemetryValue(v, options, depth + 1, seen);
  }
  return out;
}

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => v !== null && typeof v === "object" && !Array.isArray(v);

/** Scrub one breadcrumb. Null (drop it) when scrubbing fails. */
export function scrubTelemetryBreadcrumb<T>(breadcrumb: T, options: TelemetryScrubOptions = {}): T | null {
  try {
    if (!isBag(breadcrumb)) return breadcrumb;
    const b: Bag = { ...breadcrumb };
    if (typeof b.message === "string") b.message = scrubTelemetryText(b.message, options);
    if (isBag(b.data)) {
      const data = scrubTelemetryValue(b.data, options) as Bag;
      for (const k of ["url", "to", "from"]) {
        if (typeof data[k] === "string") data[k] = scrubTelemetryUrl(data[k] as string, options);
      }
      b.data = data;
    }
    return b as T;
  } catch {
    return null;
  }
}

function scrubHeaders(headers: unknown, options: TelemetryScrubOptions): unknown {
  if (!isBag(headers)) return headers;
  const out: Bag = {};
  for (const [key, v] of Object.entries(headers)) {
    if (isSensitiveTelemetryKey(key) || /^set-cookie$/i.test(key) || /^x-proovra-/i.test(key)) {
      out[key] = TELEMETRY_REDACTED;
    } else if (/^referer$/i.test(key) && typeof v === "string") {
      out[key] = scrubTelemetryUrl(v, options);
    } else {
      out[key] = typeof v === "string" ? scrubTelemetryText(v, options) : scrubTelemetryValue(v, options);
    }
  }
  return out;
}

function scrubException(exception: unknown, options: TelemetryScrubOptions): unknown {
  if (!isBag(exception) || !Array.isArray(exception.values)) return exception;
  return {
    ...exception,
    values: exception.values.map((raw) => {
      if (!isBag(raw)) return raw;
      const v: Bag = { ...raw };
      if (typeof v.value === "string") v.value = scrubTelemetryText(v.value, options);
      if (isBag(v.stacktrace) && Array.isArray(v.stacktrace.frames)) {
        v.stacktrace = {
          ...v.stacktrace,
          frames: v.stacktrace.frames.map((f) =>
            isBag(f)
              ? {
                  ...f,
                  ...(f.vars !== undefined ? { vars: scrubTelemetryValue(f.vars, options) } : {}),
                  ...(Array.isArray(f.pre_context) ? { pre_context: scrubTelemetryValue(f.pre_context, options) } : {}),
                  ...(typeof f.context_line === "string" ? { context_line: scrubTelemetryText(f.context_line, options) } : {}),
                  ...(Array.isArray(f.post_context) ? { post_context: scrubTelemetryValue(f.post_context, options) } : {}),
                }
              : f,
          ),
        };
      }
      return v;
    }),
  };
}

/**
 * Scrub a whole Sentry event (error or transaction). Returns the event with
 * every sensitive value removed, or null — drop it — when scrubbing fails.
 */
export function scrubTelemetryEvent<T>(event: T, options: TelemetryScrubOptions = {}): T | null {
  try {
    if (!isBag(event)) return event;
    const e: Bag = { ...event };

    if (isBag(e.request)) {
      const r: Bag = { ...e.request };
      if (typeof r.url === "string") r.url = scrubTelemetryUrl(r.url, options);
      if (r.query_string !== undefined) r.query_string = TELEMETRY_REDACTED;
      if (r.cookies !== undefined) r.cookies = TELEMETRY_REDACTED;
      // Request bodies are never sent: a body is where passwords, tokens,
      // evidence metadata and personal data travel.
      if (r.data !== undefined) r.data = TELEMETRY_REDACTED;
      if (r.headers !== undefined) r.headers = scrubHeaders(r.headers, options);
      if (r.env !== undefined) r.env = scrubTelemetryValue(r.env, options);
      e.request = r;
    }

    if (typeof e.message === "string") e.message = scrubTelemetryText(e.message, options);
    else if (e.message !== undefined) e.message = scrubTelemetryValue(e.message, options);
    if (e.logentry !== undefined) e.logentry = scrubTelemetryValue(e.logentry, options);
    if (typeof e.transaction === "string") e.transaction = scrubTelemetryText(e.transaction, options);
    if (e.exception !== undefined) e.exception = scrubException(e.exception, options);

    if (Array.isArray(e.breadcrumbs)) {
      e.breadcrumbs = e.breadcrumbs
        .map((b) => scrubTelemetryBreadcrumb(b, options))
        .filter((b) => b !== null);
    } else if (isBag(e.breadcrumbs) && Array.isArray(e.breadcrumbs.values)) {
      e.breadcrumbs = {
        ...e.breadcrumbs,
        values: e.breadcrumbs.values
          .map((b) => scrubTelemetryBreadcrumb(b, options))
          .filter((b) => b !== null),
      };
    }

    for (const key of ["extra", "contexts", "tags"] as const) {
      if (e[key] !== undefined) e[key] = scrubTelemetryValue(e[key], options);
    }

    if (e.user !== undefined) {
      // Only an opaque id survives: never email, username, IP or name.
      const id = isBag(e.user) ? e.user.id : undefined;
      e.user =
        typeof id === "string" || typeof id === "number" ? { id: String(id) } : undefined;
    }

    if (Array.isArray(e.spans)) {
      e.spans = e.spans.map((s) =>
        isBag(s)
          ? {
              ...s,
              ...(typeof s.description === "string" ? { description: scrubTelemetryText(s.description, options) } : {}),
              ...(s.data !== undefined ? { data: scrubTelemetryValue(s.data, options) } : {}),
            }
          : s,
      );
    }
    return e as T;
  } catch {
    return null;
  }
}
