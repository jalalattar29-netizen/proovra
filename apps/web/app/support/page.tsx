import { readFile } from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import { headers } from "next/headers";
import type { ReactNode } from "react";

function renderMarkdown(md: string) {
  const lines = md.split("\n");
  const nodes: ReactNode[] = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length === 0) return;
    nodes.push(
      <ul key={`list-${nodes.length}`}>
        {listItems.map((item, idx) => (
          <li key={idx}>{item}</li>
        ))}
      </ul>
    );
    listItems = [];
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      flushList();
      return;
    }
    if (trimmed.startsWith("### ")) {
      flushList();
      nodes.push(<h3 key={`h3-${nodes.length}`}>{trimmed.slice(4)}</h3>);
      return;
    }
    if (trimmed.startsWith("## ")) {
      flushList();
      nodes.push(<h2 key={`h2-${nodes.length}`}>{trimmed.slice(3)}</h2>);
      return;
    }
    if (trimmed.startsWith("# ")) {
      flushList();
      nodes.push(<h1 key={`h1-${nodes.length}`}>{trimmed.slice(2)}</h1>);
      return;
    }
    if (trimmed.startsWith("- ")) {
      listItems.push(trimmed.slice(2));
      return;
    }
    flushList();
    nodes.push(<p key={`p-${nodes.length}`}>{trimmed}</p>);
  });

  flushList();
  return nodes;
}

function LegalMarketingHeader() {
  return (
    <header className="proovra-header">
      <div className="container proovra-header-inner">
        <Link href="/" className="proovra-logo">
          <img src="/brand/icon-512.png?v=2" alt="PROO✓RA" width={34} height={34} />
          <span>PROO✓RA</span>
        </Link>

        <nav className="proovra-nav proovra-nav-app proovra-nav-app-desktop">
          <Link href="/home" className="proovra-nav-link">
            <span>Home</span>
          </Link>
          <Link href="/features" className="proovra-nav-link">
            <span>Features</span>
          </Link>
          <Link href="/pricing" className="proovra-nav-link">
            <span>Pricing</span>
          </Link>
          <Link href="/security" className="proovra-nav-link">
            <span>Security</span>
          </Link>
          <Link href="/about" className="proovra-nav-link">
            <span>About</span>
          </Link>
        </nav>

        <div className="proovra-actions">
          {/* Language pill نفس الهيدر */}
          <button type="button" className="proovra-lang-btn" aria-label="Language">
            EN
          </button>

          <Link href="/login" className="proovra-nav-link">
            <span>Login</span>
          </Link>

          <Link href="/register" className="proovra-cta">
            Register
          </Link>
        </div>
      </div>
    </header>
  );
}

export default async function SupportPage() {
  await headers();
  const filePath = path.join(process.cwd(), "content", "legal", "en", "support.md");
  const content = await readFile(filePath, "utf8");
  const title = "Support";

  return (
    <div className="page landing-page">
      <div className="blue-shell">
        <LegalMarketingHeader />

        <section className="section container hero-section-tight">
          <h1 className="hero-title">{title}</h1>
          <p className="page-subtitle" style={{ maxWidth: 720 }}>
            Help, contact, and frequently asked questions.
          </p>
        </section>
      </div>

      <section className="section section-body">
        <div className="container">
          <section className="auth-card legal-page legal-readable">
            {renderMarkdown(content)}
          </section>
        </div>
      </section>
    </div>
  );
}