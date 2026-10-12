/**
 * THE GEOMETRIC RELEASE GATE OF THE RENDERED REPORT (2026-10-12).
 *
 * The text gate (checkRenderedReportText) reads WHAT the PDF says. This reads
 * WHERE it says it, from the positions PDF.js extracts from the bytes, and
 * refuses a report whose page is not a usable page:
 *
 *   PAGE_SIZE         a page that is not A4;
 *   PAGE_FOOTER       a page without its own "Page n/N" footer line, or a
 *                     footer drawn outside the footer zone;
 *   FOOTER_ZONE       any content entering the footer exclusion zone;
 *   PAGE_MARGIN       content above the top page margin;
 *   PAGE_BOUNDS       content outside the physical page;
 *   HORIZONTAL_OVERFLOW content running into the side margins (an unbroken
 *                     value that pushed past its column);
 *   BLANK_PAGE        a page with nothing but its footer;
 *   ORPHANED_HEADING  a section title with nothing under it on its page;
 *   REQUIRED_STATEMENT a statement the report must carry that is absent or
 *                     cut (the limitation, the provenance boundary, an updated
 *                     report's supersession notice).
 *
 * Clipping inside the page — an element cutting its own text — leaves no
 * trace in PDF text positions (Chromium emits the clipped run, or drops it
 * whole), so the renderer audits the laid-out document before printing
 * (LAYOUT_AUDIT_SCRIPT) and refuses to print one that clips.
 *
 * The page it measures against is THE page (report-v2/page-geometry.ts): the
 * same margins the stylesheet declares and the renderer passes to Chromium.
 */
import { openPdf, type PdfjsTextItem } from "./pdfjs-runtime.js";
import { REPORT_PAGE_PT } from "../report-v2/page-geometry.js";

export type GeometryFinding = { check: string; detail: string };

export type TextBox = { str: string; x: number; right: number; top: number; baseline: number; bottom: number; size: number };
export type PageGeometry = { number: number; width: number; height: number; items: TextBox[] };

/** Every non-blank text run of every page, in top-left page coordinates (points). */
export async function readReportGeometry(pdf: Uint8Array | Buffer): Promise<PageGeometry[]> {
  const doc = await openPdf(pdf);
  try {
    const pages: PageGeometry[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      const items: TextBox[] = [];
      for (const raw of content.items) {
        if (!("str" in raw)) continue;
        const item = raw as PdfjsTextItem;
        if (!item.str.trim()) continue;
        const [x, baseline] = viewport.convertToViewportPoint(item.transform[4]!, item.transform[5]!);
        const size = item.height;
        items.push({
          str: item.str,
          x,
          right: x + item.width,
          baseline,
          top: baseline - size * 0.8,
          bottom: baseline + size * 0.2,
          size,
        });
      }
      pages.push({ number: n, width: viewport.width, height: viewport.height, items });
      page.cleanup();
    }
    return pages;
  } finally {
    await doc.destroy();
  }
}

export type GeometryExpectation = {
  /** Statements the report must carry in full (whitespace-insensitive). */
  requiredStatements: ReadonlyArray<{ name: string; text: string }>;
};

const TOLERANCE = 0.75;
/** No content closer than this to a side edge (the report's columns sit 14 mm in). */
const SIDE_MARGIN = (8 / 25.4) * 72;
/** Section titles print at 18.5 px (≈ 13.9 pt); nothing else in the body is that large. */
const SECTION_TITLE_MIN_SIZE = 13;
/** The kicker every section prints above its title (letter-spaced in the PDF). */
const SECTION_KICKER = /^PROOVRAVERIFICATIONREPORT$/i;

const norm = (s: string) => s.replace(/­/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const clip = (s: string) => (s.length > 48 ? `${s.slice(0, 48)}…` : s);

/** The footer row of a page: the runs on the baseline of its "Page n/N". */
function footerRow(page: PageGeometry, total: number): { baseline: number } | null {
  const marker = page.items.find((it) => it.str.trim() === `Page ${page.number}/${total}`);
  return marker ? { baseline: marker.baseline } : null;
}

export function checkReportGeometry(pages: ReadonlyArray<PageGeometry>, expect: GeometryExpectation): GeometryFinding[] {
  const out: GeometryFinding[] = [];
  const total = pages.length;
  const bodyText: string[] = [];
  if (total === 0) out.push({ check: "BLANK_PAGE", detail: "the PDF has no pages" });

  for (const page of pages) {
    const at = `page ${page.number}`;
    if (Math.abs(page.width - REPORT_PAGE_PT.width) > 1 || Math.abs(page.height - REPORT_PAGE_PT.height) > 1) {
      out.push({ check: "PAGE_SIZE", detail: `${at} is ${page.width.toFixed(1)}×${page.height.toFixed(1)} pt, not A4` });
    }
    const zoneTop = page.height - REPORT_PAGE_PT.footerZone;
    const footer = footerRow(page, total);
    if (!footer) {
      out.push({ check: "PAGE_FOOTER", detail: `${at} does not carry its footer "Page ${page.number}/${total}"` });
    } else if (footer.baseline < zoneTop) {
      out.push({ check: "PAGE_FOOTER", detail: `${at}: the footer is drawn above the footer zone` });
    }
    const body = page.items.filter((it) => !footer || Math.abs(it.baseline - footer.baseline) > TOLERANCE);
    if (body.length === 0) out.push({ check: "BLANK_PAGE", detail: `${at} has no content` });
    // A page holding only a section's kicker and/or title is a heading cut off
    // from the content it introduces.
    else if (body.every((it) => it.size >= SECTION_TITLE_MIN_SIZE || SECTION_KICKER.test(it.str.replace(/\s+/g, "")))) {
      out.push({ check: "ORPHANED_HEADING", detail: `${at} holds only a section heading` });
    }

    for (const it of body) {
      if (it.x < -TOLERANCE || it.right > page.width + TOLERANCE || it.top < -TOLERANCE || it.bottom > page.height + TOLERANCE) {
        out.push({ check: "PAGE_BOUNDS", detail: `${at}: "${clip(it.str)}" lies outside the page` });
      } else if (it.bottom > zoneTop + TOLERANCE) {
        out.push({ check: "FOOTER_ZONE", detail: `${at}: "${clip(it.str)}" enters the footer zone` });
      } else if (it.top < REPORT_PAGE_PT.marginTop - TOLERANCE) {
        out.push({ check: "PAGE_MARGIN", detail: `${at}: "${clip(it.str)}" is above the top margin` });
      } else if (it.x < SIDE_MARGIN || it.right > page.width - SIDE_MARGIN) {
        out.push({ check: "HORIZONTAL_OVERFLOW", detail: `${at}: "${clip(it.str)}" runs into the side margin` });
      }
    }

    // A section title needs content under it on its own page.
    for (const heading of body.filter((it) => it.size >= SECTION_TITLE_MIN_SIZE)) {
      const below = body.some((it) => it !== heading && it.size < SECTION_TITLE_MIN_SIZE && it.top > heading.baseline);
      if (!below) out.push({ check: "ORPHANED_HEADING", detail: `${at}: "${clip(heading.str)}" has no content under it` });
    }
    bodyText.push(body.map((it) => it.str).join(" "));
  }

  const text = norm(bodyText.join(" "));
  for (const s of expect.requiredStatements) {
    if (!text.includes(norm(s.text))) {
      out.push({ check: "REQUIRED_STATEMENT", detail: `the ${s.name} is absent or cut ("${clip(s.text)}")` });
    }
  }
  // One finding per check and page is enough to refuse; keep the list readable.
  const seen = new Set<string>();
  return out.filter((f) => {
    const key = `${f.check}:${f.detail.split(":")[0]}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Run in the laid-out document (print media) before printing: every element
 * that clips its own overflowing text. Plain ES2022 in a string, out of the
 * transpiler's reach (see render-pdf.ts).
 */
export const LAYOUT_AUDIT_SCRIPT = `(() => {
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    const clipsX = cs.overflowX === "hidden" || cs.overflowX === "clip";
    const clipsY = cs.overflowY === "hidden" || cs.overflowY === "clip";
    if (!clipsX && !clipsY) continue;
    const text = (el.innerText || "").replace(/\\s+/g, " ").trim();
    if (!text) continue;
    const overX = clipsX && el.scrollWidth > el.clientWidth + 1;
    const overY = clipsY && el.scrollHeight > el.clientHeight + 1;
    if (!overX && !overY) continue;
    const cls = typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/).join(".") : el.tagName.toLowerCase();
    out.push({ element: cls.slice(0, 80), axis: overX ? "horizontal" : "vertical", text: text.slice(0, 60) });
  }
  return out;
})()`;

export type LayoutAuditEntry = { element: string; axis: "horizontal" | "vertical"; text: string };

export function layoutAuditFindings(entries: ReadonlyArray<LayoutAuditEntry>): GeometryFinding[] {
  return entries.slice(0, 20).map((e) => ({
    check: "CLIPPED_CONTENT",
    detail: `${e.element} cuts its own text ${e.axis === "horizontal" ? "sideways" : "at the bottom"} ("${clip(e.text)}")`,
  }));
}
