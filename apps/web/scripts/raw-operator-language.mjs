#!/usr/bin/env node
/**
 * PV-LANG-003 — RAW TECHNICAL VOCABULARY IN OPERATOR-FACING TEXT.
 *
 * The audit found 198 places where an operator read a stored identifier as
 * if it were product language: an enum member printed straight into a table
 * cell (`{r.status}` → "DEAD_LETTERED"), a permission key as a list item
 * (`{p.permission}` → "identity.org_policy.read"), a machine code as a chip
 * label ("INVALID_EMAIL"). This scanner is the standing rule behind that
 * finding. It parses every product .tsx with the TypeScript compiler — the
 * JSX text in these files carries apostrophes, so a regex scanner cannot tell
 * text from code — and reports:
 *
 *   ENUM_CHILD    `{x.status}` (any field in ENUM_FIELDS) rendered as a JSX
 *                 child, i.e. as the text an operator reads.
 *   ENUM_PROP     the same value passed to a prop that renders as text
 *                 (label, title, v, subtitle, description, aria-label).
 *   LITERAL_TEXT  an identifier-shaped literal (SCREAMING_SNAKE, snake_case,
 *                 dotted.key) as JSX text or as a text prop.
 *
 * WHAT IS NOT A FINDING
 *   - A value in `key=`, `data-*=`, `value=`, `className=` — never rendered.
 *   - A value wrapped in a call (`{statusLabel(x.status)}`) — that is a label.
 *   - `{ value: "PAST_DUE", label: "Past due" }` option shapes — the literal
 *     is the option's value, the label is what renders.
 *   - The identifier as DECLARED SECONDARY DETAIL: a `<code data-identifier>`
 *     element. An operator sometimes needs the stored key (to quote it to
 *     support, to match it in an export); the attribute says, at the site,
 *     that this is the identifier shown beneath a label, not instead of one.
 *
 * Usage: node scripts/raw-operator-language.mjs [--json]
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Product source the rule covers: every authenticated page and component. */
export const SCAN_ROOTS = ["app/(app)", "components"];

/** Fields whose values are stored identifiers, not sentences. */
export const ENUM_FIELDS = new Set([
  "status",
  "state",
  "kind",
  "eventType",
  "role",
  "provider",
  "tier",
  "scope",
  "category",
  "severity",
  "plan",
  "code",
  "permission",
  "triggerType",
  "actionType",
  "outcome",
  "reasonCode",
]);

/** Props whose value renders as text. */
export const TEXT_PROPS = new Set([
  "label",
  "title",
  "v",
  "subtitle",
  "description",
  "aria-label",
]);

// A dotted key needs segments of two or more characters, so prose
// abbreviations ("e.g", "a.k.a") are not read as keys.
const IDENTIFIER_LITERAL =
  /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[a-z][a-z0-9_]+(?:\.[a-z][a-z0-9_]+)+)$/;

function walkFiles(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "__tests__") continue;
      walkFiles(full, out);
    } else if (name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function tagName(el) {
  const opening = ts.isJsxElement(el) ? el.openingElement : el;
  return opening.tagName.getText();
}

function hasAttr(el, attrName) {
  const opening = ts.isJsxElement(el) ? el.openingElement : el;
  return opening.attributes.properties.some(
    (p) => ts.isJsxAttribute(p) && p.name.getText() === attrName,
  );
}

/** True when the node sits directly inside a `<code data-identifier>`. */
function isDeclaredIdentifier(node) {
  const parent = node.parent;
  if (!parent || !ts.isJsxElement(parent)) return false;
  return tagName(parent) === "code" && hasAttr(parent, "data-identifier");
}

/** The field name read by `a.b.c` / `a?.b.c`, or null for anything else. */
function readField(expr) {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isPropertyAccessExpression(e)) return e.name.getText();
  return null;
}

/**
 * Every value that reaches the rendered text of an expression, through the
 * shapes a JSX child actually takes: `cond ? a.status : b.kind`,
 * `x.code && …`, `x.state ?? "—"`, and `` `${r.category} · ${r.outcome}` ``.
 * A field read in a CONDITION is not rendered and is not returned; a call
 * (`statusLabel(x.status)`) ends the search, because a call is a label.
 */
function renderedReads(expr, out = []) {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isPropertyAccessExpression(e)) {
    out.push(e);
  } else if (ts.isConditionalExpression(e)) {
    renderedReads(e.whenTrue, out);
    renderedReads(e.whenFalse, out);
  } else if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) renderedReads(e.right, out);
    else if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      renderedReads(e.left, out);
      renderedReads(e.right, out);
    } else if (op === ts.SyntaxKind.PlusToken) {
      renderedReads(e.left, out);
      renderedReads(e.right, out);
    }
  } else if (ts.isTemplateExpression(e)) {
    for (const span of e.templateSpans) renderedReads(span.expression, out);
  }
  return out;
}

/**
 * An explicit, reasoned allowance on the finding's line or the line above:
 *
 *     {/* raw-identifier-ok: state.status here is an HTTP status number *\/}
 *
 * For a field that shares a name with an enum and is not one (an HTTP code
 * called `status`). The reason is part of the marker so the allowance reads
 * as an argument at the site; the guard test lists every allowance.
 */
export const ALLOW_MARKER = /raw-identifier-ok:\s*(\S.{10,})/;

export function scanSource(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = source.split("\n");
  const findings = [];
  const push = (rule, node, value) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const allowed = [lines[line], lines[line - 1]].some((l) => l && ALLOW_MARKER.test(l));
    if (allowed) return;
    const lineText = lines[line] ?? "";
    findings.push({ rule, line: line + 1, value, context: lineText.trim().slice(0, 160) });
  };

  const visit = (node) => {
    // ENUM_CHILD — `{x.status}` as element text.
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      node.parent &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      if (!isDeclaredIdentifier(node)) {
        for (const read of renderedReads(node.expression)) {
          if (ENUM_FIELDS.has(readField(read))) push("ENUM_CHILD", node, read.getText(sf));
        }
      }
    }
    // ENUM_PROP / LITERAL_TEXT (prop) — a text-rendering prop.
    if (ts.isJsxAttribute(node) && TEXT_PROPS.has(node.name.getText())) {
      const init = node.initializer;
      if (init && ts.isJsxExpression(init) && init.expression) {
        for (const read of renderedReads(init.expression)) {
          if (ENUM_FIELDS.has(readField(read))) push("ENUM_PROP", node, read.getText(sf));
        }
        if (ts.isStringLiteral(init.expression) && IDENTIFIER_LITERAL.test(init.expression.text)) {
          push("LITERAL_TEXT", node, init.expression.text);
        }
      } else if (init && ts.isStringLiteral(init) && IDENTIFIER_LITERAL.test(init.text)) {
        push("LITERAL_TEXT", node, init.text);
      }
    }
    // LITERAL_TEXT (text) — an identifier as the element's own words.
    if (ts.isJsxText(node)) {
      for (const word of node.getText(sf).split(/[\s,;:()]+/)) {
        const w = word.replace(/[.]+$/, "");
        if (w && IDENTIFIER_LITERAL.test(w) && !isDeclaredIdentifier(node)) {
          push("LITERAL_TEXT", node, w);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

export function scanWeb(root = WEB_ROOT) {
  const files = SCAN_ROOTS.flatMap((r) => walkFiles(join(root, r), []));
  const findings = [];
  for (const full of files) {
    const rel = relative(root, full).split(sep).join("/");
    for (const f of scanSource(rel, readFileSync(full, "utf8"))) findings.push({ file: rel, ...f });
  }
  return findings;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const findings = scanWeb();
  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify(findings, null, 2) + "\n");
  } else {
    for (const f of findings) console.log(`${f.rule} ${f.file}:${f.line} ${f.value} | ${f.context}`);
    console.log(`\n${findings.length} finding(s)`);
  }
}
