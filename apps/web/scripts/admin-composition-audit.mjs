#!/usr/bin/env node
/**
 * WHAT IS ACTUALLY INSIDE EACH ADMIN PAGE.
 *
 * =============================================================================
 * WHY THIS EXISTS SEPARATELY FROM THE INVENTORY
 * =============================================================================
 * `admin-inventory.mjs` answers "which shell, which scope, which endpoint". It
 * reports 47/47 on the shared shell, and that was mistaken for evidence that 47
 * pages had been redesigned. It is not: a page can render through `PageShell`
 * and still be a column of identical white rectangles each holding one number.
 *
 * This measures the INSIDE. Not to score pages — to find the specific shapes
 * that make an operations console hard to read, so the work goes where it is
 * needed instead of everywhere equally.
 *
 * =============================================================================
 * WHAT IT LOOKS FOR, AND WHY EACH ONE IS A DEFECT
 * =============================================================================
 *   LONE_VALUE_CARDS      A card whose whole content is one number and a label.
 *                         Six of them stacked is a table someone drew with
 *                         boxes, and it costs six times the vertical space.
 *
 *   NO_EMPTY_STATE        A list surface with no empty branch renders a header
 *                         and nothing, which reads as "loading" forever.
 *
 *   NO_ERROR_STATE        A fetch with no failure branch shows stale or absent
 *                         data with no indication either way.
 *
 *   NO_LOADING_STATE      The reader cannot tell "nothing yet" from "nothing".
 *
 *   UNCONFIRMED_DESTRUCTIVE
 *                         A delete/revoke/purge/force action wired straight to
 *                         a click handler.
 *
 *   RAW_INTERNALS         kmsKeyArn, storageKey, fingerprints, filesystem paths
 *                         rendered as text. Platform-operations visibility is
 *                         not authorization to display key material.
 *
 *   PAGE_1_OF_0           A pager that can render "Page 1 of 0".
 *
 *   DECORATIVE_RED        A hard-coded red on something that is not a proven
 *                         current failure.
 *
 * Every check reads CODE with comments stripped. A page that explains in a
 * docblock why it has no empty state would otherwise be reported as having
 * none, which is how a guard teaches people to stop writing docblocks.
 *
 * Usage:
 *   node apps/web/scripts/admin-composition-audit.mjs
 *   node apps/web/scripts/admin-composition-audit.mjs --json
 *   node apps/web/scripts/admin-composition-audit.mjs --route /admin/costs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_DIR = join(WEB_ROOT, "app", "(app)", "admin");

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "page.tsx") out.push(p);
  }
  return out;
}

function routeOf(file) {
  const rel = relative(join(WEB_ROOT, "app", "(app)"), dirname(file));
  return (
    "/" +
    rel
      .split(sep)
      .filter((s) => !(s.startsWith("(") && s.endsWith(")")))
      .map((s) => (s.startsWith("[") ? ":" + s.replace(/[[\].]/g, "") : s))
      .join("/")
  );
}

/**
 * The page's own source PLUS the local components it renders from.
 *
 * Several pages are thin orchestrators over a `_sections/` or `_tabs/`
 * directory, and judging those by the orchestrator alone reports every
 * composition signal as absent — which is the opposite of the truth.
 */
function sourceFor(file) {
  const parts = [readFileSync(file, "utf8")];
  const dir = dirname(file);
  for (const sub of ["_sections", "_tabs", "_components"]) {
    const d = join(dir, sub);
    try {
      if (!statSync(d).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const n of readdirSync(d)) {
      if (/\.tsx?$/.test(n)) parts.push(readFileSync(join(d, n), "utf8"));
    }
  }
  return parts.join("\n");
}

const strip = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");


/**
 * FINDINGS THAT WERE LOOKED AT AND ARE CORRECT AS THEY ARE.
 *
 * A detector reading source text cannot always tell a defect from a deliberate
 * choice, and the honest way to close that gap is to write the reason down
 * rather than to loosen the pattern until the number reaches zero. Loosening
 * would silence the same shape everywhere; this silences one shape on one page
 * and leaves a sentence saying why.
 *
 * Anything NOT in here is unreviewed. That is what makes the remaining count
 * worth reading.
 */
const REVIEWED = {
  "/admin/platform/analytics": {
    NO_EMPTY_STATE:
      "The only map is over allowedWindowOptions, a module constant of select " +
      "options. A <select> with no options is not a state this page can reach.",
  },
  "/admin/platform/media-graph": {
    NO_EMPTY_STATE:
      "Maps over MEDIA_INTELLIGENCE_TILES / GRAPH_TILES, module constants " +
      "passed as a prop named 'tiles'. The tile SET is fixed; each tile has " +
      "its own unknown/degraded rendering for missing snapshot values.",
  },
  "/admin/platform/runbooks/:slug": {
    NO_EMPTY_STATE:
      "RUNBOOKS.map is generateStaticParams, not a render. rb.subsystems is a " +
      "chip row; all 33 catalog entries have entries and an empty one would " +
      "correctly render no chips, not an unexplained blank.",
    FILESYSTEM_PATH_SHOWN:
      "The provenance footer — 'Source: docs/runbooks/<slug>.md · content " +
      "sha256 …' — is operationally necessary and deliberate: it is how an " +
      "operator confirms this page and a repository checkout are the same " +
      "text. It is a repo-relative document path, not a server path, and it " +
      "names the file this page exists to render.",
  },
  "/admin/contact-sales/:id": {
    NO_EMPTY_STATE:
      "The only map is over an inline literal of status values rendered as " +
      "buttons. It cannot be empty.",
  },
};

const FINDINGS = [
  {
    id: "NO_EMPTY_STATE",
    // A page that maps over rows must say something when there are none.
    test: (c) =>
      /\.map\(/.test(c) &&
      !/EmptyState|No .{0,30}(yet|found|records|results|sessions|alerts|incidents)|length === 0|length > 0 \?/i.test(
        c,
      ),
  },
  {
    id: "NO_LOADING_STATE",
    test: (c) =>
      /apiFetch|useEffect/.test(c) && !/loading|isLoading|Loading|skeleton/i.test(c),
  },
  {
    id: "NO_ERROR_STATE",
    test: (c) =>
      /apiFetch/.test(c) && !/catch|toSafeUserError|error|Error/.test(c),
  },
  {
    // A DELETE request, or a control whose visible LABEL is destructive, with
    // no confirmation anywhere in the file.
    //
    // A first version matched the words anywhere and reported eight pages.
    // Every one was a JavaScript built-in: `URLSearchParams.delete("page")`
    // and `URL.revokeObjectURL(url)`. A detector that cannot tell a standard
    // library call from a destructive product action produces a list nobody
    // reads twice.
    //
    // Precise now, and it finds nothing: all four DELETE calls in the console
    // already go through `confirm({ confirmLabel: … })`. That zero is the
    // point — it is a guard on a property that currently holds.
    id: "UNCONFIRMED_DESTRUCTIVE",
    test: (c) => {
      const destructive =
        /method:\s*["']DELETE["']/.test(c) ||
        />\s*(Delete|Revoke|Purge|Terminate|Destroy|Wipe)\b[^<]{0,30}</.test(c);
      if (!destructive) return false;
      return !/useConfirmAction|ConfirmActionModal|await confirm\(|requireStepUp|useStepUpAction/i.test(
        c,
      );
    },
  },
  {
    id: "RAW_INTERNALS",
    // The negative lookbehind excludes ATTRIBUTE position.
    // `arn={x.kmsKeyArn}` hands the value to a component that reduces it;
    // `{x.kmsKeyArn}` in element position prints it. Only the second is the
    // defect, and a detector that cannot tell them apart sends the next
    // reader to delete the plumbing that carries a value to its redaction.
    // Only a JSX INTERPOLATION renders it. A first version matched any brace
    // block and so flagged a TYPE DECLARATION carrying the same field name,
    // which displays nothing at all. A detector that cannot tell a type from a
    // render sends you to redact a type.
    test: (c) =>
      /(?<![=\w])\{\s*[a-zA-Z_$][\w$]*\??\.(kmsKeyArn|storageKey|storageBucket|fileSha256|signatureBase64|fingerprintCanonicalJson)\s*\}/.test(
        c,
      ),
  },
  {
    id: "FILESYSTEM_PATH_SHOWN",
    // `docs/runbooks/x.md` is not something a browser can open.
    test: (c) => /["'`][^"'`]*\b(docs\/|services\/api\/|apps\/web\/)[^"'`]*\.(md|ts|tsx)\b/.test(c),
  },
  {
    id: "PAGE_1_OF_0",
    // A pager that prints totalPages unguarded shows "Page 1 of 0" when empty.
    test: (c) =>
      /Page \{|of \{.*totalPages|totalPages\}/.test(c) &&
      !/totalPages === 0 \?|Math\.max\(1/.test(c),
  },
  {
    // RENAMED from DECORATIVE_RED, which was the wrong accusation.
    //
    // Every red in these pages was checked and every one marks a proven
    // current failure: an `outage` badge, `failed > 0`, `stalled > 0`. None is
    // decorative. What is true is that the values are hard-coded rather than
    // tokenised — a consistency issue, not a correctness one.
    //
    // It is reported and NOT mass-remapped. The nearest existing tokens
    // (`--error` #DC2626, `--success-ink` #167A5B, `--warning-ink` #B45309) do
    // not match these values, so substituting them would shift colours across
    // 47 pages, and the usual justification — dark mode — does not apply here:
    // the app has no dark mode at all.
    id: "HARDCODED_STATUS_HEX",
    test: (c) => /#(dc2626|ef4444|b91c1c|991b1b|f87171|065f46|78350f|92400e)/i.test(c),
  },
  {
    // THIS is the rule that matters: red must mean a proven, current,
    // actionable failure. Unknown and stale are the absence of a measurement,
    // and painting them as failures is how a console teaches its operators to
    // ignore red.
    //
    // Currently zero across all 47 pages. It stays as a guard.
    id: "RED_ON_NON_FAILURE",
    test: (c) =>
      /(unknown|stale|pending|not_measured|unavailable)[^\n]{0,80}#(dc2626|ef4444|b91c1c|991b1b)/i.test(
        c,
      ) ||
      /#(dc2626|ef4444|b91c1c|991b1b)[^\n]{0,60}(unknown|stale|pending)/i.test(c),
  },
];

const rows = walk(ADMIN_DIR)
  .map((file) => {
    const raw = sourceFor(file);
    const code = strip(raw);

    // A "lone value card" — a Card whose body is a label and one value.
    const loneValueCards = (
      code.match(/<Card[^>]*>\s*(?:<[^>]+>\s*)?\{?[a-zA-Z0-9_.?\s]{0,40}\}?\s*<\/Card>/g) ?? []
    ).length;

    const route = routeOf(file);
    const hit = FINDINGS.filter((f) => f.test(code)).map((f) => f.id);

    return {
      route,
      file: relative(WEB_ROOT, file).split(sep).join("/"),
      lines: raw.split("\n").length,
      composition: {
        cards: (code.match(/<Card\b/g) ?? []).length,
        tables: (code.match(/<table\b|<DataTable\b/g) ?? []).length,
        sections: (code.match(/<PageSection\b|className="apf-section"/g) ?? []).length,
        filters: (code.match(/<FilterBar\b/g) ?? []).length,
        tabs: (code.match(/role="tab"|<Tabs\b/g) ?? []).length,
        dialogs: (code.match(/<Dialog\b|role="dialog"|<Modal\b/g) ?? []).length,
        loneValueCards,
      },
      findings: hit.filter((id) => !(REVIEWED[route]?.[id])),
      reviewed: hit.filter((id) => Boolean(REVIEWED[route]?.[id])),
    };
  })
  .sort((a, b) => b.findings.length - a.findings.length || a.route.localeCompare(b.route));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ total: rows.length, rows }, null, 2));
} else {
  const only = process.argv.includes("--route")
    ? process.argv[process.argv.indexOf("--route") + 1]
    : null;
  const pad = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
  console.log(
    pad("ROUTE", 38) + pad("LINES", 7) + pad("CARD/TBL/SEC", 14) + "FINDINGS",
  );
  console.log("-".repeat(110));
  for (const r of rows) {
    if (only && r.route !== only) continue;
    const c = r.composition;
    console.log(
      pad(r.route, 38) +
        pad(r.lines, 7) +
        pad(`${c.cards}/${c.tables}/${c.sections}`, 14) +
        r.findings.join(", "),
    );
  }
  const counts = {};
  for (const r of rows) for (const f of r.findings) counts[f] = (counts[f] ?? 0) + 1;
  console.log(
    "\n" +
      `${rows.length} pages · ${rows.filter((r) => r.findings.length > 0).length} with findings\n` +
      Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `  ${String(v).padStart(3)}  ${k}`)
        .join("\n"),
  );
  const reviewedCount = rows.reduce((n, r) => n + r.reviewed.length, 0);
  if (reviewedCount > 0) {
    console.log(
      `
${reviewedCount} finding(s) suppressed as reviewed-and-correct ` +
        "(REVIEWED in this file carries the reason for each).",
    );
  }
}
