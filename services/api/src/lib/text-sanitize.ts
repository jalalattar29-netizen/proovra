/**
 * Canonical text sanitizers for control / invisible characters.
 *
 * These are deliberately implemented as explicit code-point scans rather than
 * regular expressions: a regex character class covering C0/C1 control
 * characters can only be written by embedding those characters into source
 * (literally, or via `\x..` / `\u....` escapes, which ESLint treats
 * identically). Embedded control characters are unreviewable in a diff and are
 * flagged by `no-control-regex`. A code-point predicate is exactly equivalent,
 * is readable, and needs no lint suppression.
 *
 * Every helper here is pure and allocation-bounded by its input length.
 */

/** C0 controls: U+0000–U+001F. Always in scope. */
function isC0(cp: number): boolean {
  return cp <= 0x1f;
}

/** DEL: U+007F. */
function isDel(cp: number): boolean {
  return cp === 0x7f;
}

/** C1 controls: U+0080–U+009F. */
function isC1(cp: number): boolean {
  return cp >= 0x80 && cp <= 0x9f;
}

/**
 * Zero-width and bidirectional-override characters. These are invisible but
 * can reorder or hide rendered text, so untrusted input must not carry them
 * into a prompt, a report, or an index.
 *
 *   U+200B–U+200F  zero-width space/non-joiner/joiner, LRM, RLM
 *   U+202A–U+202E  LRE, RLE, PDF, LRO, RLO
 *   U+2066–U+2069  LRI, RLI, FSI, PDI
 *   U+FEFF         zero-width no-break space (BOM)
 */
function isInvisibleFormatting(cp: number): boolean {
  return (
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0xfeff
  );
}

export type ControlScanOptions = {
  /**
   * Code points exempted from the scan — e.g. `[0x09, 0x0a]` to let TAB and LF
   * through. Defaults to none (every in-scope control character is stripped).
   */
  keep?: readonly number[];
  /** Include DEL (U+007F) in the scan. Defaults to true. */
  del?: boolean;
  /** Include C1 controls (U+0080–U+009F) in the scan. Defaults to false. */
  c1?: boolean;
};

function buildMatcher(options: ControlScanOptions): (cp: number) => boolean {
  const keep = new Set(options.keep ?? []);
  const includeDel = options.del !== false;
  const includeC1 = options.c1 === true;
  return (cp: number): boolean => {
    if (keep.has(cp)) return false;
    return isC0(cp) || (includeDel && isDel(cp)) || (includeC1 && isC1(cp));
  };
}

/** True when the string contains any in-scope control character. */
export function hasControlCharacters(
  input: string,
  options: ControlScanOptions = {},
): boolean {
  const matches = buildMatcher(options);
  for (const ch of input) {
    if (matches(ch.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/** True when the string carries any zero-width / bidi-override character. */
export function hasInvisibleFormatting(input: string): boolean {
  for (const ch of input) {
    if (isInvisibleFormatting(ch.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/**
 * Collapse every *run* of in-scope control characters into a single space,
 * then trim.
 *
 * Equivalent to `input.replace(/[<controls>]+/g, " ").trim()` — runs collapse
 * to one space so a stripped block of binary noise does not explode into
 * hundreds of spaces.
 */
export function collapseControlCharacters(
  input: string,
  options: ControlScanOptions = {},
): string {
  const matches = buildMatcher(options);
  let out = "";
  let inRun = false;
  for (const ch of input) {
    if (matches(ch.codePointAt(0) ?? 0)) {
      if (!inRun) {
        out += " ";
        inRun = true;
      }
      continue;
    }
    inRun = false;
    out += ch;
  }
  return out.trim();
}

/**
 * Replace each in-scope control character with a single space, preserving
 * length and leading/trailing whitespace.
 *
 * Equivalent to `input.replace(/[<controls>]/g, " ")` — used where a
 * downstream length budget is computed against the sanitized string, so
 * collapsing runs would change the truncation point.
 */
export function blankControlCharacters(
  input: string,
  options: ControlScanOptions = {},
): string {
  const matches = buildMatcher(options);
  let out = "";
  for (const ch of input) {
    out += matches(ch.codePointAt(0) ?? 0) ? " " : ch;
  }
  return out;
}

/**
 * Remove (not replace) every control character except TAB/LF/CR, plus every
 * zero-width and bidi-override character.
 *
 * Used on untrusted free text before it is embedded in an AI prompt envelope:
 * there the injected invisible character *is* the attack, and substituting a
 * space would leave a visible artifact of it in the prompt.
 */
export function stripControlAndInvisible(input: string): string {
  const matches = buildMatcher({ keep: [0x09, 0x0a, 0x0d], del: true, c1: false });
  let out = "";
  for (const ch of input) {
    const cp = ch.codePointAt(0) ?? 0;
    if (matches(cp)) continue;
    if (isInvisibleFormatting(cp)) continue;
    out += ch;
  }
  return out;
}
