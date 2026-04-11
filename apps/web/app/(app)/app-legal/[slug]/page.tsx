import { notFound } from "next/navigation";
import {
  ALLOWED_LEGAL_SLUGS,
  loadLegalMarkdown,
  renderLegalMarkdown,
  titleFromSlug,
} from "../../../legal/legal-content";

export default async function AppLegalPage({
  params,
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
      <style>{`
        .app-legal-page .app-legal-body {
          position: relative;
          overflow: hidden;
          background: linear-gradient(180deg, rgba(239,241,238,0.96) 0%, rgba(234,237,234,0.98) 100%);
          padding-top: 2rem;
          padding-bottom: 4.5rem;
        }

        .app-legal-page .app-legal-background {
          position: absolute;
          inset: 0;
          pointer-events: none;
          z-index: 0;
        }

        .app-legal-page .app-legal-background img {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: cover;
          object-position: top;
          opacity: 0.12;
          filter: saturate(0.55) brightness(1.02) contrast(0.94);
        }

        .app-legal-page .app-legal-background::before {
          content: "";
          position: absolute;
          inset: 0;
          background:
            linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 22%, rgba(255,255,255,0.03) 78%, rgba(255,255,255,0.08) 100%),
            linear-gradient(90deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.03) 12%, rgba(255,255,255,0.00) 24%, rgba(255,255,255,0.00) 76%, rgba(255,255,255,0.03) 88%, rgba(255,255,255,0.10) 100%);
        }

        .app-legal-page .app-legal-shell {
          position: relative;
          z-index: 1;
        }

        .app-legal-page .app-legal-card {
          position: relative;
          overflow: hidden;
          border-radius: 30px;
          border: 1px solid rgba(79,112,107,0.16);
          box-shadow:
            0 18px 38px rgba(0,0,0,0.08),
            inset 0 1px 0 rgba(255,255,255,0.48);
        }

        .app-legal-page .app-legal-card__bg {
          position: absolute;
          inset: 0;
          background-image: url("/images/panel-silver.webp.png");
          background-size: cover;
          background-position: center;
        }

        .app-legal-page .app-legal-card__overlay {
          position: absolute;
          inset: 0;
          background:
            radial-gradient(circle at 16% 12%, rgba(255,255,255,0.34), transparent 28%),
            linear-gradient(
              180deg,
              rgba(255,255,255,0.22) 0%,
              rgba(248,249,246,0.32) 38%,
              rgba(239,241,238,0.40) 100%
            );
        }

        .app-legal-page .app-legal-card__content {
          position: relative;
          z-index: 1;
          padding: 28px 30px;
        }

        .app-legal-page .app-legal-intro {
          margin-bottom: 22px;
          padding: 16px 18px;
          border-radius: 18px;
          border: 1px solid rgba(183,157,132,0.16);
          background:
            linear-gradient(180deg, rgba(250,248,245,0.72) 0%, rgba(243,239,234,0.88) 100%);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.62),
            0 10px 22px rgba(92,69,50,0.05);
          color: #8a6e57;
          line-height: 1.8;
          font-size: 14px;
        }

        .app-legal-page .legal-content {
          color: #31484d;
          line-height: 1.9;
          font-size: 15px;
        }

        .app-legal-page .legal-content h1,
        .app-legal-page .legal-content h2,
        .app-legal-page .legal-content h3,
        .app-legal-page .legal-content h4 {
          color: #21353a;
          letter-spacing: -0.02em;
          margin-top: 1.7em;
          margin-bottom: 0.7em;
          line-height: 1.2;
        }

        .app-legal-page .legal-content h1:first-child,
        .app-legal-page .legal-content h2:first-child,
        .app-legal-page .legal-content h3:first-child {
          margin-top: 0;
        }

        .app-legal-page .legal-content h1 {
          font-size: 1.7rem;
        }

        .app-legal-page .legal-content h2 {
          font-size: 1.28rem;
          color: #284348;
        }

        .app-legal-page .legal-content h3,
        .app-legal-page .legal-content h4 {
          color: #8a6e57;
          font-size: 1.02rem;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }

        .app-legal-page .legal-content p,
        .app-legal-page .legal-content li {
          color: #466065;
        }

        .app-legal-page .legal-content strong {
          color: #21353a;
          font-weight: 700;
        }

        .app-legal-page .legal-content em {
          color: #6e5a48;
        }

        .app-legal-page .legal-content a {
          color: #2f625d;
          text-decoration: none;
          border-bottom: 1px solid rgba(47,98,93,0.24);
          transition: color 0.18s ease, border-color 0.18s ease;
        }

        .app-legal-page .legal-content a:hover {
          color: #214847;
          border-bottom-color: rgba(33,72,71,0.38);
        }

        .app-legal-page .legal-content ul,
        .app-legal-page .legal-content ol {
          padding-left: 1.35rem;
        }

        .app-legal-page .legal-content li::marker {
          color: #9b826b;
        }

        .app-legal-page .legal-content blockquote {
          margin: 1.3rem 0;
          padding: 1rem 1.1rem;
          border-left: 4px solid rgba(183,157,132,0.34);
          background:
            linear-gradient(180deg, rgba(255,255,255,0.52) 0%, rgba(248,244,240,0.72) 100%);
          border-radius: 16px;
          color: #5a6e72;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.46);
        }

        .app-legal-page .legal-content hr {
          border: 0;
          border-top: 1px solid rgba(79,112,107,0.10);
          margin: 1.8rem 0;
        }

        .app-legal-page .legal-content table {
          width: 100%;
          border-collapse: collapse;
          margin: 1rem 0 1.4rem;
          overflow: hidden;
          border-radius: 18px;
          background:
            linear-gradient(180deg, rgba(255,255,255,0.54) 0%, rgba(247,248,246,0.82) 100%);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.54),
            0 10px 24px rgba(0,0,0,0.04);
        }

        .app-legal-page .legal-content th,
        .app-legal-page .legal-content td {
          border: 1px solid rgba(79,112,107,0.10);
          padding: 0.82rem 0.92rem;
          text-align: left;
          vertical-align: top;
        }

        .app-legal-page .legal-content th {
          color: #21353a;
          background:
            linear-gradient(180deg, rgba(250,248,245,0.72) 0%, rgba(243,239,234,0.86) 100%);
        }

        .app-legal-page .legal-content td {
          color: #42565b;
        }

        .app-legal-page .legal-content code {
          background: rgba(255,255,255,0.68);
          color: #214847;
          padding: 0.14rem 0.36rem;
          border-radius: 8px;
          font-size: 0.92em;
          border: 1px solid rgba(79,112,107,0.08);
        }

        .app-legal-page .legal-content pre {
          background:
            linear-gradient(180deg, rgba(255,255,255,0.62) 0%, rgba(244,246,244,0.88) 100%);
          color: #24373b;
          padding: 1rem;
          border-radius: 16px;
          overflow-x: auto;
          border: 1px solid rgba(79,112,107,0.10);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.48);
        }

        .app-legal-page .legal-content pre code {
          background: transparent;
          padding: 0;
          border: 0;
        }

        @media (max-width: 768px) {
          .app-legal-page .app-legal-card__content {
            padding: 22px 18px;
          }
        }
      `}</style>

      <div className="app-hero app-hero-full">
        <div className="container">
          <div style={{ maxWidth: 820 }}>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.72rem",
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.10)",
                background: "rgba(255,255,255,0.04)",
                padding: "8px 16px",
                fontSize: "0.68rem",
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: "0.28em",
                color: "#afbbb7",
                boxShadow: "0 10px 24px rgba(0,0,0,0.08)",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: "#b79d84",
                  opacity: 0.95,
                  display: "inline-block",
                  flexShrink: 0,
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

      <div className="app-body app-body-full app-legal-body">
        <div className="app-legal-background" aria-hidden="true">
          <img src="/images/landing-network-bg.png" alt="" />
        </div>

        <div className="container app-legal-shell">
          <div className="app-legal-card">
            <div className="app-legal-card__bg" />
            <div className="app-legal-card__overlay" />

            <div className="app-legal-card__content">
              <div className="app-legal-intro">
                This document is part of the PROO✓RA legal and compliance library.
                Review the policy carefully and keep it aligned with your internal,
                contractual, and regulatory obligations where applicable.
              </div>

              <article className="legal-content">{renderLegalMarkdown(content)}</article>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}