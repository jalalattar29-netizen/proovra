/**
 * PROOVRA Feedback System — field-level validation errors.
 *
 * The API's global error handler rejects a bad request body with a bounded
 * envelope:
 *
 *   { error: { code: "INVALID_INPUT",
 *              message: "Invalid input: email — Invalid email address",
 *              fields: [{ path: "email", code: "invalid_format",
 *                         message: "Invalid email address" }] } }
 *
 * The `fields` array is the whole point: the server already knows WHICH input
 * it rejected. Before this module every surface threw that away, ran the
 * envelope through `toSafeUserError`, and rendered one top-level banner
 * reading "please review your input and try again" — which is exactly the
 * pattern the audit set out to remove. The information was on the wire; the
 * UI simply had nowhere to put it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is NOT a second error-display path. `toSafeUserError` remains the one
 * authority for the request-level message, and a caller uses both: the banner
 * says what happened, the field map says where. Nor does it ever return the
 * server's own sentence for an unrecognised field — a validator message is
 * only shown for a field the CALLER declared it renders, so a schema key the
 * UI has never heard of cannot become customer-facing copy by accident.
 */

/** A field name the caller renders, mapped to the message to show beneath it. */
export type FieldErrorMap = Record<string, string>;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The validator entries an error carries, from either shape the platform
 * emits: the canonical `error.fields[]` array, or the older single-field
 * `error.details.field` some routes still use.
 */
function readEntries(error: unknown): { path: string; message: string | null }[] {
  const err = asRecord(error);
  if (!err) return [];

  // `ApiError.body` is the normalized envelope; a plain thrown object may
  // carry the envelope directly. Both are read, neither is required.
  const envelope =
    asRecord(asRecord(err.body)?.error) ?? asRecord(err.error) ?? err;

  const out: { path: string; message: string | null }[] = [];

  const fields = envelope.fields;
  if (Array.isArray(fields)) {
    for (const raw of fields) {
      const entry = asRecord(raw);
      if (!entry) continue;
      // `path` is a dotted string from zod; only the leaf matters to a form.
      const path = readString(entry.path) ?? readString(entry.field);
      if (!path) continue;
      out.push({
        path: path.split(".").pop() as string,
        message: readString(entry.message),
      });
    }
  }

  const details = asRecord(envelope.details);
  const singleField = details ? readString(details.field) : null;
  if (singleField) {
    out.push({
      path: singleField.split(".").pop() as string,
      message: readString(details?.reason),
    });
  }

  return out;
}

/**
 * The subset of an error's field failures that this surface can actually
 * render, keyed by field name.
 *
 * `known` is the contract. A caller passes the fields it has inputs for, and
 * anything else the server rejected is dropped rather than shown — an
 * unrendered key would otherwise turn into an orphaned sentence with no
 * control beside it, and a schema-internal name would leak into the UI.
 *
 * `fallbacks` supplies the product's own wording for a field. It is preferred
 * over the validator's sentence, because "Invalid email address" is a
 * schema's phrasing and the product usually has a better one. A field with no
 * fallback falls back to the validator message, and a field with neither is
 * still returned — with an empty string — so the caller can mark the input
 * invalid even when it has nothing to say about it.
 */
export function fieldErrorsFromApiError(
  error: unknown,
  known: readonly string[],
  fallbacks: Readonly<Record<string, string>> = {},
): FieldErrorMap {
  const allowed = new Set(known);
  const out: FieldErrorMap = {};
  for (const entry of readEntries(error)) {
    if (!allowed.has(entry.path) || out[entry.path] !== undefined) continue;
    out[entry.path] = fallbacks[entry.path] ?? entry.message ?? "";
  }
  return out;
}

/** Whether an error carried any field failure this surface renders. */
export function hasFieldErrors(map: FieldErrorMap): boolean {
  return Object.keys(map).length > 0;
}
