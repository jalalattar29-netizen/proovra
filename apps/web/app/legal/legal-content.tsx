import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ReactNode } from "react";

const LEGAL_LOCALE = "en";

export const ALLOWED_LEGAL_SLUGS = new Set([
  "privacy",
  "terms",
  "cookies",
  "security",
  "dpa",
  "law-enforcement",
  "aup",
  "dmca",
  "support",
  "transparency",
  "impressum",
  "evidence-handling",
  "verification-methodology",
  "subprocessors",
  "data-retention",
  "incident-response",
  "abuse-reporting",
  "toms",
  "legal-changelog",
  // Legal Center hardening — five new policy surfaces. Each is a
  // standalone legal document with explicit scope, boundary language,
  // and links to the Trust Center.
  "ai-use-policy",
  "verification-disclaimer",
  "privacy-requests",
  "refund-policy",
  "accessibility",
]);

export function titleFromSlug(slug: string) {
  if (!slug) return "Legal";

  const map: Record<string, string> = {
    privacy: "Privacy Policy",
    terms: "Terms of Service",
    cookies: "Cookie Policy",
    security: "Security & Responsible Disclosure",
    dpa: "Data Processing Agreement (DPA)",
    "law-enforcement": "Law Enforcement Request Policy",
    aup: "Acceptable Use Policy",
    dmca: "Copyright & DMCA Policy",
    support: "Support Policy",
    transparency: "Transparency Policy",
    impressum: "Impressum",
    "evidence-handling": "Evidence Handling Policy",
    "verification-methodology": "Evidence Verification Methodology",
    subprocessors: "Subprocessors",
    "data-retention": "Data Retention Policy",
    "incident-response": "Incident Response Policy",
    "abuse-reporting": "Abuse & Unlawful Content Reporting",
    toms: "Technical & Organizational Measures",
    "legal-changelog": "Legal Changelog",
    "ai-use-policy": "AI Use Policy",
    "verification-disclaimer": "Verification Disclaimer",
    "privacy-requests": "Privacy Requests",
    "refund-policy": "Consumer Cancellation and Refund Policy",
    accessibility: "Accessibility Statement",
  };

  return map[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1);
}

/**
 * THE one canonical authenticated-link mapper (routing-correction
 * 2026-07-19). Converts a public legal-document href to its
 * authenticated reader equivalent so links embedded in document
 * markdown never eject a signed-in user from the App Shell:
 *
 *   /legal/<slug>       → /settings/legal/<slug>   (valid slugs only)
 *   /privacy | /terms   → /settings/legal/{privacy,terms}
 *   /security-overview  → /settings/legal/security
 *
 * Everything else (external URLs, mailto:, /trust, /support, marketing
 * routes) passes through untouched. Used by the INTERNAL reader only —
 * the public /legal/[slug] pages keep the public hrefs.
 */
export function internalLegalDocumentHref(href: string): string {
  const m = href.match(/^\/legal\/([a-z0-9-]+)(?:[/?#].*)?$/);
  if (m && ALLOWED_LEGAL_SLUGS.has(m[1])) return `/settings/legal/${m[1]}`;
  if (href === "/privacy") return "/settings/legal/privacy";
  if (href === "/terms") return "/settings/legal/terms";
  if (href === "/security-overview") return "/settings/legal/security";
  return href;
}

export async function loadLegalMarkdown(slug: string) {
  const filePath = path.join(
    process.cwd(),
    "content",
    "legal",
    LEGAL_LOCALE,
    `${slug}.md`,
  );
  return readFile(filePath, "utf8");
}

/**
 * Minimal Markdown renderer for legal documents. Supports:
 *   - H1 / H2 / H3
 *   - paragraphs, line-break-separated
 *   - unordered lists (`- `) and ordered lists (`1. `)
 *   - inline **bold**, *italic*, [link](url)
 *   - `---` horizontal rule
 *   - GitHub-flavored Markdown tables
 *
 * Tables are emitted as real `<table>` elements wrapped in a
 * horizontally-scrollable enterprise container with #E2E8F0 borders,
 * #F8FAFC header background, navy header text, slate body text, and
 * comfortable cell padding. This is the renderer used by every
 * /legal/[slug] document — adding table support here fixes table
 * rendering globally.
 */
export function renderLegalMarkdown(
  md: string,
  opts?: {
    /**
     * Optional href mapper applied to every internal (non-external)
     * markdown link — the authenticated reader passes
     * `internalLegalDocumentHref` so document cross-references stay
     * inside the App Shell. Public pages omit it (hrefs verbatim).
     */
    mapHref?: (href: string) => string;
  },
) {
  const mapHref = opts?.mapHref;
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  let listItems: ReactNode[] = [];
  let orderedItems: ReactNode[] = [];

  const flushLists = () => {
    if (listItems.length > 0) {
      nodes.push(
        <ul key={`ul-${nodes.length}`} className="legal-list">
          {listItems.map((item, idx) => (
            <li key={idx}>{item}</li>
          ))}
        </ul>,
      );
      listItems = [];
    }

    if (orderedItems.length > 0) {
      nodes.push(
        <ol
          key={`ol-${nodes.length}`}
          className="legal-list legal-list-ordered"
        >
          {orderedItems.map((item, idx) => (
            <li key={idx}>{item}</li>
          ))}
        </ol>,
      );
      orderedItems = [];
    }
  };

  const renderInline = (text: string): ReactNode => {
    const out: ReactNode[] = [];
    const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
    const parts = text.split(pattern).filter(Boolean);

    parts.forEach((part, i) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        out.push(
          <strong key={`b-${i}`} style={{ color: "inherit" }}>
            {part.slice(2, -2)}
          </strong>,
        );
        return;
      }

      if (part.startsWith("*") && part.endsWith("*")) {
        out.push(
          <em key={`i-${i}`} style={{ color: "inherit" }}>
            {part.slice(1, -1)}
          </em>,
        );
        return;
      }

      if (part.startsWith("[") && part.includes("](") && part.endsWith(")")) {
        const match = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (match) {
          const label = match[1];
          const rawHref = match[2];
          const isExternal =
            /^https?:\/\//i.test(rawHref) || /^mailto:/i.test(rawHref);
          const href = !isExternal && mapHref ? mapHref(rawHref) : rawHref;

          out.push(
            <a
              key={`a-${i}`}
              href={href}
              target={isExternal ? "_blank" : undefined}
              rel={isExternal ? "noreferrer noopener" : undefined}
              className="legal-link"
            >
              {label}
            </a>,
          );
          return;
        }
      }

      out.push(<span key={`t-${i}`}>{part}</span>);
    });

    return out.length === 1 ? out[0] : <>{out}</>;
  };

  // ---------------------------------------------------------------------------
  // Table parsing — GitHub-flavoured pipe tables
  // ---------------------------------------------------------------------------

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
    if (cells.length === 0) return false;
    return cells.every((c) => /^:?-{3,}:?$/.test(c));
  };

  const tryParseTable = (
    start: number,
  ): { node: ReactNode; nextIndex: number } | null => {
    const headerLine = lines[start];
    const separatorLine = lines[start + 1];
    if (!headerLine || !separatorLine) return null;
    if (!headerLine.trim().startsWith("|")) return null;
    if (!isSeparatorRow(separatorLine)) return null;

    const headers = parseCells(headerLine);
    const sep = parseCells(separatorLine);
    if (sep.length !== headers.length) return null;

    // Per-column alignment from separator markers
    const alignments: ("left" | "center" | "right")[] = sep.map((c) => {
      const left = c.startsWith(":");
      const right = c.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      return "left";
    });

    const rows: string[][] = [];
    let i = start + 2;
    while (i < lines.length) {
      const l = lines[i];
      if (!l || !l.trim().startsWith("|")) break;
      const cells = parseCells(l);
      // Pad / truncate cells to header length so a stray row doesn't break parse
      while (cells.length < headers.length) cells.push("");
      if (cells.length > headers.length) cells.length = headers.length;
      rows.push(cells);
      i++;
    }

    const wrapperStyle: React.CSSProperties = {
      overflowX: "auto",
      WebkitOverflowScrolling: "touch",
      margin: "1.5rem 0",
      borderRadius: "12px",
      border: "1px solid #E2E8F0",
      boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
      background: "#FFFFFF",
    };

    const tableStyle: React.CSSProperties = {
      width: "100%",
      borderCollapse: "collapse",
      fontSize: "14px",
      lineHeight: 1.55,
    };

    const node = (
      <div
        key={`tw-${start}`}
        className="legal-table-wrapper"
        style={wrapperStyle}
      >
        <table className="legal-table" style={tableStyle}>
          <thead style={{ background: "#F8FAFC" }}>
            <tr>
              {headers.map((h, hi) => (
                <th
                  key={`th-${hi}`}
                  style={{
                    padding: "12px 16px",
                    textAlign: alignments[hi] ?? "left",
                    fontWeight: 600,
                    color: "#0F172A",
                    borderBottom: "1px solid #E2E8F0",
                    fontSize: "12.5px",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    whiteSpace: "nowrap",
                  }}
                >
                  {renderInline(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={`tr-${ri}`}>
                {row.map((cell, ci) => (
                  <td
                    key={`td-${ri}-${ci}`}
                    style={{
                      padding: "12px 16px",
                      textAlign: alignments[ci] ?? "left",
                      color: "#475569",
                      verticalAlign: "top",
                      borderTop: "1px solid #F1F5F9",
                    }}
                  >
                    {renderInline(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

    return { node, nextIndex: i };
  };

  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor];
    const trimmed = line.trim();

    if (!trimmed) {
      flushLists();
      cursor++;
      continue;
    }

    // Tables — must be checked before other block rules because table
    // rows start with `|` which doesn't match any other rule but would
    // otherwise fall through to the paragraph branch and render as
    // raw text with pipes.
    if (trimmed.startsWith("|")) {
      const table = tryParseTable(cursor);
      if (table) {
        flushLists();
        nodes.push(table.node);
        cursor = table.nextIndex;
        continue;
      }
    }

    if (trimmed === "---") {
      flushLists();
      nodes.push(<hr key={`hr-${nodes.length}`} className="legal-divider" />);
      cursor++;
      continue;
    }

    if (trimmed.startsWith("### ")) {
      flushLists();
      nodes.push(
        <h3 key={`h3-${nodes.length}`}>{renderInline(trimmed.slice(4))}</h3>,
      );
      cursor++;
      continue;
    }

    if (trimmed.startsWith("## ")) {
      flushLists();
      nodes.push(
        <h2 key={`h2-${nodes.length}`}>{renderInline(trimmed.slice(3))}</h2>,
      );
      cursor++;
      continue;
    }

    if (trimmed.startsWith("# ")) {
      flushLists();
      nodes.push(
        <h1 key={`h1-${nodes.length}`}>{renderInline(trimmed.slice(2))}</h1>,
      );
      cursor++;
      continue;
    }

    if (trimmed.startsWith("- ")) {
      listItems.push(renderInline(trimmed.slice(2)));
      cursor++;
      continue;
    }

    const orderedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (orderedMatch) {
      orderedItems.push(renderInline(orderedMatch[1]));
      cursor++;
      continue;
    }

    flushLists();
    nodes.push(<p key={`p-${nodes.length}`}>{renderInline(trimmed)}</p>);
    cursor++;
  }

  flushLists();
  return nodes;
}
