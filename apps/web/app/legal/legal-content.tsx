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
  "privacy-matrix",
  "legal-changelog",
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
    "privacy-matrix": "Privacy Matrix",
    "legal-changelog": "Legal Changelog",
  };
  
  return map[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1);
}

export async function loadLegalMarkdown(slug: string) {
  const filePath = path.join(
    process.cwd(),
    "content",
    "legal",
    LEGAL_LOCALE,
    `${slug}.md`
  );
  return readFile(filePath, "utf8");
}

export function renderLegalMarkdown(md: string) {
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
        </ul>
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
        </ol>
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
          </strong>
        );
        return;
      }

      if (part.startsWith("*") && part.endsWith("*")) {
        out.push(
          <em key={`i-${i}`} style={{ color: "inherit" }}>
            {part.slice(1, -1)}
          </em>
        );
        return;
      }

      if (part.startsWith("[") && part.includes("](") && part.endsWith(")")) {
        const match = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (match) {
          const label = match[1];
          const href = match[2];
          const isExternal =
            /^https?:\/\//i.test(href) || /^mailto:/i.test(href);

          out.push(
            <a
              key={`a-${i}`}
              href={href}
              target={isExternal ? "_blank" : undefined}
              rel={isExternal ? "noreferrer noopener" : undefined}
              className="legal-link"
            >
              {label}
            </a>
          );
          return;
        }
      }

      out.push(<span key={`t-${i}`}>{part}</span>);
    });

    return out.length === 1 ? out[0] : <>{out}</>;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      flushLists();
      continue;
    }

    if (trimmed === "---") {
      flushLists();
      nodes.push(<hr key={`hr-${nodes.length}`} className="legal-divider" />);
      continue;
    }

    if (trimmed.startsWith("### ")) {
      flushLists();
      nodes.push(
        <h3 key={`h3-${nodes.length}`}>{renderInline(trimmed.slice(4))}</h3>
      );
      continue;
    }

    if (trimmed.startsWith("## ")) {
      flushLists();
      nodes.push(
        <h2 key={`h2-${nodes.length}`}>{renderInline(trimmed.slice(3))}</h2>
      );
      continue;
    }

    if (trimmed.startsWith("# ")) {
      flushLists();
      nodes.push(
        <h1 key={`h1-${nodes.length}`}>{renderInline(trimmed.slice(2))}</h1>
      );
      continue;
    }

    if (trimmed.startsWith("- ")) {
      listItems.push(renderInline(trimmed.slice(2)));
      continue;
    }

    const orderedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (orderedMatch) {
      orderedItems.push(renderInline(orderedMatch[1]));
      continue;
    }

    flushLists();
    nodes.push(<p key={`p-${nodes.length}`}>{renderInline(trimmed)}</p>);
  }

  flushLists();
  return nodes;
}