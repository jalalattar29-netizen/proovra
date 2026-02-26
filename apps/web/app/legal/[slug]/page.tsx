import { readFile } from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { MarketingHeader } from "../../../components/header";

const ALLOWED_SLUGS = new Set(["privacy", "terms", "cookies", "security"]);
type Locale = "en";

function titleFromSlug(slug: string) {
  if (!slug) return "Legal";
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

function renderMarkdown(md: string) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const nodes: ReactNode[] = [];

  let listItems: ReactNode[] = [];

  const flushList = () => {
    if (listItems.length === 0) return;
    nodes.push(
      <ul key={`list-${nodes.length}`} className="legal-list">
        {listItems.map((item, idx) => (
          <li key={idx}>{item}</li>
        ))}
      </ul>
    );
    listItems = [];
  };

  // inline renderer: **bold**, *italic*, [text](url)
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
        const m = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (m) {
          const label = m[1];
          const href = m[2];
          const isExternal = /^https?:\/\//i.test(href) || /^mailto:/i.test(href);
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
      flushList();
      continue;
    }

    if (trimmed.startsWith("### ")) {
      flushList();
      nodes.push(<h3 key={`h3-${nodes.length}`}>{renderInline(trimmed.slice(4))}</h3>);
      continue;
    }
    if (trimmed.startsWith("## ")) {
      flushList();
      nodes.push(<h2 key={`h2-${nodes.length}`}>{renderInline(trimmed.slice(3))}</h2>);
      continue;
    }
    if (trimmed.startsWith("# ")) {
      flushList();
      nodes.push(<h1 key={`h1-${nodes.length}`}>{renderInline(trimmed.slice(2))}</h1>);
      continue;
    }

    if (trimmed.startsWith("- ")) {
      listItems.push(renderInline(trimmed.slice(2)));
      continue;
    }

    flushList();
    nodes.push(<p key={`p-${nodes.length}`}>{renderInline(trimmed)}</p>);
  }

  flushList();
  return nodes;
}

export default async function LegalPage({
  params
}: {
  params?: Promise<{ slug: string }>;
}) {
  const resolvedParams = (await params) ?? { slug: "" };
  const slug = resolvedParams.slug;

  if (!ALLOWED_SLUGS.has(slug)) return notFound();

  await headers();

  const locale: Locale = "en";
  const filePath = path.join(process.cwd(), "content", "legal", locale, `${slug}.md`);

  let content = "";
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    if (locale !== "en") {
      const fallbackPath = path.join(process.cwd(), "content", "legal", "en", `${slug}.md`);
      content = await readFile(fallbackPath, "utf8");
    } else {
      throw new Error("Missing legal content");
    }
  }

  const title = titleFromSlug(slug);

  return (
    <div className="page landing-page">
      <div className="blue-shell">
        <MarketingHeader />
        <section className="section container hero-section-tight legal-hero">
          <h1 className="hero-title">{title}</h1>
          <p className="page-subtitle" style={{ maxWidth: 760 }}>
            Legal information and policies for PROO✓RA.
          </p>
        </section>
      </div>

      <section className="section section-body">
        <div className="container">
          <article className="auth-card legal-page">{renderMarkdown(content)}</article>
        </div>
      </section>

      <footer className="landing-footer container">
        <div className="footer-left">
          <div className="footer-brand">PROO✓RA</div>
          <a href="mailto:support@proovra.com">support@proovra.com</a>
        </div>
        <div className="footer-links">
          <Link href="/privacy">Privacy Policy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/legal/cookies">Cookies</Link>
          <Link href="/legal/security">Security</Link>
          <Link href="/support">Support</Link>
        </div>
      </footer>
    </div>
  );
}