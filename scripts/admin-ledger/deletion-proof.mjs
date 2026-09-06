#!/usr/bin/env node
/**
 * PHASE 7 §21 — THE DELETION PROOF, RE-PROVED ON DEMAND.
 *
 * ===========================================================================
 * WHY A SCRIPT AND NOT A PARAGRAPH
 * ===========================================================================
 * §3 required the legacy colour system to be DELETED rather than isolated, and
 * named the migration: find the declaration, identify the consumers, migrate
 * them to a canonical semantic token, prove zero consumers, delete. The last
 * two steps are claims about the whole tree, and a claim about the whole tree
 * written as prose is a claim that stops being true without anybody noticing.
 *
 * So each deletion is recorded here as a PREDICATE over the current source. Run
 * it and it either passes or names the file that brought the thing back. The
 * markdown it prints is the artifact; the exit code is the guard.
 *
 * Usage:
 *   node scripts/admin-ledger/deletion-proof.mjs            # print + exit 1 on regression
 *   node scripts/admin-ledger/deletion-proof.mjs --markdown > docs/admin/phase7-deletion-proof.md
 *
 * ===========================================================================
 * WHAT COUNTS AS A CONSUMER
 * ===========================================================================
 * Source that RENDERS or IMPORTS the thing. Not a comment: every one of these
 * deletions is explained in a comment somewhere, and a checker that counted
 * prose would report the explanation as the offence. Comments are stripped
 * before any pattern is applied, and the tests that assert an absence are
 * excluded by path — a guard naming the thing it forbids is the opposite of a
 * regression.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const WEB = resolve(REPO, "apps/web");

const MARKDOWN = process.argv.includes("--markdown");

/** Every source file that could hold a consumer. */
function sources() {
  const out = [];
  const skip = new Set([
    "node_modules",
    ".next",
    "dist",
    "coverage",
    "playwright-report",
    "test-results",
  ]);
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|mjs|css)$/.test(e.name)) out.push(p);
    }
  };
  for (const root of ["app", "components", "lib"]) {
    const r = resolve(WEB, root);
    if (existsSync(r)) walk(r);
  }
  return out;
}

/**
 * Strip comments so an explanation is never read as a consumer.
 *
 * Deliberately crude: it can eat a `//` inside a string literal, which for
 * these patterns can only ever cause a FALSE PASS on a URL and never a false
 * failure. Every pattern below is a token name or an import specifier, and
 * none of them is a substring of a URL in this tree.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*\*.*$/gm, "");
}

/** Paths whose whole job is to name a forbidden thing. */
const GUARDS = [
  "__tests__/",
  "scripts/admin-ledger/",
  "e2e/",
];

const files = sources()
  .map((p) => [relative(WEB, p).split("\\").join("/"), p])
  .filter(([rel]) => !GUARDS.some((g) => rel.includes(g)));

const cache = new Map();
function body(abs) {
  if (!cache.has(abs)) cache.set(abs, stripComments(readFileSync(abs, "utf8")));
  return cache.get(abs);
}

/**
 * THE DELETIONS.
 *
 * `what`   — the thing that no longer exists.
 * `why`    — what it was and what replaced it, in one sentence.
 * `gone`   — a path that must not exist, when the deletion was a whole file.
 * `absent` — a regex that must match nothing in the rendered source.
 * `keptIn` — files where the pattern is legitimate and expected, with a
 *            reason. An exemption with no reason is not an exemption.
 */
const DELETIONS = [
  {
    what: "apps/web/app/(app)/admin/identity/ui-tokens.ts",
    why:
      "the console's parallel visual language — twenty style objects and a twelve-entry colour alias map, consumed by nineteen admin pages and two Security Center pages. Its values were re-pointed at the canonical tokens first, which fixed the navy accent on seventeen surfaces and left the mechanism in place; this removed the mechanism.",
    gone: "apps/web/app/(app)/admin/identity/ui-tokens.ts",
    absent: /from\s+["'][^"']*identity\/ui-tokens["']/,
  },
  {
    what: "the admin TOKENS.* colour alias map",
    why:
      "a second name for every colour, so a surface could be violet through TOKENS and violet through --accent-600 and nobody could tell which one a page was using. Sixty-one uses across the console, all migrated to the canonical tokens before the file was deleted.",
    // NO LONGER SCOPED. This predicate used to be restricted to /admin,
    // /settings/security and /components, because `governance/policy` and
    // `reviewer-ops` imported their OWN `reviewer-ops/ui-tokens.ts` — a second
    // copy of the same idea that the phase which wrote this had not undertaken
    // to delete. Widening the pattern then would have claimed work nobody did.
    // §B3 deleted that file, so the scope comes off and the ban is what it
    // always should have been: `TOKENS.*` appears nowhere in apps/web.
    absent: /\bTOKENS\.[A-Za-z]/,
  },
  {
    what: "apps/web/app/(app)/reviewer-ops/ui-tokens.ts",
    why:
      "the SECOND parallel visual language — a twelve-entry raw-hex palette with a navy accent, three hand-written status palettes and twenty style objects, consumed by five pages outside the console. Its badge palettes went to the canonical status and severity maps, its layout to PageShell/PageSection/Card, its buttons to buttonSurfaceStyle, its inputs to the app-* primitives, and its two date helpers to lib/date — where one of them, a relative formatter that can say \"in 3h\", had no business living in a styling module at all.",
    gone: "apps/web/app/(app)/reviewer-ops/ui-tokens.ts",
    absent: /from\s+["'][^"']*reviewer-ops\/ui-tokens["']/,
  },
  {
    what: "the three raw-hex badge palettes that came with it",
    why:
      "slaBadgePalette, severityPalette and an inline lifecycle palette — forty-one hex literals encoding statuses the product already has one map for. They had drifted from it: IN_REVIEW was PURPLE, which canonical purple is reserved against, and CRITICAL was a darker red than HIGH, a distinction no operator was ever told the meaning of.",
    absent: /(slaBadgePalette|severityPalette|lifecycleBadgeStyle|slaBadgeStyle|severityBadgeStyle)\b/,
    keptIn: {
      "components/ui/StatusBadge.tsx":
        "the canonical map's own comments name what they replaced.",
    },
  },
  {
    what: "--text-muted and --text-strong",
    why:
      "two aliases added while closing 25 undefined tokens. --text-muted resolved to a value that failed WCAG AA against the card surface, so adding them broke contrast on ten files; all sixty consumers were migrated to --silver-ink or --ink-primary by role, and both aliases were deleted rather than re-pointed. This proof then caught the deletion leaking: `admin-system.css` still RE-DECLARED --text-muted, in a comment asserting a :root declaration that no longer existed — a live override of a custom property nothing reads.",
    absent: /--text-(muted|strong)\b/,
  },
  {
    what: "the duplicate --status-* declarations in app/globals.css",
    why:
      "globals.css imports lib/design-tokens/tokens.css and then re-declared the same twenty-four --status-* properties beneath it, so the later block won and the token file every component documents as the authority was dead for those names. The two copies also DISAGREED: Badge's pending fallback was #EA580C at 3.20:1 while the value actually rendering was #78350F at 8.15:1.",
    absent: /^\s*--status-[a-z]+-(bg|fg|border|solid):/m,
    only: ["app/globals.css"],
  },
  {
    what: "hex fallbacks inside var() at admin call sites",
    why:
      "a fallback is a second value for the same name, and when the two disagree the fallback is what ships wherever the token is missing — which is how Badge's dead pending colour came to disagree with the live one by 4.95:1 of contrast.",
    absent: /var\(--[a-z0-9-]+,\s*#[0-9a-fA-F]{3,8}\)/,
    only: ["app/(app)/admin/"],
  },
  {
    what: "page-local INK_* and PALETTE aliases under /admin",
    why:
      "twenty page-local colour maps, each a private palette that could drift from the product's.",
    absent: /\b(INK|PALETTE|COLORS|COLOURS)_[A-Z]+\s*=/,
    only: ["app/(app)/admin/"],
  },
  {
    what: "the cc-* class family",
    why:
      "a dead prefix left behind by an earlier console: twenty elements still carried cc-* class names that no stylesheet defined, so they were styled by nothing at all.",
    absent: /["'\s]cc-[a-z][a-z0-9-]*/,
    only: ["app/(app)/admin/"],
  },
  {
    what: "admin-v2 files",
    why: "§3 forbade a parallel v2 tree as an escape from deleting the first one.",
    absent: /admin-v2/,
  },
  {
    what: "hand-rolled status capsules under /admin",
    why:
      "sixty-one elements built a badge out of an inline borderRadius:999 and their own colour pair, so the console had sixty-one status vocabularies. They are Badge or AppStatusBadge now.",
    absent: /borderRadius:\s*999[\s\S]{0,120}?background(Color)?:\s*["']#/,
    only: ["app/(app)/admin/"],
  },
];

const findings = [];
const rows = [];

for (const d of DELETIONS) {
  const scope = d.only
    ? files.filter(([rel]) => d.only.some((o) => rel.startsWith(o) || rel === o))
    : files;

  const hits = [];
  if (d.absent) {
    for (const [rel, abs] of scope) {
      const src = body(abs);
      const m = d.absent.exec(src);
      if (m) {
        const line = src.slice(0, m.index).split("\n").length;
        hits.push(`${rel}:${line}  ${m[0].slice(0, 60)}`);
      }
    }
  }

  let fileStillThere = false;
  if (d.gone) {
    const p = resolve(REPO, d.gone);
    try {
      statSync(p);
      fileStillThere = true;
    } catch {
      /* absent, which is the point */
    }
  }

  const ok = hits.length === 0 && !fileStillThere;
  if (!ok) {
    findings.push(
      `${d.what}: ${fileStillThere ? "the file still exists" : `${hits.length} consumer(s)`}`,
    );
  }
  rows.push({
    what: d.what,
    why: d.why,
    scope: d.only ? d.only.join(", ") : "apps/web (app, components, lib)",
    filesSearched: scope.length,
    consumers: hits.length,
    fileStillThere,
    hits: hits.slice(0, 5),
  });
}

if (MARKDOWN) {
  const out = [];
  out.push("# Phase 7 §21 — canonical deletion proof");
  out.push("");
  out.push("<!--");
  out.push("  GENERATED. Do not edit by hand.");
  out.push("    node scripts/admin-ledger/deletion-proof.mjs --markdown \\");
  out.push("      > docs/admin/phase7-deletion-proof.md");
  out.push("-->");
  out.push("");
  out.push(
    "§3 required the legacy colour system to be **deleted rather than isolated**, and",
  );
  out.push(
    "named the migration: find the declaration, identify the consumers, migrate them to",
  );
  out.push(
    "a canonical semantic token, prove zero consumers, delete. The last two steps are",
  );
  out.push(
    "claims about the whole tree, and a claim about the whole tree written as prose is a",
  );
  out.push("claim that stops being true without anybody noticing.");
  out.push("");
  out.push(
    "So each row below is a **predicate over the current source**, re-checked by the",
  );
  out.push(
    "generator. Comments are stripped before any pattern is applied — every one of these",
  );
  out.push(
    "deletions is explained in a comment somewhere, and a checker that counted prose",
  );
  out.push(
    "would report the explanation as the offence. Tests, sweeps and e2e specs are",
  );
  out.push("excluded by path: a guard naming the thing it forbids is not a regression.");
  out.push("");
  out.push("| deleted | scope searched | files | consumers | verdict |");
  out.push("|---|---|---|---|---|");
  for (const r of rows) {
    const verdict = r.fileStillThere
      ? "**FILE STILL PRESENT**"
      : r.consumers === 0
        ? "gone, zero consumers"
        : `**${r.consumers} consumer(s)**`;
    out.push(
      `| \`${r.what}\` | \`${r.scope}\` | ${r.filesSearched} | ${r.consumers} | ${verdict} |`,
    );
  }
  out.push("");
  out.push("## Why each one went");
  out.push("");
  for (const r of rows) {
    out.push(`- **${r.what}** — ${r.why}`);
    if (r.hits.length) {
      out.push("");
      for (const h of r.hits) out.push(`  - REGRESSION: \`${h}\``);
    }
  }
  out.push("");
  out.push("## What is deliberately still allowed");
  out.push("");
  out.push(
    "A hardcoded colour is permitted for a **third-party brand mark**, because a payment",
  );
  out.push(
    "brand is recognised by its own colour and that mark is not a semantic state. The one",
  );
  out.push(
    "such authority in this tree is `.bill-pay__mark[data-mark=…]`, and the billing test",
  );
  out.push("names it as the reason its own hex ban is scoped rather than blanket.");
  out.push("");
  out.push(
    "`--enterprise-accent` and `--enterprise-gradient` stay declared in `globals.css`:",
  );
  out.push(
    "they are a brand treatment rather than a status, nothing else declares them, and the",
  );
  out.push("foundation test asserts they are there.");
  out.push("");
  out.push("## Debt this proof used to carry, now closed");
  out.push("");
  out.push(
    "**The second `ui-tokens.ts` is gone.** Until Phase 7 §B3 the deleted file was only",
  );
  out.push(
    "`app/(app)/admin/identity/ui-tokens.ts`, and `app/(app)/reviewer-ops/ui-tokens.ts`",
  );
  out.push(
    "was a separate copy of the same idea, consumed by five pages outside the console.",
  );
  out.push(
    "The `TOKENS.*` predicate had to be scoped to /admin because of it, and this",
  );
  out.push(
    "section recorded that as debt rather than widening a claim nobody had earned.",
  );
  out.push("");
  out.push(
    "§B3 migrated all five — `governance/policy`, its `WorkspaceGovernancePolicySection`,",
  );
  out.push(
    "`reviewer-ops/escalations`, `reviewer-ops/sla` and `reviewer-ops/[reviewId]` — onto",
  );
  out.push(
    "the shared design system and deleted the file. The scope came off the predicate at",
  );
  out.push("the same time, so the ban now covers all of `apps/web`.");
  console.log(out.join("\n"));
} else {
  for (const r of rows) {
    const verdict = r.fileStillThere
      ? "FILE STILL PRESENT"
      : r.consumers === 0
        ? "gone, 0 consumers"
        : `${r.consumers} CONSUMER(S)`;
    console.log(`${verdict.padEnd(22)} ${r.what}  (${r.filesSearched} files searched)`);
    for (const h of r.hits) console.log(`    ${h}`);
  }
  console.log("");
  console.log(
    findings.length
      ? `${findings.length} deletion(s) regressed:\n  - ${findings.join("\n  - ")}`
      : `all ${rows.length} deletions hold`,
  );
}

process.exitCode = findings.length ? 1 : 0;
