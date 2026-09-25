/**
 * LEGAL — pure projections for the native legal reader.
 *
 * Ports `apps/web/app/legal/[slug]` and `apps/web/app/(app)/settings/legal/[slug]`
 * over `GET /v1/legal` and `GET /v1/legal/:slug`, which serve the SAME corpus
 * the web renders (`apps/web/content/legal/en/*.md` via `@proovra/shared/legal`).
 *
 * Native does NOT ship a copy of the legal text. A bundled privacy policy or
 * DPA goes stale on the next web edit and cannot be corrected without an
 * app-store release, and a stale one is a compliance exposure rather than a
 * cosmetic bug. It also does not open proovra.com in a system browser, which is
 * what Settings did before: a user cannot read the terms they are being asked
 * to accept if the handoff fails, and the app has no way to state which version
 * it showed.
 *
 * WHAT THIS MODULE OWNS, AND WHAT IT DOES NOT
 * -------------------------------------------
 * It owns PRESENTATION — turning canonical markdown into blocks a phone can
 * render. The web's renderer emits React DOM elements and cannot be reused, so
 * the block vocabulary here mirrors the constructs the web renderer supports so
 * the two surfaces show the same document structure. It owns no content, no
 * slug list, no titles and no dates: all four come from the API.
 *
 * THE RENDERER MUST NEVER SWALLOW A LINE.
 * A markdown construct this parser does not understand falls through as text.
 * A vanished clause in a legal document is the failure nobody notices until it
 * matters.
 *
 * Pure: no React, no react-native, no fetch.
 */

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function buildLegalIndexPath(): string {
  return "/v1/legal";
}

export function buildLegalDocumentPath(slug: string): string {
  return `/v1/legal/${encodeURIComponent(slug)}`;
}

/** The acceptance gate's required version, for the policies it governs. */
export interface LegalAcceptanceRef {
  policyKey: string;
  requiredVersion: string;
}

export interface LegalDocumentSummary {
  slug: string;
  title: string;
  /** The document's own `Last Updated:` date, `YYYY-MM-DD`. */
  lastUpdated: string | null;
  acceptance: LegalAcceptanceRef | null;
}

export interface LegalDocument extends LegalDocumentSummary {
  locale: string;
  content: string;
}

function parseAcceptance(v: unknown): LegalAcceptanceRef | null {
  const a = obj(v);
  const policyKey = str(a.policyKey);
  const requiredVersion = str(a.requiredVersion);
  if (!policyKey || !requiredVersion) return null;
  return { policyKey, requiredVersion };
}

export function parseLegalIndex(payload: unknown): LegalDocumentSummary[] {
  return rows(obj(payload).documents)
    .map((raw) => {
      const d = obj(raw);
      const slug = str(d.slug);
      if (!slug) return null;
      return {
        slug,
        title: str(d.title) ?? slug,
        lastUpdated: str(d.lastUpdated),
        acceptance: parseAcceptance(d.acceptance),
      };
    })
    .filter((d): d is LegalDocumentSummary => d !== null);
}

export function parseLegalDocument(payload: unknown): LegalDocument | null {
  const d = obj(payload);
  const slug = str(d.slug);
  const content = str(d.content);
  // A document with no body is not a document. Rendering an empty legal page
  // would read as "this policy says nothing", which is worse than an error.
  if (!slug || !content) return null;
  return {
    slug,
    title: str(d.title) ?? slug,
    locale: str(d.locale) ?? "en",
    lastUpdated: str(d.lastUpdated),
    acceptance: parseAcceptance(d.acceptance),
    content,
  };
}

/**
 * The five public web routes that are nothing but `redirect("/legal/<slug>")`
 * (`apps/web/app/{privacy,terms,subprocessors,data-retention,abuse-reporting}/page.tsx`).
 * Native resolves them to the same reader rather than giving each a screen.
 */
export const LEGAL_SHORTCUT_ROUTES: Readonly<Record<string, string>> = {
  "/privacy": "privacy",
  "/terms": "terms",
  "/subprocessors": "subprocessors",
  "/data-retention": "data-retention",
  "/abuse-reporting": "abuse-reporting",
};

/** The slug a canonical web legal path points at, or null. */
export function legalSlugFromWebPath(path: string): string | null {
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  if (Object.prototype.hasOwnProperty.call(LEGAL_SHORTCUT_ROUTES, clean)) {
    return LEGAL_SHORTCUT_ROUTES[clean];
  }
  const m = clean.match(/^\/(?:settings\/)?legal\/([a-z0-9-]+)$/);
  if (m) return m[1];
  // `/security-overview` is the web's legacy alias for the security document;
  // `internalLegalDocumentHref` maps it the same way.
  if (clean === "/security-overview") return "security";
  return null;
}

// ---------------------------------------------------------------------------
// Markdown → blocks
// ---------------------------------------------------------------------------

export type LegalInline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "link"; text: string; href: string; external: boolean };

export type LegalBlock =
  | { kind: "h1" | "h2" | "h3"; spans: LegalInline[] }
  | { kind: "p"; spans: LegalInline[] }
  | { kind: "ul" | "ol"; items: LegalInline[][] }
  | { kind: "hr" }
  | { kind: "table"; headers: LegalInline[][]; rows: LegalInline[][][] };

const INLINE_RE = /(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;

export function parseLegalInline(text: string): LegalInline[] {
  const out: LegalInline[] = [];

  for (const part of text.split(INLINE_RE)) {
    if (!part) continue;

    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      out.push({ kind: "bold", text: part.slice(2, -2) });
      continue;
    }
    if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) {
      out.push({ kind: "italic", text: part.slice(1, -1) });
      continue;
    }

    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = link[2];
      out.push({
        kind: "link",
        text: link[1],
        href,
        external: /^(https?:\/\/|mailto:)/i.test(href),
      });
      continue;
    }

    out.push({ kind: "text", text: part });
  }

  return out.length > 0 ? out : [{ kind: "text", text }];
}

const parseCells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

const isSeparatorRow = (row: string): boolean => {
  if (!row || !row.includes("|")) return false;
  const cells = parseCells(row);
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
};

/**
 * Parse a legal document into renderable blocks.
 *
 * Supports the same constructs as `renderLegalMarkdown` in
 * `apps/web/app/legal/legal-content.tsx`: headings, paragraphs, unordered and
 * ordered lists, `---` rules, GitHub pipe tables, and inline bold/italic/link.
 * Anything else becomes a paragraph of its own literal text.
 */
export function parseLegalMarkdown(md: string): LegalBlock[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: LegalBlock[] = [];

  let bullets: LegalInline[][] = [];
  let numbers: LegalInline[][] = [];

  const flush = () => {
    if (bullets.length > 0) {
      blocks.push({ kind: "ul", items: bullets });
      bullets = [];
    }
    if (numbers.length > 0) {
      blocks.push({ kind: "ol", items: numbers });
      numbers = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (!trimmed) {
      flush();
      i++;
      continue;
    }

    if (trimmed.startsWith("|")) {
      const header = trimmed;
      const sep = lines[i + 1];
      if (sep !== undefined && isSeparatorRow(sep)) {
        flush();
        const headers = parseCells(header);
        const body: LegalInline[][][] = [];
        let j = i + 2;
        while (j < lines.length && lines[j].trim().startsWith("|")) {
          const cells = parseCells(lines[j]);
          while (cells.length < headers.length) cells.push("");
          cells.length = headers.length;
          body.push(cells.map(parseLegalInline));
          j++;
        }
        blocks.push({
          kind: "table",
          headers: headers.map(parseLegalInline),
          rows: body,
        });
        i = j;
        continue;
      }
      // Not a table after all — fall through so the pipes render as text
      // rather than disappearing.
    }

    if (trimmed === "---") {
      flush();
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      blocks.push({
        kind: level === 1 ? "h1" : level === 2 ? "h2" : "h3",
        spans: parseLegalInline(heading[2]),
      });
      i++;
      continue;
    }

    if (trimmed.startsWith("- ")) {
      if (numbers.length > 0) flush();
      bullets.push(parseLegalInline(trimmed.slice(2).trim()));
      i++;
      continue;
    }

    const ordered = trimmed.match(/^\d+\.\s+(.*)$/);
    if (ordered) {
      if (bullets.length > 0) flush();
      numbers.push(parseLegalInline(ordered[1]));
      i++;
      continue;
    }

    flush();
    blocks.push({ kind: "p", spans: parseLegalInline(trimmed) });
    i++;
  }

  flush();
  return blocks;
}

/**
 * The document's title line, if its first heading repeats the title the API
 * already gave us. The reader renders the title in the page header, so showing
 * the H1 again would print it twice.
 */
export function stripLeadingTitle(
  blocks: LegalBlock[],
  title: string,
): LegalBlock[] {
  const first = blocks[0];
  if (!first || first.kind !== "h1") return blocks;
  const text = first.spans.map((s) => s.text).join("").trim();
  return text.toLowerCase() === title.trim().toLowerCase()
    ? blocks.slice(1)
    : blocks;
}

/**
 * T-14 — "On this page" (web LegalDocumentShell): the document's H2 sections,
 * offered only when there are at least three, as on the web.
 */
export function legalToc(blocks: LegalBlock[]): Array<{ blockIndex: number; title: string }> {
  const items = blocks
    .map((b, blockIndex) => (b.kind === "h2" ? { blockIndex, title: b.spans.map((s) => s.text).join("").trim() } : null))
    .filter((x): x is { blockIndex: number; title: string } => x !== null && x.title.length > 0);
  return items.length >= 3 ? items : [];
}
