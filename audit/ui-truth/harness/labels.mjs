/**
 * PHASE UI-TRUTH — user-visible label inventory (AUDIT HARNESS, not product code).
 *
 * Every string the 168 in-scope surfaces put in front of a human, parsed with
 * the TypeScript compiler API from the surface's owned files (placement.json)
 * and the apps/web files they import, two hops — the same file set the control
 * inventory used, through the shared `module-graph.mjs`.
 *
 * =============================================================================
 * WHAT COUNTS AS A LABEL
 * =============================================================================
 *   JSX text                `<h1>Evidence records</h1>`
 *   a text-rendering prop   aria-label, title, placeholder, label, heading,
 *                           description, emptyMessage, alt, confirmLabel, …
 *   a string literal that reaches the rendered text of a JSX expression
 *                           `{busy ? "Saving…" : "Save"}`
 *   a text key of a rendered object literal
 *                           `{ key: "status", label: "Status" }` — the column
 *                           header, the tile title, the toast copy.
 *
 * =============================================================================
 * WHAT IS NOT A LABEL, AND IS EXCLUDED — SAID OUT LOUD
 * =============================================================================
 * A raw-looking token is only a finding if a human reads it. These never
 * reach the screen as words, so they are dropped before classification and
 * counted in `totals.excluded` so the exclusion stays visible:
 *
 *   - `data-*` attributes (data-testid, data-state, data-problem, …). These
 *     carry machine state for tests and CSS; the console deliberately writes
 *     SCREAMING_SNAKE into them.
 *   - `className` / `class` / `style` — CSS, including the app-* and ops-*
 *     primitives, whose tokens are kebab identifiers by design.
 *   - test ids in any spelling (`testId`, `dataTestId`, `data-test-id`).
 *   - non-text plumbing props: key, value, id, name, href, src, type, role,
 *     htmlFor, defaultValue, path, slug, accessor, dataKey, field, icon, …
 *     (`value=` is the option's stored value; its `label` is what renders.)
 *   - anything inside `<code>`, `<pre>`, `<kbd>`, `<samp>`, `<script>`,
 *     `<style>`, or a `<code data-identifier>` — the DECLARED identifier that
 *     `apps/web/scripts/raw-operator-language.mjs` already allows, because an
 *     operator sometimes needs the stored key printed verbatim.
 *   - strings with no letter, URLs and paths, and CSS class lists.
 *
 * =============================================================================
 * RULEBOOK REUSE
 * =============================================================================
 * The identifier shapes, the "a call is a label" rule, the rendered-reads
 * traversal and the `<code data-identifier>` allowance are taken from the
 * standing product scanner `apps/web/scripts/raw-operator-language.mjs`
 * (PV-LANG-003). This harness widens it in three ways only: it covers every
 * in-scope surface (not just the admin console), it keeps the HUMAN_READABLE
 * strings too (an inventory, not a violation list), and it splits the raw
 * findings into the verdicts this pass has to report. Enum membership is
 * decided against the real Prisma enums in services/api/prisma/schema.prisma,
 * so RAW_ENUM means "this is a stored enum member", not "this looks shouty".
 *
 * Deterministic: sorted rows, repo-relative forward-slash paths, no
 * timestamps, no absolute paths. Two runs on an unchanged tree are
 * byte-identical.
 *
 * Usage: node audit/ui-truth/harness/labels.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REPO } from "./surfaces.mjs";
import {
  audienceOf,
  collectSurfaceFiles,
  decodeEntities,
  inScopeSurfaces,
  lineOf,
  loadModule,
  abs,
  tally,
  ts,
  walk,
} from "./module-graph.mjs";

const HARNESS = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HARNESS, "..", "data");

/* ------------------------------------------------------------------ *
 * The attribute surface
 * ------------------------------------------------------------------ */

/** Props whose string value is read by a human. */
const TEXT_ATTRS = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "actionLabel",
  "buttonLabel",
  "caption",
  "cancelLabel",
  "confirmLabel",
  "cta",
  "ctaLabel",
  "description",
  "emptyLabel",
  "emptyMessage",
  "emptyText",
  "error",
  "errorText",
  "header",
  "heading",
  "helpText",
  "helperText",
  "hint",
  "label",
  "legend",
  "message",
  "note",
  "placeholder",
  "primaryLabel",
  "reason",
  "secondaryLabel",
  "subtitle",
  "summary",
  "text",
  "title",
  "tooltip",
  "v",
]);

/** Never a label. Stated here so the exclusion is auditable, not implicit. */
const EXCLUDED_ATTRS = new Set([
  "accessor",
  "as",
  "autoComplete",
  "className",
  "class",
  "dataKey",
  "dataTestId",
  "defaultValue",
  "field",
  "for",
  "form",
  "height",
  "href",
  "htmlFor",
  "icon",
  "id",
  "key",
  "keyField",
  "name",
  "pattern",
  "path",
  "rel",
  "role",
  "slug",
  "src",
  "srcSet",
  "style",
  "target",
  "testId",
  "tone",
  "type",
  "value",
  "variant",
  "width",
]);

/** Object-literal keys that render as words (column headers, tile titles). */
const TEXT_OBJECT_KEYS = new Set([
  "actionLabel",
  "body",
  "cta",
  "description",
  "emptyMessage",
  "header",
  "heading",
  "helpText",
  "hint",
  "label",
  "message",
  "note",
  "placeholder",
  "subtitle",
  "summary",
  "title",
  "tooltip",
]);

/** Elements whose contents are code, not copy. */
const CODE_TAGS = new Set(["code", "pre", "kbd", "samp", "script", "style", "noscript"]);

const isExcludedAttrName = (n) => n.startsWith("data-") || n.startsWith("aria-hidden") || EXCLUDED_ATTRS.has(n);

/* ------------------------------------------------------------------ *
 * Shapes — reused from raw-operator-language.mjs (PV-LANG-003)
 * ------------------------------------------------------------------ */

const SCREAMING_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const DOTTED_KEY = /^[a-z][a-z0-9_]+(?:\.[a-z][a-z0-9_]+)+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALL_CAPS_WORD = /^[A-Z][A-Z0-9]{2,}$/;

/** Permission keys read like `identity.org_policy.read`. */
const PERMISSION_VERBS = new Set([
  "read",
  "write",
  "manage",
  "create",
  "delete",
  "update",
  "approve",
  "revoke",
  "grant",
  "list",
  "export",
  "admin",
  "view",
]);

/** Event names read like `evidence.record.created` / `EVIDENCE_VERIFIED`. */
const EVENT_SUFFIXES = new Set([
  "created",
  "updated",
  "deleted",
  "failed",
  "succeeded",
  "completed",
  "started",
  "queued",
  "sent",
  "received",
  "revoked",
  "granted",
  "expired",
  "verified",
  "archived",
  "restored",
  "requested",
]);

/** Machine error codes. */
const ERROR_TOKENS = [
  "ERROR",
  "FAILED",
  "FAILURE",
  "INVALID",
  "DENIED",
  "NOT_FOUND",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "REQUIRED",
  "EXPIRED",
  "EXCEEDED",
  "CONFLICT",
  "MALFORMED",
  "MISSING",
  "REJECTED",
  "TIMEOUT",
  "UNSUPPORTED",
];

/** Words that belong to the implementation, not the product. */
const DEVELOPER_WORDS = [
  "null",
  "undefined",
  "NaN",
  "stack trace",
  "stacktrace",
  "exception",
  "backend",
  "payload",
  "serialize",
  "deserialize",
  "endpoint",
  "nullable",
  "boolean",
  "enum value",
  "internal server error",
  "fetch failed",
  "typeerror",
  "http 5",
  "http 4",
  "json parse",
  "unhandled",
  "traceback",
  "db query",
  "sql",
  "prisma",
  "regex",
  "mutation failed",
  "api call",
  "request body",
];

/**
 * Acronyms this product has taught its readers, or that are universal.
 * Everything else standing alone in a label is UNEXPLAINED_ACRONYM unless the
 * label itself expands it in parentheses.
 */
const KNOWN_ACRONYMS = new Set([
  "AI",
  "API",
  "CSV",
  "EU",
  "FAQ",
  "GB",
  "ID",
  "IP",
  "KB",
  "MB",
  "OK",
  "PDF",
  "PNG",
  "UK",
  "URL",
  "US",
  "UTC",
  "VAT",
  "ZIP",
]);

/** Labels that name nothing in particular. */
const AMBIGUOUS = new Set([
  "data",
  "details",
  "entity",
  "info",
  "item",
  "items",
  "misc",
  "more",
  "n/a",
  "object",
  "other",
  "resource",
  "tbd",
  "unknown",
  "value",
]);

/* ------------------------------------------------------------------ *
 * Prisma enum universe — what RAW_ENUM is measured against
 * ------------------------------------------------------------------ */

function prismaEnumMembers() {
  const schemaPath = join(REPO, "services", "api", "prisma", "schema.prisma");
  let src;
  try {
    src = readFileSync(schemaPath, "utf8");
  } catch {
    return new Map();
  }
  const members = new Map(); // member -> sorted enum names
  for (const m of src.matchAll(/enum\s+(\w+)\s*\{([^}]*)\}/g)) {
    const name = m[1];
    for (const raw of m[2].split("\n")) {
      const line = raw.replace(/\/\/.*$/, "").trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(line)) continue;
      if (!members.has(line)) members.set(line, new Set());
      members.get(line).add(name);
    }
  }
  return new Map([...members].map(([k, v]) => [k, [...v].sort()]));
}

const ENUM_MEMBERS = prismaEnumMembers();

/* ------------------------------------------------------------------ *
 * Verdict
 * ------------------------------------------------------------------ */

/**
 * Two things only the FILE can answer, computed once per file:
 *
 *   localEnumMembers  every ALL-CAPS literal the file itself treats as a
 *                     stored value — `=== "STUCK"`, `case "BURST"`,
 *                     `"OVERLOAD" | "IMBALANCED"`. A page-local union is an
 *                     enum the schema never heard of; rendering its member is
 *                     the same finding as rendering a Prisma one, and without
 *                     this test those members read as "acronyms".
 *   expandedAcronyms  acronyms the file explains — "SLA (service level
 *                     agreement)" or "service level agreement (SLA)". An
 *                     acronym the surface teaches is not unexplained.
 */
function fileVocabulary(text) {
  const localEnumMembers = new Set();
  const patterns = [
    /[=!]==\s*"([A-Z][A-Z0-9_]{2,})"/g,
    /case\s*"([A-Z][A-Z0-9_]{2,})"/g,
    /"([A-Z][A-Z0-9_]{2,})"\s*\|/g,
    /\|\s*"([A-Z][A-Z0-9_]{2,})"/g,
    /includes\(\s*"([A-Z][A-Z0-9_]{2,})"/g,
    /\[\s*"([A-Z][A-Z0-9_]{2,})"\s*\]:/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) localEnumMembers.add(m[1]);

  const expandedAcronyms = new Set();
  for (const m of text.matchAll(/\(\s*([A-Z]{2,6})\s*\)/g)) expandedAcronyms.add(m[1]);
  for (const m of text.matchAll(/\b([A-Z]{2,6})\b\s*\(\s*[a-zA-Z]/g)) expandedAcronyms.add(m[1]);
  return { localEnumMembers, expandedAcronyms };
}

/** "endpoint" is product language on the webhooks surfaces, and only there. */
const DEVELOPER_WORD_EXCEPTIONS = { endpoint: /webhook|subscriber|subscription/i };

function classify(sRaw, vocab) {
  const s = sRaw.trim();
  const single = !/\s/.test(s);

  if (UUID.test(s)) return { verdict: "RAW_UUID_AS_IDENTITY", reason: "STRING_IS_A_UUID" };

  if (single && DOTTED_KEY.test(s)) {
    const segs = s.split(".");
    if (segs.some((x) => PERMISSION_VERBS.has(x))) {
      return { verdict: "RAW_PERMISSION_ID", reason: "DOTTED_KEY_WHOSE_LAST_SEGMENTS_ARE_PERMISSION_VERBS" };
    }
    if (segs.some((x) => EVENT_SUFFIXES.has(x))) {
      return { verdict: "RAW_EVENT_NAME", reason: "DOTTED_KEY_ENDING_IN_AN_EVENT_PARTICIPLE" };
    }
    return { verdict: "SNAKE_CASE", reason: "DOTTED_LOWERCASE_STORED_KEY" };
  }

  if (single && SCREAMING_SNAKE.test(s)) {
    if (ERROR_TOKENS.some((t) => s.includes(t))) {
      return { verdict: "RAW_ERROR_CODE", reason: "SCREAMING_SNAKE_CONTAINING_A_FAILURE_TOKEN" };
    }
    const segs = s.toLowerCase().split("_");
    if (segs.some((x) => EVENT_SUFFIXES.has(x))) {
      return { verdict: "RAW_EVENT_NAME", reason: "SCREAMING_SNAKE_ENDING_IN_AN_EVENT_PARTICIPLE" };
    }
    if (ENUM_MEMBERS.has(s)) {
      return { verdict: "RAW_ENUM", reason: `DECLARED_PRISMA_ENUM_MEMBER_OF_${ENUM_MEMBERS.get(s).join("+")}` };
    }
    return { verdict: "SCREAMING_SNAKE", reason: "SCREAMING_SNAKE_IDENTIFIER_SHAPE" };
  }

  if (single && SNAKE_CASE.test(s)) {
    if (ENUM_MEMBERS.has(s)) {
      return { verdict: "RAW_ENUM", reason: `DECLARED_PRISMA_ENUM_MEMBER_OF_${ENUM_MEMBERS.get(s).join("+")}` };
    }
    return { verdict: "SNAKE_CASE", reason: "LOWERCASE_UNDERSCORE_IDENTIFIER_SHAPE" };
  }

  if (single && ALL_CAPS_WORD.test(s)) {
    if (ENUM_MEMBERS.has(s)) {
      return { verdict: "RAW_ENUM", reason: `DECLARED_PRISMA_ENUM_MEMBER_OF_${ENUM_MEMBERS.get(s).join("+")}` };
    }
    if (vocab.localEnumMembers.has(s)) {
      return { verdict: "RAW_ENUM", reason: "MEMBER_OF_A_LITERAL_UNION_DECLARED_IN_THE_SAME_FILE" };
    }
    if (!KNOWN_ACRONYMS.has(s) && !vocab.expandedAcronyms.has(s)) {
      return { verdict: "UNEXPLAINED_ACRONYM", reason: "ALL_CAPS_TOKEN_STANDING_ALONE_WITH_NO_EXPANSION_IN_THIS_FILE" };
    }
  }

  const lower = s.toLowerCase();
  const devHit = DEVELOPER_WORDS.find((w) => {
    const exception = DEVELOPER_WORD_EXCEPTIONS[w];
    if (exception && exception.test(s)) return false;
    return new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(lower);
  });
  if (devHit) return { verdict: "DEVELOPER_LANGUAGE", reason: `CONTAINS_IMPLEMENTATION_VOCABULARY_${devHit.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}` };

  // An acronym inside a sentence, with no expansion anywhere in that sentence.
  const caps = [...s.matchAll(/\b([A-Z]{2,5})\b/g)]
    .map((m) => m[1])
    .filter((a) => !KNOWN_ACRONYMS.has(a) && !vocab.expandedAcronyms.has(a));
  if (caps.length > 0 && !/\(/.test(s) && s.split(/\s+/).length <= 6) {
    return { verdict: "UNEXPLAINED_ACRONYM", reason: `ACRONYM_${caps[0]}_IN_A_SHORT_LABEL_WITH_NO_EXPANSION` };
  }

  if (AMBIGUOUS.has(lower)) return { verdict: "AMBIGUOUS_LABEL", reason: "LABEL_NAMES_NO_PARTICULAR_THING" };

  return { verdict: "HUMAN_READABLE", reason: "READS_AS_PRODUCT_LANGUAGE" };
}

/* ------------------------------------------------------------------ *
 * Extraction
 * ------------------------------------------------------------------ */

const excluded = {
  DATA_ATTRIBUTE: 0,
  CSS_CLASS_OR_STYLE: 0,
  TEST_ID: 0,
  NON_TEXT_PROP: 0,
  INSIDE_CODE_OR_PRE: 0,
  NO_LETTERS: 0,
  URL_OR_PATH: 0,
  NOT_A_TEXT_SLOT: 0,
};

/** Is this node inside a <code>/<pre>/<kbd> — including <code data-identifier>? */
function insideCodeElement(node) {
  let p = node.parent;
  while (p) {
    if (ts.isJsxElement(p)) {
      const tag = p.openingElement.tagName.getText(p.getSourceFile());
      if (CODE_TAGS.has(tag)) return true;
    }
    p = p.parent;
  }
  return false;
}

function enclosingTag(node) {
  let p = node.parent;
  while (p) {
    if (ts.isJsxElement(p)) return p.openingElement.tagName.getText(p.getSourceFile());
    if (ts.isJsxSelfClosingElement(p)) return p.tagName.getText(p.getSourceFile());
    p = p.parent;
  }
  return "FRAGMENT_OR_MODULE_SCOPE";
}

/** Every string literal that reaches the rendered text of an expression. */
function renderedLiterals(expr, sf, out = []) {
  let e = expr;
  while (e && ts.isParenthesizedExpression(e)) e = e.expression;
  if (!e) return out;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) out.push({ node: e, text: e.text });
  else if (ts.isConditionalExpression(e)) {
    renderedLiterals(e.whenTrue, sf, out);
    renderedLiterals(e.whenFalse, sf, out);
  } else if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) renderedLiterals(e.right, sf, out);
    else if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.PlusToken
    ) {
      renderedLiterals(e.left, sf, out);
      renderedLiterals(e.right, sf, out);
    }
  }
  // A call ends the search: `statusLabel(x.status)` IS the label (PV-LANG-003).
  return out;
}

const MAX_LABEL = 400;

function usable(text) {
  const s = text.trim();
  if (!s) return null;
  if (!/[A-Za-z]/.test(s)) {
    excluded.NO_LETTERS++;
    return null;
  }
  if (/^https?:\/\//.test(s) || s.includes("://") || /^[./]/.test(s)) {
    excluded.URL_OR_PATH++;
    return null;
  }
  // A tailwind/app-* class list: several kebab or prefixed tokens, no sentence.
  const tokens = s.split(/\s+/);
  if (
    tokens.length >= 2 &&
    tokens.every((t) => /^[a-z0-9]+(?:[-:/[\]().%]+[a-z0-9-]*)+$/.test(t))
  ) {
    excluded.CSS_CLASS_OR_STYLE++;
    return null;
  }
  return s.length > MAX_LABEL ? s.slice(0, MAX_LABEL) : s;
}

function extract(rec, surface) {
  const sf = rec.sf;
  const rows = [];
  const audience = audienceOf(surface.area);
  const vocab = fileVocabulary(rec.text);

  const add = (node, text, renderedContext) => {
    const s = usable(decodeEntities(text));
    if (s === null) return;
    const { verdict, reason } = classify(s, vocab);
    rows.push({
      surfaceId: surface.surfaceId,
      surfaceRoute: surface.route,
      surfaceArea: surface.area,
      audience,
      file: rec.path,
      line: lineOf(node, sf),
      string: s,
      renderedContext,
      verdict,
      reason,
    });
  };

  walk(sf, (node) => {
    // 1. JSX text — the element's own words.
    if (ts.isJsxText(node)) {
      if (insideCodeElement(node)) {
        if (node.getText(sf).trim()) excluded.INSIDE_CODE_OR_PRE++;
        return;
      }
      const text = node.getText(sf).replace(/\s+/g, " ").trim();
      if (text) add(node, text, `JSX_TEXT_IN_<${enclosingTag(node)}>`);
      return;
    }

    // 2. A string literal reaching the rendered text of a JSX expression child.
    if (ts.isJsxExpression(node) && node.expression && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      if (insideCodeElement(node)) {
        excluded.INSIDE_CODE_OR_PRE++;
        return;
      }
      const tag = enclosingTag(node);
      for (const lit of renderedLiterals(node.expression, sf)) {
        add(lit.node, lit.text, `JSX_EXPRESSION_STRING_IN_<${tag}>`);
      }
      return;
    }

    // 3. A text-rendering prop.
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      const owner = node.parent.parent;
      const tag = ts.isJsxSelfClosingElement(owner) || ts.isJsxOpeningElement(owner) ? owner.tagName.getText(sf) : "UNKNOWN";
      if (name.startsWith("data-")) {
        excluded.DATA_ATTRIBUTE++;
        return;
      }
      if (name === "className" || name === "class" || name === "style") {
        excluded.CSS_CLASS_OR_STYLE++;
        return;
      }
      if (name === "testId" || name === "dataTestId") {
        excluded.TEST_ID++;
        return;
      }
      if (isExcludedAttrName(name)) {
        excluded.NON_TEXT_PROP++;
        return;
      }
      if (!TEXT_ATTRS.has(name)) {
        excluded.NOT_A_TEXT_SLOT++;
        return;
      }
      const init = node.initializer;
      if (!init) return;
      if (ts.isStringLiteral(init)) {
        add(init, init.text, `ATTR_${name}_ON_<${tag}>`);
      } else if (ts.isJsxExpression(init) && init.expression) {
        for (const lit of renderedLiterals(init.expression, sf)) {
          add(lit.node, lit.text, `ATTR_${name}_ON_<${tag}>`);
        }
      }
      return;
    }

    // 4. A text key of an object literal — column headers, tile titles, copy.
    if (ts.isPropertyAssignment(node)) {
      const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
      if (!key || !TEXT_OBJECT_KEYS.has(key)) return;
      for (const lit of renderedLiterals(node.initializer, sf)) {
        add(lit.node, lit.text, `OBJECT_PROPERTY_${key}`);
      }
    }
  });

  return rows;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

const RAW_VERDICTS = new Set([
  "RAW_ENUM",
  "SCREAMING_SNAKE",
  "SNAKE_CASE",
  "RAW_PERMISSION_ID",
  "RAW_EVENT_NAME",
  "RAW_ERROR_CODE",
  "RAW_UUID_AS_IDENTITY",
]);

function main() {
  const surfaces = inScopeSurfaces(DATA);
  const rows = [];
  const filesSkipped = new Set();

  for (const s of surfaces) {
    const parsed = collectSurfaceFiles(s.ownedFiles);
    for (const relPath of [...parsed.keys()].sort()) {
      if (!relPath.endsWith(".tsx") && !relPath.endsWith(".jsx")) continue;
      const rec = loadModule(abs(relPath));
      if (!rec) {
        filesSkipped.add(`${relPath} :: UNREADABLE`);
        continue;
      }
      rows.push(...extract(rec, s));
    }
  }

  rows.sort((a, b) => {
    const ka = `${a.surfaceId}|${a.file}|${String(a.line).padStart(6, "0")}|${a.renderedContext}|${a.string}`;
    const kb = `${b.surfaceId}|${b.file}|${String(b.line).padStart(6, "0")}|${b.renderedContext}|${b.string}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const raw = rows.filter((r) => RAW_VERDICTS.has(r.verdict));
  const distinctStrings = new Set(rows.map((r) => r.string));

  const doc = {
    artifact: "ui-truth/labels",
    schemaVersion: 1,
    note:
      "Every user-visible string rendered by the 168 in-scope surfaces, with a verdict on whether it reads as product language. Data attributes, CSS classes, test ids and <code>/<pre> content are excluded and counted in totals.excluded. Rulebook reused from apps/web/scripts/raw-operator-language.mjs.",
    inputs: {
      surfaces: "audit/ui-truth/data/surfaces.json",
      placement: "audit/ui-truth/data/placement.json",
      rulebook: "apps/web/scripts/raw-operator-language.mjs",
      enumUniverse: "services/api/prisma/schema.prisma",
    },
    limits: {
      jsxImportDepth: 2,
      followedOnly: "apps/web/**",
      maxLabelChars: MAX_LABEL,
      callsAreLabels: "A string produced by a call — statusLabel(x.status) — is not inspected; a call is a label.",
      dynamicText: "A rendered expression with no string literal in it (a field read, a formatter) is not a string and is not a row here; the raw-field question is the product scanner's, and the data-element inventory carries the field itself.",
    },
    totals: {
      surfaces: surfaces.length,
      strings: rows.length,
      distinctStrings: distinctStrings.size,
      rawValueStrings: raw.length,
      byVerdict: tally(rows, (r) => r.verdict),
      byAudience: tally(rows, (r) => r.audience),
      byArea: tally(rows, (r) => r.surfaceArea),
      excluded: Object.fromEntries(Object.entries(excluded).sort()),
    },
    filesSkipped: [...filesSkipped].sort(),
    labels: rows,
  };

  writeFileSync(join(DATA, "labels.json"), JSON.stringify(doc, null, 2) + "\n");

  const byFile = {};
  for (const r of raw) byFile[r.file] = (byFile[r.file] ?? 0) + 1;
  const bySurfaceRaw = {};
  for (const r of raw) bySurfaceRaw[r.surfaceRoute] = (bySurfaceRaw[r.surfaceRoute] ?? 0) + 1;
  const byStringRaw = {};
  for (const r of raw) byStringRaw[r.string] = (byStringRaw[r.string] ?? 0) + 1;

  const rank = (obj, n) =>
    Object.entries(obj)
      .sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))
      .slice(0, n)
      .map(([k, count]) => ({ key: k, count }));

  const summary = {
    artifact: "ui-truth/labels-summary",
    schemaVersion: 1,
    note: "Totals for audit/ui-truth/data/labels.json.",
    totals: doc.totals,
    rawValueVerdicts: [...RAW_VERDICTS].sort(),
    byVerdictAndAudience: Object.fromEntries(
      [...new Set(rows.map((r) => r.verdict))].sort().map((v) => [v, tally(rows.filter((r) => r.verdict === v), (r) => r.audience)]),
    ),
    topOffendingFiles: rank(byFile, 25).map((x) => ({ file: x.key, rawStrings: x.count })),
    topOffendingSurfaces: rank(bySurfaceRaw, 25).map((x) => ({ surfaceRoute: x.key, rawStrings: x.count })),
    topRawStrings: rank(byStringRaw, 40).map((x) => ({ string: x.key, occurrences: x.count })),
  };
  writeFileSync(join(DATA, "labels-summary.json"), JSON.stringify(summary, null, 2) + "\n");

  console.log(`labels: ${rows.length} strings (${distinctStrings.size} distinct), ${raw.length} raw-value`);
  console.log(JSON.stringify(doc.totals.byVerdict, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
