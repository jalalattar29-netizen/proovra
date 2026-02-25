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
    <div className="blue-shell auth-screen">
      <div className="container">
        <header className="auth-top">
          <Link href="/" className="auth-brand">
            <img src="/brand/icon-512.png?v=2" alt="PROO✓RA" />
            <span>PROO✓RA</span>
          </Link>
          <nav className="auth-top-links">
            <Link href="/login">Login</Link>
            <Link href="/register">Register</Link>
          </nav>
        </header>
        <main className="auth-main">
          <section className="auth-card legal-page">
            <h2 className="auth-title">{title}</h2>
            {renderMarkdown(content)}
          </section>
        </main>
      </div>
    </div>
  );
}
