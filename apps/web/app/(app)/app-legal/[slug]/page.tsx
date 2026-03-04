import { notFound } from "next/navigation";
import {
  ALLOWED_LEGAL_SLUGS,
  loadLegalMarkdown,
  renderLegalMarkdown,
  titleFromSlug
} from "../../../legal/legal-content";

export default async function AppLegalPage({
  params
}: {
  params?: Promise<{ slug: string }>;
}) {
  const resolvedParams = (await params) ?? { slug: "" };
  const slug = resolvedParams.slug;

  if (!ALLOWED_LEGAL_SLUGS.has(slug)) return notFound();

  let content = "";
  try {
    content = await loadLegalMarkdown(slug);
  } catch {
    throw new Error("Missing legal content");
  }

  return (
    <div className="section app-section">
      <div className="app-hero app-hero-full">
        <div className="container">
          <h1 className="hero-title pricing-hero-title" style={{ margin: 0 }}>
            {titleFromSlug(slug)}
          </h1>
          <p className="page-subtitle pricing-subtitle" style={{ marginTop: 6 }}>
            Legal information and policies for PROO✓RA.
          </p>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container">
          <article className="auth-card legal-page">{renderLegalMarkdown(content)}</article>
        </div>
      </div>
    </div>
  );
}
