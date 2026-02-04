import { readFile } from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { TopBar } from "../../../components/ui";

const ALLOWED_SLUGS = new Set(["privacy", "terms", "cookies", "security"]);
const LOCALES = ["en", "ar", "de"] as const;
type Locale = (typeof LOCALES)[number];

function pickLocale(acceptLanguage: string | null, forced?: string): Locale {
  if (forced && LOCALES.includes(forced as Locale)) return forced as Locale;
  if (!acceptLanguage) return "en";
  const lower = acceptLanguage.toLowerCase();
  if (lower.includes("ar")) return "ar";
  if (lower.includes("de")) return "de";
  return "en";
}

function renderMarkdown(md: string) {
  const lines = md.split("\n");
  const nodes: Array<JSX.Element> = [];
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
  params,
  searchParams
}: {
  params: { slug: string };
  searchParams?: { lang?: string };
}) {
  if (!ALLOWED_SLUGS.has(params.slug)) return notFound();

  const acceptLanguage = headers().get("accept-language");
  const locale = pickLocale(acceptLanguage, searchParams?.lang);
  const filePath = path.join(
    process.cwd(),
    "content",
    "legal",
    locale,
    `${params.slug}.md`
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
        `${params.slug}.md`
      );
      content = await readFile(fallbackPath, "utf8");
    } else {
      throw new Error("Missing legal content");
    }
  }

  return (
    <div className="page">
      <TopBar title="Proovra" right={<Link href="/">{locale === "ar" ? "الصفحة الرئيسية" : "Home"}</Link>} />
      <section className="section legal-page">{renderMarkdown(content)}</section>
    </div>
  );
}
