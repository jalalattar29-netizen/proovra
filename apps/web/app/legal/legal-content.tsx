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

/**
 * Root-relative body-link destinations that leave the authenticated App
 * Shell for the PUBLIC site when opened from the INTERNAL legal reader.
 *
 * The canonical one is the public Trust Center at `/trust`. The internal
 * in-app trust pages (`/trust-center/*`) are NOT public exits — they stay
 * in the App Shell and must keep same-tab navigation. Absolute http(s)
 * URLs are already treated as external by the renderer, so this predicate
 * only needs to catch the root-relative public Trust Center form.
 *
 * Used by the INTERNAL reader (via `renderLegalMarkdown`'s
 * `externalizePublicExits`) so a body-content `[Trust Center](/trust)`
 * link opens in a NEW tab instead of dropping the App Shell in the
 * current tab. Public pages never set the flag, so they are unaffected.
 */
export function isAuthenticatedPublicExit(href: string): boolean {
  // `/trust`, `/trust/`, `/trust?…`, `/trust#…` → true.
  // `/trust-center`, `/trust-center/security` → false (internal, in-app).
  return /^\/trust(?:[/?#]|$)/.test(href);
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


// ---------------------------------------------------------------------------
// Documentation presentation components (2026-07-20 enterprise rebuild).
//
// Used ONLY when the renderer runs with `enhance: true` (the
// authenticated reader). The markdown SOURCE never changes — these are
// presentation upgrades for structures the corpus already contains
// (provider/address + contact blocks, short enumerations). Public
// pages render without `enhance` and stay byte-identical.
// ---------------------------------------------------------------------------

function IconBuilding() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 17V4.5A1.5 1.5 0 0 1 5.5 3h5A1.5 1.5 0 0 1 12 4.5V17M12 8h2.5A1.5 1.5 0 0 1 16 9.5V17M2.5 17h15" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.5 6.5h3M6.5 9.5h3M6.5 12.5h3" strokeLinecap="round" />
    </svg>
  );
}

function IconMail() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2.5" y="4.5" width="15" height="11" rx="2" />
      <path d="m3.5 6 6.5 5 6.5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconShieldSmall() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M10 2.5 4 5v4.5c0 3.7 2.6 6.6 6 8 3.4-1.4 6-4.3 6-8V5l-6-2.5Z" strokeLinejoin="round" />
      <path d="m7.5 9.8 1.8 1.8 3.2-3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconChip() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3.5" y="3.5" width="13" height="13" rx="3" />
      <path d="m7.5 10 1.8 1.8 3.4-3.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type ContactItem = { email: string; description?: string };

/** Two-column enterprise provider/contact Information Panel. */
function ProviderPanel({
  addressLines,
  contacts,
}: {
  addressLines: ReadonlyArray<string>;
  contacts: ReadonlyArray<ContactItem>;
}) {
  return (
    <div
      data-legal-provider-panel
      className="my-7 rounded-[14px] border border-[#E2E8F0] bg-white/70 px-6 py-5"
    >
      <div className="grid gap-6 sm:grid-cols-[1fr_1px_1.2fr] sm:gap-8">
        <div className="flex items-start gap-3.5">
          <span
            aria-hidden="true"
            className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[#F1F5F9] text-[#64748B]"
          >
            <IconBuilding />
          </span>
          <div className="grid gap-0.5 text-[0.92rem] leading-[1.6] text-[#475569]">
            {addressLines.map((line, i) => (
              <div key={i} className={i === 0 ? "font-semibold text-[#0F172A]" : undefined}>
                {line}
              </div>
            ))}
          </div>
        </div>
        <div aria-hidden="true" className="hidden w-px bg-[#EEF2F7] sm:block" />
        <div className="grid content-center gap-2.5">
          {contacts.map((c) => (
            <a
              key={c.email}
              href={`mailto:${c.email}`}
              className="inline-flex items-baseline gap-2.5 text-[0.9rem] font-medium text-[#334155] no-underline hover:text-[#1E40AF]"
            >
              <span className="translate-y-0.5 text-[#64748B]">
                {/^security@/.test(c.email) ? <IconShieldSmall /> : <IconMail />}
              </span>
              <span>
                {c.email}
                {c.description ? (
                  <span className="font-normal text-[#94A3B8]"> — {c.description}</span>
                ) : null}
              </span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Contact rows without an address block. */
function ContactPanel({ contacts }: { contacts: ReadonlyArray<ContactItem> }) {
  return (
    <div
      data-legal-contact-panel
      className="my-6 grid gap-2.5 rounded-[14px] border border-[#E2E8F0] bg-white/70 px-6 py-4"
    >
      {contacts.map((c) => (
        <a
          key={c.email}
          href={`mailto:${c.email}`}
          className="inline-flex items-baseline gap-2.5 text-[0.9rem] font-medium text-[#334155] no-underline hover:text-[#1E40AF]"
        >
          <span className="translate-y-0.5 text-[#64748B]">
            {/^security@/.test(c.email) ? <IconShieldSmall /> : <IconMail />}
          </span>
          <span>
            {c.email}
            {c.description ? (
              <span className="font-normal text-[#94A3B8]"> — {c.description}</span>
            ) : null}
          </span>
        </a>
      ))}
    </div>
  );
}

/** Short enumerations render as scannable capability chips. */
function ChipRow({ items }: { items: ReadonlyArray<string> }) {
  return (
    <div data-legal-chip-row className="my-5 flex flex-wrap gap-2">
      {items.map((item) => (
        <span
          key={item}
          className="inline-flex items-center gap-2 rounded-[10px] border border-[#E2E8F0] bg-white/70 px-3 py-2 text-[0.82rem] font-medium text-[#334155]"
        >
          <span aria-hidden="true" className="text-[#64748B]">
            <IconChip />
          </span>
          {item}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

const EMAIL_ITEM_RE = /^([\w.+-]+@[\w.-]+\.[a-z]{2,})(?:\s+—\s+(.+))?$/i;

type TaggedKind =
  | "block" // generic (headings, hr, tables, ordered lists)
  | "p"
  | "p-short" // short-line paragraph (address-line candidate)
  | "p-contact" // "Contact:" label paragraph
  | "ul";

type Tagged = {
  kind: TaggedKind;
  node: ReactNode;
  rawText?: string;
  rawItems?: string[];
};

/**
 * Minimal Markdown renderer for legal documents. Supports:
 *   - H1 / H2 / H3
 *   - paragraphs, line-break-separated
 *   - unordered lists (`- `) and ordered lists (`1. `)
 *   - inline **bold**, *italic*, [link](url)
 *   - `---` horizontal rule
 *   - GitHub-flavored Markdown tables
 *
 * Tables are emitted as enterprise documentation tables (scrollable
 * container, #E2E8F0 borders, #F8FAFC header, comfortable padding).
 *
 * With `opts.enhance` (authenticated reader ONLY) the renderer also
 * recognizes structured legal content and presents it visually,
 * WITHOUT changing the markdown source:
 *   - address block + "Contact:" + email list → two-column Provider
 *     Information Panel;
 *   - standalone email lists → contact rows with icons;
 *   - short enumerations (3–8 items, each 8–36 chars, ≥2 words, no
 *     links/periods) → scannable chip rows.
 * Public pages never pass `enhance` and render exactly as before.
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
    /** Enable structured-content presentation (internal reader only). */
    enhance?: boolean;
    /**
     * Authenticated-reader context flag. When true, body-content links
     * whose (post-`mapHref`) destination is a PUBLIC exit that leaves the
     * App Shell — canonically the public Trust Center at `/trust`
     * (`isAuthenticatedPublicExit`) — render as new-tab anchors
     * (`target="_blank"` + `rel="noopener noreferrer"`) with an
     * external-link cue, so the authenticated app stays open in the
     * current tab. Public pages omit this flag and render verbatim.
     */
    externalizePublicExits?: boolean;
  },
) {
  const mapHref = opts?.mapHref;
  const enhance = opts?.enhance === true;
  const externalizePublicExits = opts?.externalizePublicExits === true;
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const tagged: Tagged[] = [];
  let listItems: ReactNode[] = [];
  let listRaw: string[] = [];
  let orderedItems: ReactNode[] = [];

  const flushLists = () => {
    if (listItems.length > 0) {
      tagged.push({
        kind: "ul",
        rawItems: listRaw,
        node: (
          <ul key={`ul-${tagged.length}`} className="legal-list">
            {listItems.map((item, idx) => (
              <li key={idx}>{item}</li>
            ))}
          </ul>
        ),
      });
      listItems = [];
      listRaw = [];
    }

    if (orderedItems.length > 0) {
      tagged.push({
        kind: "block",
        node: (
          <ol
            key={`ol-${tagged.length}`}
            className="legal-list legal-list-ordered"
          >
            {orderedItems.map((item, idx) => (
              <li key={idx}>{item}</li>
            ))}
          </ol>
        ),
      });
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

          // Authenticated reader: a body link that (after mapHref) still
          // points at a PUBLIC destination outside the App Shell —
          // canonically the public Trust Center at /trust — must open in
          // a new tab so the app stays open in the current tab. Internal
          // reader cross-references were already rewritten to
          // /settings/legal/* by mapHref and stay same-tab; /trust-center/*
          // is internal and stays same-tab too.
          const isPublicExit =
            externalizePublicExits &&
            !isExternal &&
            isAuthenticatedPublicExit(href);
          const openInNewTab = isExternal || isPublicExit;

          out.push(
            <a
              key={`a-${i}`}
              href={href}
              target={openInNewTab ? "_blank" : undefined}
              rel={openInNewTab ? "noreferrer noopener" : undefined}
              aria-label={
                isPublicExit ? `${label} (opens in a new tab)` : undefined
              }
              className="legal-link"
            >
              {label}
              {isPublicExit ? (
                <span aria-hidden="true">{" ↗"}</span>
              ) : null}
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

    // Container chrome (overflow scroll, border, radius, background,
    // breakout) lives in the canonical .legal-table-wrapper / .legal-table
    // CSS so markdown tables and aligned direct React tables render
    // identically. Only data-driven per-cell alignment stays inline.
    const tableStyle: React.CSSProperties = {
      width: "100%",
      borderCollapse: "collapse",
      fontSize: "14px",
      lineHeight: 1.55,
    };

    const node = (
      <div key={`tw-${start}`} className="legal-table-wrapper">
        <table className="legal-table" style={tableStyle}>
          <thead style={{ background: "#F8FAFC" }}>
            <tr>
              {headers.map((h, hi) => (
                <th
                  key={`th-${hi}`}
                  style={{
                    padding: "13px 18px",
                    textAlign: alignments[hi] ?? "left",
                    fontWeight: 600,
                    color: "#0F172A",
                    borderBottom: "1px solid #E2E8F0",
                    fontSize: "12px",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
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
                      padding: "13px 18px",
                      textAlign: alignments[ci] ?? "left",
                      color: "#475569",
                      verticalAlign: "top",
                      lineHeight: 1.6,
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

  // Address-line candidate: short, name/street-like, no sentence
  // punctuation, no markdown constructs.
  const isShortLine = (text: string): boolean =>
    text.length >= 3 &&
    text.length <= 48 &&
    !/[.:;,]$/.test(text) &&
    text.split(/\s+/).length <= 6 &&
    !/[[\]|*#>]/.test(text) &&
    !EMAIL_ITEM_RE.test(text);

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
        tagged.push({ kind: "block", node: table.node });
        cursor = table.nextIndex;
        continue;
      }
    }

    if (trimmed === "---") {
      flushLists();
      tagged.push({
        kind: "block",
        node: <hr key={`hr-${tagged.length}`} className="legal-divider" />,
      });
      cursor++;
      continue;
    }

    if (trimmed.startsWith("### ")) {
      flushLists();
      tagged.push({
        kind: "block",
        node: (
          <h3 key={`h3-${tagged.length}`}>{renderInline(trimmed.slice(4))}</h3>
        ),
      });
      cursor++;
      continue;
    }

    if (trimmed.startsWith("## ")) {
      flushLists();
      tagged.push({
        kind: "block",
        node: (
          <h2 key={`h2-${tagged.length}`}>{renderInline(trimmed.slice(3))}</h2>
        ),
      });
      cursor++;
      continue;
    }

    if (trimmed.startsWith("# ")) {
      flushLists();
      tagged.push({
        kind: "block",
        node: (
          <h1 key={`h1-${tagged.length}`}>{renderInline(trimmed.slice(2))}</h1>
        ),
      });
      cursor++;
      continue;
    }

    if (trimmed.startsWith("- ")) {
      const raw = trimmed.slice(2).trim();
      listItems.push(renderInline(raw));
      listRaw.push(raw);
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
    const kind: TaggedKind = /^contacts?:$/i.test(trimmed)
      ? "p-contact"
      : isShortLine(trimmed)
        ? "p-short"
        : "p";
    tagged.push({
      kind,
      rawText: trimmed,
      node: <p key={`p-${tagged.length}`}>{renderInline(trimmed)}</p>,
    });
    cursor++;
  }

  flushLists();

  if (!enhance) return tagged.map((t) => t.node);

  // -------------------------------------------------------------------------
  // Enhancement post-pass (authenticated reader only).
  // -------------------------------------------------------------------------

  const parseContacts = (rawItems: string[]): ContactItem[] =>
    rawItems.map((raw) => {
      const m = raw.match(EMAIL_ITEM_RE)!;
      return { email: m[1], description: m[2] };
    });

  const isEmailList = (t: Tagged): boolean =>
    t.kind === "ul" &&
    (t.rawItems?.length ?? 0) > 0 &&
    t.rawItems!.every((r) => EMAIL_ITEM_RE.test(r));

  const isChipList = (t: Tagged): boolean =>
    t.kind === "ul" &&
    (t.rawItems?.length ?? 0) >= 3 &&
    t.rawItems!.length <= 8 &&
    t.rawItems!.every(
      (r) =>
        r.length >= 8 &&
        r.length <= 36 &&
        r.split(/\s+/).length >= 2 &&
        !/[.[\]@]/.test(r),
    );

  const out: ReactNode[] = [];
  let i = 0;
  while (i < tagged.length) {
    const t = tagged[i];

    // Provider panel: run of ≥2 short lines (+ optional "Contact:") +
    // email list — the corpus shape of every provider/impressum block.
    if (t.kind === "p-short") {
      let j = i;
      const address: string[] = [];
      while (j < tagged.length && tagged[j].kind === "p-short") {
        address.push(tagged[j].rawText!);
        j++;
      }
      let k = j;
      if (k < tagged.length && tagged[k].kind === "p-contact") k++;
      if (address.length >= 2 && k < tagged.length && isEmailList(tagged[k])) {
        out.push(
          <ProviderPanel
            key={`prov-${i}`}
            addressLines={address}
            contacts={parseContacts(tagged[k].rawItems!)}
          />,
        );
        i = k + 1;
        continue;
      }
      // No panel — emit the short lines as ordinary paragraphs.
      for (let x = i; x < j; x++) out.push(tagged[x].node);
      i = j;
      continue;
    }

    // Contact list preceded by a "Contact:" label paragraph.
    if (t.kind === "p-contact") {
      if (i + 1 < tagged.length && isEmailList(tagged[i + 1])) {
        out.push(
          <ContactPanel
            key={`contact-${i}`}
            contacts={parseContacts(tagged[i + 1].rawItems!)}
          />,
        );
        i += 2;
        continue;
      }
      out.push(t.node);
      i++;
      continue;
    }

    if (isEmailList(t)) {
      out.push(
        <ContactPanel key={`contact-${i}`} contacts={parseContacts(t.rawItems!)} />,
      );
      i++;
      continue;
    }

    if (isChipList(t)) {
      out.push(<ChipRow key={`chips-${i}`} items={t.rawItems!} />);
      i++;
      continue;
    }

    out.push(t.node);
    i++;
  }

  return out;
}
