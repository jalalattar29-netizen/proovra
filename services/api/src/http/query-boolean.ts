/**
 * B2A-F-20 (free-audit 0ea0) — a boolean query parameter that reads "false" as
 * false.
 *
 * `z.coerce.boolean()` is `Boolean(value)`: every non-empty string is true, so
 * `?failClosedOnly=false` returned only fail-closed rows and `?export=false`
 * demanded `audit.export`. Query strings carry text, so the text is parsed:
 * "true"/"1" are true, "false"/"0"/"" are false, a real boolean passes through,
 * and anything else is a validation error rather than a silent `true`.
 */
import { z } from "zod";

const TRUE = new Set(["true", "1"]);
const FALSE = new Set(["false", "0", ""]);

export const queryBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const v = value.trim().toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  return value;
}, z.boolean());
