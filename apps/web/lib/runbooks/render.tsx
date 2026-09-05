/**
 * A MARKDOWN RENDERER FOR THE RUNBOOK CORPUS, AND NOTHING ELSE.
 *
 * ===========================================================================
 * WHY NOT REUSE THE LEGAL RENDERER
 * ===========================================================================
 * `app/legal/legal-content.tsx` already renders markdown, but it renders LEGAL
 * documents: it carries provider panels, contact blocks, an authenticated-exit
 * rule for links that leave the App Shell, and a presentation vocabulary built
 * for a policy corpus. Pointing an operator runbook at it would couple two
 * surfaces that have nothing to do with each other, and the first change either
 * one needed would break the other.
 *
 * ===========================================================================
 * WHY NOT A LIBRARY
 * ===========================================================================
 * A markdown library brings a sanitiser and an HTML pipeline, and the
 * combination invites `dangerouslySetInnerHTML`. Nothing here produces HTML at
 * all — every construct becomes a React element — so there is no injection
 * surface to sanitise. The runbook corpus is repository content under review,
 * but "our own content" is exactly the assumption that turns into an incident
 * the day someone pastes an example payload into a runbook.
 *
 * ===========================================================================
 * WHAT IT SUPPORTS
 * ===========================================================================
 * Measured against the actual corpus rather than guessed at: headings (h1-h3),
 * paragraphs, unordered and ordered lists, fenced code, tables, blockquotes,
 * horizontal rules, and the inline set (bold, inline code, links). There are no
 * images and no h4 in the corpus, and anything unrecognised falls through as
 * literal text rather than disappearing — a runbook step that silently vanishes
 * because of an unsupported construct is worse than one that renders plainly.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { RunbookCodeBlock } from "./CodeBlock";
import { tokenizeInline } from "./inline-tokens";

// ---------------------------------------------------------------------------
// Inline.
// ---------------------------------------------------------------------------

/**
 * Map tokens to elements.
 *
 * WHAT a span is, is decided by `tokenizeInline` — plain data, so the web
 * suite can sweep the whole corpus for unrendered emphasis without a DOM. This
 * function only decides how each token LOOKS.
 */
export function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return tokenizeInline(text).map((t, i) => {
    const key = `${keyPrefix}-i${i}`;
    switch (t.kind) {
      case "text":
        return t.value;
      case "bold":
        return <strong key={key}>{t.value}</strong>;
      case "italic":
        return <em key={key}>{t.value}</em>;
      case "code":
        return (
          <code key={key} className="rb-code-inline">
            {t.value}
          </code>
        );
      case "link":
        return renderLink(t.value, t.href, key);
    }
  });
}

/**
 * A link, with the corpus's own conventions honoured.
 *
 * Runbooks cross-reference each other as `./other-runbook.md` — a relative
 * repository path that means nothing in a browser. It is rewritten to the
 * console route so a cross-reference is followable in the product, which is the
 * whole reason the detail view exists.
 *
 * An absolute external URL opens in a new tab and carries `rel="noopener
 * noreferrer"`: an operator following a provider status link mid-incident
 * should not lose the runbook.
 */
function renderLink(label: string, href: string, key: string): ReactNode {
  const runbook = /^\.?\/?([a-z0-9-]+)\.md(#.*)?$/i.exec(href);
  if (runbook) {
    return (
      <Link key={key} href={`/admin/platform/runbooks/${runbook[1]}`}>
        {label}
      </Link>
    );
  }
  if (/^https?:\/\//i.test(href)) {
    return (
      <a key={key} href={href} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    );
  }
  if (href.startsWith("/")) {
    return (
      <Link key={key} href={href}>
        {label}
      </Link>
    );
  }
  // A relative path that is not another runbook points at a repository file
  // the browser cannot open. Rendering it as text with the path visible is
  // more useful than a link that 404s.
  return (
    <span key={key}>
      {label} (<code className="rb-code-inline">{href}</code>)
    </span>
  );
}

// ---------------------------------------------------------------------------
// Block.
// ---------------------------------------------------------------------------

function cells(row: string): string[] {
  return row
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

const IS_DIVIDER = (l: string) => /^\|?[\s:|-]+\|[\s:|-]*$/.test(l);

export function renderRunbookMarkdown(md: string): ReactNode[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");

  /**
   * Does this line CONTINUE the list item above it?
   *
   * The corpus is hard-wrapped at ~80 columns, so an item longer than that is
   * written as a bullet plus one or more INDENTED continuation lines:
   *
   *   - Egress from the API to the provider during the window — a firewall or
   *     DNS change is as likely as a provider outage.
   *
   * The list loops below consumed only lines matching the bullet pattern, so
   * they stopped at the first continuation and the remainder fell through to
   * the PARAGRAPH branch. The rendered result was a bullet ending "a firewall
   * or" and, beneath the whole list, an unindented paragraph beginning "DNS
   * change is as likely as". 394 items across 21 of the 29 runbooks were split
   * that way: every operator procedure in the platform had sentences broken in
   * half, and the break moved whenever somebody reflowed the source.
   *
   * Deliberately narrow. A line inside a fenced block never reaches this,
   * because the fence branch consumes its body verbatim first.
   */
  const isContinuation = (l: string | undefined) =>
    l !== undefined &&
    l.trim() !== "" &&
    /^\s+\S/.test(l) &&
    !/^\s*[-*]\s+/.test(l) &&
    !/^\s*\d+\.\s+/.test(l) &&
    !l.trimStart().startsWith("```");

  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  const key = () => `rb-${k++}`;

  while (i < lines.length) {
    const line = lines[i];

    /* Fenced code. Consumed first and verbatim: everything inside is content,
       including lines that would otherwise look like headings or lists.
       =======================================================================
       THE FENCE DOES NOT HAVE TO START AT COLUMN 0
       =======================================================================
       This required `line.startsWith("```")`, so a fence INDENTED under a
       numbered step — which is how a runbook writes the command for step 2 —
       was not recognised as a fence at all. Measured across the 33 runbooks:
       ten fenced blocks on five runbooks fell through to the paragraph
       handler and rendered as this:

         Identify the first broken row: ``sql SELECT id, "createdAt",
         "prevHash", "hash" FROM "AdminAuditLog" WHERE id = ( SELECT id …

       — every newline collapsed to a space, the fence markers printed as
       literal backticks (one eaten by the inline-code pass), and no copy
       control. That is a SQL statement an operator is meant to run at 3am,
       rendered as a sentence they cannot copy and cannot read.

       The body is dedented by the fence's own indentation, so the command
       keeps its internal shape without carrying the list's indent. */
    const fence = /^(\s*)```(.*)$/.exec(line);
    if (fence) {
      const indent = fence[1].length;
      const lang = fence[2].trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i].slice(0, indent).trim() === "" ? lines[i].slice(indent) : lines[i]);
        i += 1;
      }
      i += 1; // closing fence
      // A command in a runbook gets RUN, so it gets a copy control and its
      // language label rather than being a dark block somebody selects by
      // hand at 3am. See CodeBlock.tsx.
      out.push(
        <RunbookCodeBlock key={key()} body={body.join("\n")} lang={lang} />,
      );
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Horizontal rule.
    if (/^-{3,}$/.test(line.trim())) {
      out.push(<hr key={key()} className="rb-hr" />);
      i += 1;
      continue;
    }

    // Headings. h1 is the document title, which the page renders in its own
    // header, so it is skipped here rather than repeated.
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const depth = h[1].length;
      const text = h[2].replace(/^Runbook\s+—\s+/, "");
      if (depth === 1) {
        i += 1;
        continue;
      }
      const id = text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const Tag = depth === 2 ? "h2" : "h3";
      out.push(
        // The id makes every section deep-linkable, so an incident can point
        // at the step rather than the document.
        <Tag key={key()} id={id} className={`rb-h${depth}`}>
          {renderInline(text, key())}
        </Tag>,
      );
      i += 1;
      continue;
    }

    /* Table. A header row followed by a divider — or, in four of the reviewer
       runbooks, a run of pipe rows with NO header and NO divider:

         ## Escalation path

         | 0-1 hour | Reviewer Ops on-call reassigns. |
         | 1-4 hours | Workspace admin assesses whether … |
         | 4+ hours  | Operations lead reviews … |

       That is not valid GFM, and the renderer's original answer was to let it
       fall through to the paragraph branch, which produced one run-on
       sentence of pipes. Rendering the escalation path of an incident runbook
       as `| 0-1 hour | Reviewer Ops on-call reassigns. | | 1-4 hours | …` is
       not a cosmetic problem: it is the section an operator reads while
       deciding who to wake up.

       A run of two or more rows that both open and close with `|` is
       unambiguous enough to render as a headerless table. A SINGLE stray pipe
       line still falls through, which is the case the original comment was
       protecting against. */
    const hasDivider = IS_DIVIDER(lines[i + 1] ?? "");
    const isPipeRow = (l: string | undefined) =>
      l !== undefined && /^\s*\|.*\|\s*$/.test(l);
    if (
      line.trimStart().startsWith("|") &&
      (hasDivider || (isPipeRow(line) && isPipeRow(lines[i + 1])))
    ) {
      const head = hasDivider ? cells(line) : null;
      i += hasDivider ? 2 : 0;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        rows.push(cells(lines[i]));
        i += 1;
      }
      out.push(
        // Wide tables scroll inside their own container. The page body must
        // never scroll horizontally.
        <div key={key()} className="rb-table-wrap">
          <table className="rb-table">
            {/* A headerless run gets no <thead> rather than an empty one: an
                empty header row is a blank band above the data that reads as
                a rendering fault. */}
            {head ? (
              <thead>
                <tr>
                  {head.map((c, n) => (
                    <th key={n}>{renderInline(c, `${key()}-h${n}`)}</th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {rows.map((r, rn) => (
                <tr key={rn}>
                  {r.map((c, cn) => (
                    <td key={cn}>{renderInline(c, `${key()}-c${rn}-${cn}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Blockquote. The corpus uses it for honesty notes and warnings, which are
    // the paragraphs that most need to survive a skim.
    if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        body.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      out.push(
        <blockquote key={key()} className="rb-quote">
          {renderInline(body.join(" ").trim(), key())}
        </blockquote>,
      );
      continue;
    }

    // Unordered list, including the two nested items in the corpus.
    if (/^\s*[-*]\s+/.test(line)) {
      const items: { depth: number; text: string }[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const indent = /^(\s*)/.exec(lines[i])![1].length;
        const parts = [lines[i].replace(/^\s*[-*]\s+/, "")];
        i += 1;
        // Absorb the hard-wrap with ONE space: the source line break is a
        // typographic accident of an 80-column file, not a break the reader
        // should see.
        while (isContinuation(lines[i])) {
          parts.push(lines[i].trim());
          i += 1;
        }
        items.push({ depth: indent >= 2 ? 1 : 0, text: parts.join(" ") });
      }
      out.push(
        <ul key={key()} className="rb-ul">
          {items.map((it, n) => (
            <li key={n} data-depth={it.depth} className="rb-li">
              {renderInline(it.text, `${key()}-l${n}`)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list. `start` is preserved, because a runbook's step 4 must not
    // renumber itself to 1 when the list is interrupted by a code block.
    if (/^\s*\d+\.\s+/.test(line)) {
      const first = Number(/^\s*(\d+)\./.exec(line)![1]);
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const parts = [lines[i].replace(/^\s*\d+\.\s+/, "")];
        i += 1;
        while (isContinuation(lines[i])) {
          parts.push(lines[i].trim());
          i += 1;
        }
        items.push(parts.join(" "));
      }
      out.push(
        <ol key={key()} className="rb-ol" start={first}>
          {items.map((t, n) => (
            <li key={n} className="rb-li">
              {renderInline(t, `${key()}-o${n}`)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph — every consecutive non-blank line that starts no other block.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      // An INDENTED fence ends a paragraph too, or the command it opens is
      // swallowed into the sentence above it.
      !/^\s*```/.test(lines[i]) &&
      !lines[i].startsWith(">") &&
      // A table's header row must reach the table branch. Without this the
      // paragraph loop reaches it first whenever no blank line separates
      // them, and the whole table renders as one run-on sentence.
      !lines[i].trimStart().startsWith("|") &&
      !/^#{1,3}\s/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^-{3,}$/.test(lines[i].trim())
    ) {
      para.push(lines[i]);
      i += 1;
    }
    if (para.length > 0) {
      out.push(
        <p key={key()} className="rb-p">
          {renderInline(para.join(" "), key())}
        </p>,
      );
    } else {
      // Nothing matched and nothing was consumed. Advance rather than loop
      // forever: an infinite loop in a render is a hung tab, not an error
      // anybody can diagnose.
      i += 1;
    }
  }

  return out;
}
