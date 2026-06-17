/**
 * Phase 400-CLIENT-ERROR-HARDENING — canonical client-error detector.
 *
 * Fastify itself emits a family of FST_ERR_* codes for malformed
 * client requests:
 *
 *   FST_ERR_CTP_INVALID_JSON_BODY      → 400 (body claims JSON, isn't)
 *   FST_ERR_CTP_BODY_TOO_LARGE         → 413
 *   FST_ERR_CTP_INVALID_CONTENT_LENGTH → 400
 *   FST_ERR_CTP_INVALID_MEDIA_TYPE     → 415
 *   FST_ERR_VALIDATION                 → 400 (schema)
 *
 * These are CLIENT behaviour (typically bots probing endpoints), not
 * server-side bugs. Anything we previously routed through
 * `captureException` for these errors was Sentry noise.
 *
 * `readFastifyClientError` duck-types the FastifyError shape (code
 * starting with `FST_ERR_` and statusCode in 4xx) and returns a safe
 * wire-shape view. Returns `null` for anything that isn't a Fastify
 * client error so callers can fall through to their normal path.
 *
 * Duck typing is deliberate: the FastifyError class identity is not
 * stable across Fastify minor versions, but the wire shape is.
 */

export type FastifyClientErrorView = {
  code: string;
  statusCode: number;
  error: string;
  message: string;
};

export function readFastifyClientError(
  err: unknown,
): FastifyClientErrorView | null {
  if (!err || typeof err !== "object") return null;
  const e = err as {
    code?: unknown;
    statusCode?: unknown;
    name?: unknown;
    message?: unknown;
  };
  const code = typeof e.code === "string" ? e.code : "";
  const statusCode = typeof e.statusCode === "number" ? e.statusCode : 0;
  const name = typeof e.name === "string" ? e.name : "";
  const isFastifyShape =
    name === "FastifyError" || code.startsWith("FST_ERR_");
  if (!isFastifyShape) return null;
  if (statusCode < 400 || statusCode >= 500) return null;
  const messageSource = typeof e.message === "string" ? e.message : "";
  let safeMessage = messageSource;
  let errorLabel = "Bad Request";
  switch (code) {
    case "FST_ERR_CTP_INVALID_JSON_BODY":
      safeMessage = "Invalid JSON body";
      errorLabel = "Bad Request";
      break;
    case "FST_ERR_CTP_BODY_TOO_LARGE":
      safeMessage = "Request body too large";
      errorLabel = "Payload Too Large";
      break;
    case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
      safeMessage = "Unsupported media type";
      errorLabel = "Unsupported Media Type";
      break;
    case "FST_ERR_CTP_INVALID_CONTENT_LENGTH":
      safeMessage = "Invalid content length";
      errorLabel = "Bad Request";
      break;
    default:
      errorLabel =
        statusCode === 415
          ? "Unsupported Media Type"
          : statusCode === 413
            ? "Payload Too Large"
            : "Bad Request";
      break;
  }
  return { code, statusCode, error: errorLabel, message: safeMessage };
}
