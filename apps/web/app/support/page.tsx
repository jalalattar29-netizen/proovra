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

export default async function SupportPage() {
  await headers();

  const filePath = path.join(process.cwd(), "content", "legal", "en", "support.md");
  const content = await readFile(filePath, "utf8");
  const title = "Support";

  return (
    <div className="page landing-page">
      <div className="blue-shell">
        {/* Marketing header (نفس الصفحة الرئيسية) */}
        <header className="proovra-header">
          <div className="container proovra-header-inner">
            <Link href="/" className="proovra-logo">
              <img src="/brand/icon-512.png?v=2" alt="PROO✓RA" width={34} height={34} />
              <span>PROO✓RA</span>
            </Link>

            <nav className="proovra-nav proovra-nav-app proovra-nav-app-desktop">
              <Link href="/" className="proovra-nav-link">
                <span>Home</span>
              </Link>
              <Link href="/features" className="proovra-nav-link">
                <span>Features</span>
              </Link>
              <Link href="/pricing" className="proovra-nav-link">
                <span>Pricing</span>
              </Link>
              <Link href="/legal/security" className="proovra-nav-link">
                <span>Security</span>
              </Link>
              <Link href="/about" className="proovra-nav-link">
                <span>About</span>
              </Link>
            </nav>

            <div className="proovra-header-actions">
              <button type="button" className="proovra-lang-btn" aria-label="Language">
                EN
              </button>
              <Link href="/login" className="proovra-auth-link">
                Login
              </Link>
              <Link href="/register" className="proovra-auth-btn">
                Register
              </Link>
            </div>
          </div>
        </header>

        <section className="section container hero-section-tight">
          <h1 className="hero-title">{title}</h1>
          <p className="page-subtitle" style={{ maxWidth: 720 }}>
            Get help, contact support, and find answers.
          </p>
        </section>
      </div>

      {/* نفس SilverWatermarkSection لكن بدون Component (حتى ما نخاطر بـ "use client") */}
      <section className="silver-watermark-section section section-body" style={{ paddingTop: 48 }}>
        <img
          src="/brand/silver-watermark-combined.png?v=2"
          alt=""
          aria-hidden="true"
          className="silver-watermark-image"
        />
        <div className="silver-watermark-content">
          <div className="container">
            <section className="auth-card legal-page" style={{ maxWidth: 920, margin: "0 auto" }}>
              {renderMarkdown(content)}
            </section>
          </div>
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