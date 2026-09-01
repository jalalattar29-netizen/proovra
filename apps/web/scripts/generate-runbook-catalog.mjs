#!/usr/bin/env node
/**
 * GENERATE THE RUNBOOK CATALOG MODULE FROM `docs/runbooks/`.
 *
 * =============================================================================
 * WHY GENERATE, RATHER THAN READ AT RUNTIME
 * =============================================================================
 * The runbook markdown is the operator's authority and it lives in the
 * repository, where it is reviewed like code. The admin console needs the same
 * text, and there are three ways to get it there:
 *
 *   1. read `docs/runbooks/*.md` at request time — a filesystem dependency in a
 *      `standalone` Next build, reaching OUTSIDE `apps/web`. Nothing else in
 *      this app does that (the legal corpus reads `apps/web/content/legal`,
 *      which is inside the app), and it fails in exactly the environment that
 *      matters and nowhere a developer would notice;
 *   2. copy the markdown into `apps/web` — two copies of an operator procedure
 *      that will disagree, and the copy the operator reads will be the stale
 *      one;
 *   3. generate a committed module and gate it on freshness.
 *
 * This is (3). `docs/runbooks/` stays the single authority, the console gets
 * the real text with no runtime or build-time filesystem read, and
 * `apps/web/__tests__/runbook-catalog-freshness.test.ts` fails the moment the
 * two diverge. It is the same shape as the audit artifacts: generate, commit,
 * gate.
 *
 * =============================================================================
 * WHAT IT REFUSES TO DO
 * =============================================================================
 * Every runbook must have a curation entry — a category and the subsystems it
 * covers — and every curation entry must have a runbook. A missing curation
 * entry would silently drop the runbook out of the console, and a curation
 * entry for a deleted file would render a menu item that leads nowhere. Both
 * fail the build of this file rather than producing a quietly incomplete
 * catalog.
 *
 * Usage:
 *   node apps/web/scripts/generate-runbook-catalog.mjs           # write
 *   node apps/web/scripts/generate-runbook-catalog.mjs --check   # verify only
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(WEB_ROOT, "..", "..");
const RUNBOOK_DIR = join(REPO_ROOT, "docs", "runbooks");
const OUT_FILE = join(WEB_ROOT, "lib", "runbooks", "catalog.generated.ts");
/**
 * A second, tiny module holding ONLY the slugs.
 *
 * `catalog.generated.ts` carries every runbook body — about 125 KB of markdown.
 * That is fine for the two runbook pages, which are the only place the text is
 * read. It is not fine for `CommandCenter`, which needs to answer one question
 * — "is this slug a real runbook?" — before deciding whether to render a link,
 * and which would otherwise pull the whole corpus into the client bundle to
 * ask it.
 */
const SLUG_FILE = join(WEB_ROOT, "lib", "runbooks", "slugs.generated.ts");

/**
 * Not derived from the markdown, because neither fact is in it.
 *
 * `category` groups the catalog and `subsystems` is what an operator searches
 * by when a readiness banner hands them a subsystem id rather than a slug.
 * Both are editorial and belong under review, so they are declared here rather
 * than parsed out of a heading that was never written to carry them.
 */
const CURATION = {
  "export-blocked": { category: "Governance & lifecycle", subsystems: ["governance", "export"] },
  "hold-override": { category: "Governance & lifecycle", subsystems: ["governance", "legal_hold"] },
  "retention-precedence": { category: "Governance & lifecycle", subsystems: ["governance", "retention"] },
  "lifecycle-bypass": { category: "Governance & lifecycle", subsystems: ["governance", "lifecycle"] },
  "privacy-leak": { category: "Governance & lifecycle", subsystems: ["privacy", "governance"] },
  "disaster-recovery": { category: "Governance & lifecycle", subsystems: ["backup", "recovery"] },

  "immutable-drift": { category: "Storage & integrity", subsystems: ["storage", "immutability"] },
  "audit-chain-drift": { category: "Storage & integrity", subsystems: ["audit", "integrity"] },
  "ots-degradation": { category: "Storage & integrity", subsystems: ["ots", "anchor"] },
  "tsa-timestamp-failure": { category: "Storage & integrity", subsystems: ["tsa", "evidence_integrity"] },
  "storage-write-failure": { category: "Storage & integrity", subsystems: ["storage", "s3"] },

  "reviewer-sla-breach": { category: "Reviewer Ops", subsystems: ["reviewer", "sla"] },
  "reviewer-escalation-backlog": { category: "Reviewer Ops", subsystems: ["reviewer", "escalation"] },
  "reviewer-escalation-storm": { category: "Reviewer Ops", subsystems: ["reviewer", "escalation"] },
  "reviewer-inactivity": { category: "Reviewer Ops", subsystems: ["reviewer"] },
  "reviewer-queue-stuck": { category: "Reviewer Ops", subsystems: ["reviewer", "queue"] },

  "worker-wedged": { category: "Workers & queues", subsystems: ["worker", "queue"] },
  "workflow-stuck": { category: "Workers & queues", subsystems: ["workflow", "queue"] },
  "stuck-upload": { category: "Workers & queues", subsystems: ["upload"] },
  "observability-degraded": { category: "Workers & queues", subsystems: ["observability", "metrics"] },
  "database-readiness-failure": { category: "Workers & queues", subsystems: ["database", "readiness"] },
  "failed-report-generation": { category: "Workers & queues", subsystems: ["reports", "queue"] },
  "failed-verification-package": { category: "Workers & queues", subsystems: ["packages", "anchor"] },

  "suspicious-login-burst": { category: "Identity & security", subsystems: ["identity", "security"] },
  "security-review": { category: "Identity & security", subsystems: ["security"] },
  "pentest-readiness": { category: "Identity & security", subsystems: ["security"] },

  "twilio-outage": { category: "Integrations & notifications", subsystems: ["twilio", "notifications"] },
  "webhook-invalid-signature-burst": { category: "Integrations & notifications", subsystems: ["webhooks"] },
  "workflow-intake-abuse": { category: "Integrations & notifications", subsystems: ["workflow", "intake"] },

  "production-diagnostic-handoff": { category: "Operator procedures", subsystems: ["diagnostics", "database"] },
  "sre-runbooks": { category: "Operator procedures", subsystems: ["sre"] },
};

export const CATEGORY_ORDER = [
  "Governance & lifecycle",
  "Storage & integrity",
  "Reviewer Ops",
  "Workers & queues",
  "Identity & security",
  "Integrations & notifications",
  "Operator procedures",
];

/** The title is the first `# ` heading, or the slug if the file has none. */
function titleOf(body, slug) {
  const m = /^#\s+(.+)$/m.exec(body);
  return m ? m[1].replace(/^Runbook\s+—\s+/, "").trim() : slug;
}

/**
 * The first prose paragraph after the title, trimmed to one line.
 *
 * Not the whole first section: a summary that runs to a paragraph is a summary
 * nobody reads in a list of thirty.
 */
function summaryOf(body) {
  const lines = body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^#\s/.test(lines[i])) i += 1;
  i += 1;
  for (; i < lines.length; i += 1) {
    const l = lines[i].trim();
    if (l === "" || l.startsWith("#") || l.startsWith("|")) continue;
    // The metadata line under the title is not a summary.
    if (/^\*\*Incident slug\*\*/.test(l)) continue;
    const clean = l
      // A list marker or a blockquote caret is markdown punctuation, not part
      // of the sentence. Stripping beats skipping: several runbooks open with
      // a bullet and would otherwise have no summary at all.
      .replace(/^[-*>]\s+/, "")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/`(.+?)`/g, "$1")
      .replace(/\[(.+?)\]\(.+?\)/g, "$1")
      .trim();
    if (clean.length > 0) {
      return clean.length > 220 ? `${clean.slice(0, 217)}…` : clean;
    }
  }
  return "";
}

export function buildCatalog() {
  const files = readdirSync(RUNBOOK_DIR)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort();

  const slugs = files.map((f) => f.replace(/\.md$/, ""));

  // Neither direction may drift silently.
  const missingCuration = slugs.filter((s) => !CURATION[s]);
  const orphanCuration = Object.keys(CURATION).filter(
    (s) => !slugs.includes(s),
  );
  if (missingCuration.length > 0 || orphanCuration.length > 0) {
    const parts = [];
    if (missingCuration.length > 0) {
      parts.push(
        `runbooks with no curation entry (they would vanish from the console): ${missingCuration.join(", ")}`,
      );
    }
    if (orphanCuration.length > 0) {
      parts.push(
        `curation entries with no runbook (they would render a dead menu item): ${orphanCuration.join(", ")}`,
      );
    }
    throw new Error(
      `runbook catalog is inconsistent — ${parts.join("; ")}. ` +
        `Edit CURATION in ${OUT_FILE.replace(WEB_ROOT, "apps/web")}'s generator.`,
    );
  }

  const entries = slugs.map((slug) => {
    // Read as bytes and normalise line endings, so a CRLF checkout does not
    // produce a different catalog than an LF one and fail the freshness gate
    // on every Windows machine.
    const body = readFileSync(join(RUNBOOK_DIR, `${slug}.md`), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    return {
      slug,
      title: titleOf(body, slug),
      category: CURATION[slug].category,
      subsystems: CURATION[slug].subsystems,
      summary: summaryOf(body),
      body,
      sha256: createHash("sha256").update(body, "utf8").digest("hex"),
    };
  });

  const unknownCategory = entries.filter(
    (e) => !CATEGORY_ORDER.includes(e.category),
  );
  if (unknownCategory.length > 0) {
    throw new Error(
      `these runbooks use a category missing from CATEGORY_ORDER, so they would render in no section: ${unknownCategory
        .map((e) => `${e.slug} (${e.category})`)
        .join(", ")}`,
    );
  }

  return entries;
}

export function renderSlugModule(entries) {
  const L = [];
  L.push("/**");
  L.push(" * GENERATED FILE — DO NOT EDIT.");
  L.push(" *");
  L.push(" * The runbook slugs, and nothing else.");
  L.push(" *");
  L.push(" * Import this — never `catalog.generated.ts` — anywhere that only needs to");
  L.push(" * know whether a slug resolves. The full catalog carries every runbook body.");
  L.push(" *");
  L.push(" * Source: docs/runbooks/*.md");
  L.push(" * Generator: apps/web/scripts/generate-runbook-catalog.mjs");
  L.push(" */");
  L.push("");
  L.push("export const RUNBOOK_SLUGS: ReadonlySet<string> = new Set([");
  for (const e of entries) L.push(`  ${JSON.stringify(e.slug)},`);
  L.push("]);");
  L.push("");
  L.push("/**");
  L.push(" * Whether a slug has a runbook to open.");
  L.push(" *");
  L.push(" * Most `runbookSlug` values emitted by incidents are labels rather than");
  L.push(" * document references — they name a condition, and no markdown exists for");
  L.push(" * them. A surface that links every slug unconditionally sends the operator to");
  L.push(" * a 404 mid-incident, so link only when this returns true and render the slug");
  L.push(" * as plain text otherwise.");
  L.push(" */");
  L.push("export function hasRunbook(slug: string | null | undefined): boolean {");
  L.push('  return typeof slug === "string" && RUNBOOK_SLUGS.has(slug);');
  L.push("}");
  L.push("");
  return L.join("\n");
}

export function renderModule(entries) {
  const lines = [];
  lines.push("/**");
  lines.push(" * GENERATED FILE — DO NOT EDIT.");
  lines.push(" *");
  lines.push(" * Source: docs/runbooks/*.md");
  lines.push(" * Generator: apps/web/scripts/generate-runbook-catalog.mjs");
  lines.push(" *");
  lines.push(" * Edit the markdown, then run:");
  lines.push(" *   node apps/web/scripts/generate-runbook-catalog.mjs");
  lines.push(" *");
  lines.push(
    " * `apps/web/__tests__/runbook-catalog-freshness.test.ts` fails if this file",
  );
  lines.push(" * and the markdown disagree, so the console can never show a stale");
  lines.push(" * procedure while the repository shows a corrected one.");
  lines.push(" */");
  lines.push("");
  lines.push("export type RunbookCategory =");
  for (const c of CATEGORY_ORDER) lines.push(`  | ${JSON.stringify(c)}`);
  lines.push("  ;");
  lines.push("");
  lines.push("export type RunbookEntry = {");
  lines.push("  slug: string;");
  lines.push("  title: string;");
  lines.push("  category: RunbookCategory;");
  lines.push("  subsystems: readonly string[];");
  lines.push("  summary: string;");
  lines.push("  /** The markdown body, verbatim, with LF line endings. */");
  lines.push("  body: string;");
  lines.push("  /** sha256 of `body`. The freshness gate compares this. */");
  lines.push("  sha256: string;");
  lines.push("};");
  lines.push("");
  lines.push("export const RUNBOOK_CATEGORY_ORDER: readonly RunbookCategory[] = [");
  for (const c of CATEGORY_ORDER) lines.push(`  ${JSON.stringify(c)},`);
  lines.push("];");
  lines.push("");
  lines.push("export const RUNBOOKS: readonly RunbookEntry[] = [");
  for (const e of entries) {
    lines.push("  {");
    lines.push(`    slug: ${JSON.stringify(e.slug)},`);
    lines.push(`    title: ${JSON.stringify(e.title)},`);
    lines.push(`    category: ${JSON.stringify(e.category)},`);
    lines.push(`    subsystems: ${JSON.stringify(e.subsystems)},`);
    lines.push(`    summary: ${JSON.stringify(e.summary)},`);
    lines.push(`    body: ${JSON.stringify(e.body)},`);
    lines.push(`    sha256: ${JSON.stringify(e.sha256)},`);
    lines.push("  },");
  }
  lines.push("];");
  lines.push("");
  lines.push("/** Slug lookup. Returns null rather than throwing on an unknown slug. */");
  lines.push("export function runbookBySlug(slug: string): RunbookEntry | null {");
  lines.push("  return RUNBOOKS.find((r) => r.slug === slug) ?? null;");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const entries = buildCatalog();
  const outputs = [
    [OUT_FILE, renderModule(entries)],
    [SLUG_FILE, renderSlugModule(entries)],
  ];

  if (process.argv.includes("--check")) {
    let stale = false;
    for (const [file, rendered] of outputs) {
      let current = "";
      try {
        current = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      } catch {
        console.error(`${file.replace(REPO_ROOT, ".")} has never been generated.`);
        stale = true;
        continue;
      }
      if (current !== rendered) {
        console.error(`${file.replace(REPO_ROOT, ".")} is STALE.`);
        stale = true;
      }
    }
    if (stale) {
      console.error("Run: node apps/web/scripts/generate-runbook-catalog.mjs");
      process.exit(1);
    }
    console.log(`runbook catalog is current — ${entries.length} runbooks.`);
  } else {
    for (const [file, rendered] of outputs) writeFileSync(file, rendered, "utf8");
    console.log(`wrote 2 modules — ${entries.length} runbooks`);
  }
}
