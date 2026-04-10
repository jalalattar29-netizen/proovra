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
    <div className="section app-section app-legal-page">
      
      {/* HERO */}
      <div className="app-hero app-hero-full">
        <div className="container">
          <div style={{ maxWidth: 820 }}>
            
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.10)",
                background: "rgba(255,255,255,0.04)",
                padding: "8px 16px",
                fontSize: "0.68rem",
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: "0.28em",
                color: "#afbbb7",
                boxShadow: "0 10px 24px rgba(0,0,0,0.08)"
              }}
            >
              <span
                style={{
                  width: 4,
                  height: 4,
                  borderRadius: 999,
                  background: "#b79d84",
                  opacity: 0.8,
                  display: "inline-block"
                }}
              />
              Legal
            </div>

            <h1 className="mt-5 max-w-[760px] text-[1.72rem] font-medium leading-[1.02] tracking-[-0.045em] text-[#d9e2df] md:text-[2.22rem] lg:text-[2.72rem]">
              {titleFromSlug(slug)}
            </h1>

            <p className="mt-5 max-w-[720px] text-[0.95rem] leading-[1.8] tracking-[-0.006em] text-[#aab5b2]">
              Legal information, policies, and compliance documentation for PROO✓RA.
            </p>
          </div>
        </div>
      </div>

      {/* BODY */}
      <div className="app-body app-body-full app-legal-body">
        <div className="container">

          <div className="app-legal-card">
            <article className="legal-content">
              {renderLegalMarkdown(content)}
            </article>
          </div>

        </div>
      </div>
    </div>
  );
}