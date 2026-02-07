import { readFile } from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { TopBar } from "../../../components/ui";
import type { ReactNode } from "react";

const ALLOWED_SLUGS = new Set(["privacy", "terms", "cookies", "security"]);
type Locale = "en";

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

export default async function LegalPage({
  params
}: {
  params?: Promise<{ slug: string }>;
}) {
  const resolvedParams = (await params) ?? { slug: "" };
  if (!ALLOWED_SLUGS.has(resolvedParams.slug)) return notFound();

  await headers();
  const locale: Locale = "en";
  const filePath = path.join(
    process.cwd(),
    "content",
    "legal",
    locale,
    `${resolvedParams.slug}.md`
  );

  let content = "";
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    if (locale !== "en") {
      const fallbackPath = path.join(
        process.cwd(),
        "content",
        "legal",
        "en",
        `${resolvedParams.slug}.md`
      );
      content = await readFile(fallbackPath, "utf8");
    } else {
      throw new Error("Missing legal content");
    }
  }

  return (
    <div className="page">
      <TopBar title="Proovra" right={<Link href="/">Home</Link>} />
      <section className="section legal-page">
        {renderMarkdown(content)}
      </section>
    </div>
  );
}
