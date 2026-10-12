/**
 * THE REPORT PAGE (2026-10-12) — one definition of the printed page, read by
 * the stylesheet (`@page`), the PDF renderer (Puppeteer `margin`) and the
 * geometric release gate (output-verification). They used to disagree: the
 * stylesheet declared `@page { margin: 0 }`, which with `preferCSSPageSize`
 * overrode the renderer's 12 mm footer margin, so Chromium drew the footer
 * INSIDE the content area, and every section was a fixed `297mm` box with
 * `overflow: hidden` that silently cut whatever did not fit (a 120-event custody
 * chain lost 93 rows). The footer now lives in a real page margin no content
 * can enter, and sections flow onto as many pages as their content needs.
 */
export const REPORT_PAGE = {
  widthMm: 210,
  heightMm: 297,
  /** Breathing room above content on every page, including continuation pages. */
  marginTopMm: 10,
  /** The footer exclusion zone: Chromium draws the footer template here and nothing else. */
  marginBottomMm: 12,
} as const;

/** Height of the printable content area of one page. */
export const REPORT_PAGE_AREA_HEIGHT_MM = REPORT_PAGE.heightMm - REPORT_PAGE.marginTopMm - REPORT_PAGE.marginBottomMm;

const PT_PER_MM = 72 / 25.4;

/** The same page in PDF points (what PDF.js reports). */
export const REPORT_PAGE_PT = {
  width: REPORT_PAGE.widthMm * PT_PER_MM,
  height: REPORT_PAGE.heightMm * PT_PER_MM,
  marginTop: REPORT_PAGE.marginTopMm * PT_PER_MM,
  footerZone: REPORT_PAGE.marginBottomMm * PT_PER_MM,
} as const;
