/**
 * Canonical legal-document typography + tokens (2026-07-18 redesign).
 *
 * ONE source of truth for the PROOVRA legal/trust document visual
 * system, shared by:
 *
 *   - the PUBLIC /legal/[slug] pages (the canonical external design),
 *   - the PUBLIC /trust Trust Center,
 *   - every AUTHENTICATED trust/legal documentation page rendered
 *     through `LegalDocumentShell`.
 *
 * The class chain below was extracted VERBATIM from the public
 * /legal/[slug] article so internal and external documents can never
 * drift apart. Do not fork these classes per route; extend here.
 */

/** Page background shared by every legal/trust document page. */
export const LEGAL_PAGE_BG = "#F6F9FC";

/** Single canonical hero artwork (same rule as LegalHero). */
export const LEGAL_HERO_IMAGE = "/assets/hero/legal-hero.png";

/** Legal/Trust title gradient — blue → violet → magenta. No cyan. */
export const LEGAL_TITLE_GRADIENT =
  "linear-gradient(90deg, #2563EB 0%, #7C3AED 50%, #C026D3 100%)";

/**
 * The canonical white document card + typography chain. Identical to
 * the public /legal/[slug] article styling.
 */
export const LEGAL_ARTICLE_CLASSES = `
  legal-page relative overflow-hidden rounded-[24px] border bg-white
  shadow-[0_18px_42px_rgba(8,18,22,0.04)]
  px-6 py-8 md:px-10 md:py-12 lg:px-14 lg:py-14
  text-[#0F172A]
  [&_h1]:hidden
  [&_h2]:mb-4 [&_h2]:mt-10 [&_h2]:text-[1.42rem] [&_h2]:font-semibold [&_h2]:leading-[1.18] [&_h2]:tracking-[-0.02em] [&_h2]:text-[#081426]
  [&_h2:first-child]:mt-0
  [&_h3]:mb-3 [&_h3]:mt-8 [&_h3]:text-[0.95rem] [&_h3]:font-bold [&_h3]:uppercase [&_h3]:tracking-[0.14em] [&_h3]:text-[#475569]
  [&_p]:my-0 [&_p]:mb-4 [&_p]:text-[0.98rem] [&_p]:leading-[1.88] [&_p]:text-[#475569]
  [&_strong]:font-semibold [&_strong]:text-[#081426]
  [&_em]:text-[#0F172A]
  [&_a.legal-link]:font-medium [&_a.legal-link]:text-[#2563EB] [&_a.legal-link]:underline [&_a.legal-link]:underline-offset-4 hover:[&_a.legal-link]:text-[#1E40AF]
  [&_ul]:my-4 [&_ul]:ml-0 [&_ul]:grid [&_ul]:gap-2.5 [&_ul]:pl-0
  [&_ol]:my-4 [&_ol]:ml-0 [&_ol]:grid [&_ol]:gap-2.5 [&_ol]:pl-0
  [&_li]:relative [&_li]:list-none [&_li]:pl-6 [&_li]:text-[0.98rem] [&_li]:leading-[1.78] [&_li]:text-[#475569]
  [&_ul>li::before]:absolute [&_ul>li::before]:left-0 [&_ul>li::before]:top-[0.75rem] [&_ul>li::before]:h-1.5 [&_ul>li::before]:w-1.5 [&_ul>li::before]:rounded-full [&_ul>li::before]:bg-[#2563EB] [&_ul>li::before]:content-['']
  [&_ol]:counter-reset-[legal-counter]
  [&_ol>li]:pl-10
  [&_ol>li::before]:absolute [&_ol>li::before]:left-0 [&_ol>li::before]:top-[0.15rem] [&_ol>li::before]:flex [&_ol>li::before]:h-7 [&_ol>li::before]:w-7 [&_ol>li::before]:items-center [&_ol>li::before]:justify-center [&_ol>li::before]:rounded-full [&_ol>li::before]:border [&_ol>li::before]:border-[#DDE6F2] [&_ol>li::before]:bg-[#F1F5F9] [&_ol>li::before]:text-[0.78rem] [&_ol>li::before]:font-semibold [&_ol>li::before]:text-[#0B1F4D] [&_ol>li::before]:content-[counter(legal-counter)]
  [&_ol>li]:counter-increment-[legal-counter]
  [&_hr]:my-8 [&_hr]:border-0 [&_hr]:h-px [&_hr]:bg-[linear-gradient(90deg,transparent_0%,#DDE6F2_30%,#DDE6F2_70%,transparent_100%)]
  [&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[0.9rem]
  [&_th]:border-b [&_th]:border-[#DDE6F2] [&_th]:px-2.5 [&_th]:py-2 [&_th]:text-left [&_th]:text-[0.78rem] [&_th]:font-bold [&_th]:uppercase [&_th]:tracking-[0.1em] [&_th]:text-[#475569]
  [&_td]:border-b [&_td]:border-[#EEF3FA] [&_td]:px-2.5 [&_td]:py-2 [&_td]:align-top [&_td]:text-[#475569]
  [&_code]:rounded [&_code]:bg-[#F1F5F9] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[0.82em] [&_code]:text-[#0B1F4D]
  [&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-[#DDE6F2] [&_blockquote]:pl-4 [&_blockquote]:text-[#475569]
`
  .replace(/\s+/g, " ")
  .trim();

/** Muted meta-line style used under document headings (version · state). */
export const LEGAL_META_CLASSES =
  "text-[12.5px] font-medium tracking-[0.01em] text-[#64748B]";
