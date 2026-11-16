// D:\digital-witness\services\worker\src\report-v2\render-pdf.ts
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import sharp from "sharp";
import { resolveReportAssetPath } from "./asset-data-url.js";

import { OutputVerificationError } from "../output-verification-error.js";
import { LAYOUT_AUDIT_SCRIPT, layoutAuditFindings, type LayoutAuditEntry } from "../pdf/report-geometry.js";
import { REPORT_PAGE, REPORT_PAGE_AREA_HEIGHT_MM } from "./page-geometry.js";
import { setPdfRendererIdentity } from "./pdf-renderer-identity.js";

/**
 * The PDF /Creator and /Producer of every report, whichever Chromium printed it
 * (full Chrome or chrome-headless-shell): never the host's user agent, the
 * browser's name or its version. Set on the printed bytes by
 * `setPdfRendererIdentity` (pdf-renderer-identity.ts).
 */
export const REPORT_PDF_CREATOR = "PROOVRA Verification Report Renderer";

export function resolveBrowserExecutablePath(): string | undefined {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH?.trim() || "",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/chrome",
    "/usr/lib/chromium/chromium",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      if (fs.existsSync(real)) return candidate;
    } catch {
      // ignore missing / broken browser candidates
    }
  }

  return undefined;
}

function escapeFooterHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fullReportId(value: string | null | undefined): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "N/A";

  // Only a verification reference is a footer reference (AUD-18).
  if (!/^pvr_[A-Za-z0-9_-]{8,}$/.test(raw)) return "N/A";

  return raw;
}

function normalizeGeneratedDate(value: string | null | undefined): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "Not recorded";

  const dateOnly = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return dateOnly?.[1] ?? raw;
}

/**
 * THE PAGE BACKGROUND IN THE MARGINS (2026-10-13). The stylesheet paints the
 * paper texture on the root element, which Chromium repeats over every page's
 * content area however little content the page holds; the top and bottom page
 * margins are painted by the header and footer templates with strips cut from
 * the same texture (the tile's last rows above the content, its first rows
 * below), so no white band appears on any page.
 */
let paperBands: Promise<{ top: string; bottom: string }> | null = null;
export function paperBandDataUrls(): Promise<{ top: string; bottom: string }> {
  paperBands ??= (async () => {
    const source = resolveReportAssetPath("paper-silver.png");
    const meta = await sharp(source).metadata();
    const width = meta.width ?? 1024;
    const height = meta.height ?? 1536;
    const rows = (mm: number) => Math.max(1, Math.round((height * mm) / REPORT_PAGE_AREA_HEIGHT_MM));
    const strip = async (top: number, h: number) =>
      `data:image/jpeg;base64,${(
        await sharp(source).extract({ left: 0, top, width, height: h }).resize({ width: 600 }).jpeg({ quality: 82 }).toBuffer()
      ).toString("base64")}`;
    const topRows = rows(REPORT_PAGE.marginTopMm);
    return { top: await strip(height - topRows, topRows), bottom: await strip(0, rows(REPORT_PAGE.marginBottomMm)) };
  })();
  return paperBands;
}

function bandStyle(url: string, heightMm: number): string {
  return `html,body{margin:0;padding:0}#header,#footer{padding:0 !important;margin:0 !important}.proovra-band{position:relative;width:100%;height:${heightMm}mm;background:url("${url}") 0 0/100% 100% no-repeat;-webkit-print-color-adjust:exact;print-color-adjust:exact}`;
}

export function buildHeaderTemplate(topBandUrl: string): string {
  return `<style>${bandStyle(topBandUrl, REPORT_PAGE.marginTopMm)}</style><div class="proovra-band"></div>`;
}

function buildFooterTemplate(params: {
  reportId: string;
  version: string;
  generatedDateUtc: string;
  bottomBandUrl: string;
}): string {
  const reportId = escapeFooterHtml(params.reportId);
  const version = escapeFooterHtml(params.version);
  const generatedDateUtc = escapeFooterHtml(params.generatedDateUtc);

  return `
    <style>
      ${bandStyle(params.bottomBandUrl, REPORT_PAGE.marginBottomMm)}
      .proovra-footer {
        width: 100%;
        box-sizing: border-box;
        padding: 0 12mm;
        font-family: "Segoe UI", Arial, Helvetica, sans-serif;
        font-size: 7.4px;
        font-weight: 750;
        color: #5f6868;
      }

      .proovra-footer-inner {
        width: 100%;
        box-sizing: border-box;
        border-top: 1px solid rgba(120, 130, 130, 0.42);
        padding-top: 3.2mm;
        display: flex;
        align-items: center;
        justify-content: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .proovra-footer-brand {
        color: #8f9393;
        font-weight: 950;
        letter-spacing: 0.055em;
      }

.proovra-footer-sep {
  color: #a7adad;
  padding: 0 8px;
}
  
      .proovra-footer-page {
        color: #233633;
        font-weight: 900;
      }
    </style>

    <div class="proovra-band"><div class="proovra-footer">
      <div class="proovra-footer-inner">
        <span class="proovra-footer-brand">PROOVRA</span>
        <span>&nbsp;Verification Report</span>
        <span class="proovra-footer-sep">|</span>
        <span>Ref: ${reportId}</span>
        <span class="proovra-footer-sep">|</span>
        <span>v${version}</span>
        <span class="proovra-footer-sep">|</span>
        <span class="proovra-footer-page">Page <span class="pageNumber"></span>/<span class="totalPages"></span></span>
        <span class="proovra-footer-sep">|</span>
        <span>Generated: ${generatedDateUtc} UTC</span>
      </div>
    </div></div>
  `;
}

/**
 * How long Chrome may take to start and print its DevTools endpoint. It covers
 * the launch only: page, render and validation timeouts are separate. The
 * production value is Puppeteer's own default.
 */
export const BROWSER_LAUNCH_TIMEOUT_MS = 30_000;

export type RenderPdfOptions = {
  /** Startup headroom for a cold Chrome on a loaded runner (tests only). */
  launchTimeoutMs?: number;
};

/**
 * B8-F-006 (free-audit 0ea0) — DEFENCE IN DEPTH for the report renderer.
 *
 * Record text (titles, notes, file names, EXIF) is escaped field by field in
 * the section templates. That is the primary control; this is the second one,
 * so a single unescaped field can neither reach the network nor run script:
 *
 *   1. REQUEST INTERCEPTION — the page may load only `data:` URLs,
 *      `about:blank`, and `file:` URLs inside the report's own asset
 *      directory (`report-v2/assets`, source or compiled). Every other request
 *      (http/https to the worker network or a metadata endpoint, any other
 *      local file) is aborted and counted.
 *   2. NO PAGE SCRIPT — a Content-Security-Policy meta (`script-src 'none'`,
 *      no connect / frame / object) is placed first in <head>. The renderer's
 *      own font/image wait, layout audit and footer read run through DevTools
 *      evaluation, which page CSP does not govern, so the templates keep
 *      working while injected markup cannot execute.
 */
export const REPORT_RENDER_CSP =
  "default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; img-src data: file:; font-src data: file:; style-src 'unsafe-inline' data: file:";

/**
 * B8-F-006 — a `<meta http-equiv=…>` (refresh, set-cookie, a competing CSP)
 * is not governed by the page CSP, and a refresh's timing is the browser's:
 * on one platform it fired before the navigation check, on another after it
 * (Linux CI, 2026-11-16), so interception alone could not refuse it
 * deterministically. No report template uses one (the renderer adds its own
 * CSP after this runs), so every such tag is removed before the page loads.
 * The tag is matched with quoted attribute values (a `>` inside quotes does
 * not end it) and by the attribute NAME, which HTML does not entity-decode.
 */
export function stripHttpEquivMeta(html: string): string {
  return html.replace(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) =>
    /[\s/]http-equiv\s*=/i.test(tag) ? "" : tag,
  );
}

export function injectReportRenderCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${REPORT_RENDER_CSP}" />`;
  const head = html.match(/<head[^>]*>/i);
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + meta + html.slice(at);
  }
  return meta + html;
}

export function isAllowedReportRequestUrl(url: string): boolean {
  if (url.startsWith("data:")) return true;
  if (url === "about:blank") return true;
  if (!url.startsWith("file:")) return false;
  let filePath: string;
  try {
    filePath = fileURLToPath(url);
  } catch {
    return false;
  }
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.includes("/../")) return false;
  return /\/report-v2\/assets\/[^/]+$/.test(normalized);
}

export async function renderPdfFromHtml(html: string, options: RenderPdfOptions = {}): Promise<Buffer> {
  const executablePath = resolveBrowserExecutablePath();

  if (!executablePath) {
    throw new Error(
      "No usable Chromium executable was found for report-v2 PDF rendering"
    );
  }

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    timeout: options.launchTimeoutMs ?? BROWSER_LAUNCH_TIMEOUT_MS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--font-render-hinting=medium",
      "--disable-gpu",
      "--disable-extensions",
      "--no-first-run",
    ],
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);
    page.setDefaultNavigationTimeout(120_000);

    await page.setViewport({
      width: 1440,
      height: 2000,
      deviceScaleFactor: 1,
    });

    await page.emulateMediaType("print");

    // B8-F-006 — see isAllowedReportRequestUrl / injectReportRenderCsp.
    const blockedRequests: string[] = [];
    let blockedNavigation = false;
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      if (isAllowedReportRequestUrl(url)) {
        void request.continue().catch(() => undefined);
        return;
      }
      // A navigation (e.g. an injected <meta http-equiv="refresh">) is not
      // governed by page CSP; aborting it leaves the page on an error
      // document, so the render is refused below rather than printed.
      if (request.isNavigationRequest()) blockedNavigation = true;
      if (blockedRequests.length < 20) {
        // Scheme + host only: never a query string or a path a record named.
        let shown = "invalid-url";
        try {
          const u = new URL(url);
          shown = u.protocol === "file:" ? "file:" : `${u.protocol}//${u.host}`;
        } catch {
          /* keep the placeholder */
        }
        blockedRequests.push(shown);
      }
      void request.abort("blockedbyclient").catch(() => undefined);
    });

await page.setContent(injectReportRenderCsp(stripHttpEquivMeta(html)), {
  waitUntil: "domcontentloaded",
  timeout: 30_000,
});

// Phase REPORT-RENDERER-FIX — the evaluate bodies are passed as
// PLAIN STRINGS, not as TypeScript arrow functions, so that the
// worker's transpiler (tsx → esbuild in dev, tsc → JS in prod)
// cannot inject helpers like `__name(fn, "label")` that puppeteer
// then serialises via .toString() and sends to the browser where
// they are undefined → `ReferenceError: __name is not defined`.
//
// Each string body is plain ES2022 that the headless Chrome can
// execute verbatim, with no module syntax, no TypeScript syntax,
// and no helper references. The browser still understands modern
// JavaScript so async/await/Array.from/Promise/Promise.race are
// fine; we just keep the body out of the transpiler's reach.
await page.evaluate(
  `(async () => {
    const fonts = document.fonts;
    if (fonts && fonts.ready) {
      await Promise.race([
        fonts.ready,
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }

    const images = Array.from(document.images);
    await Promise.race([
      Promise.all(
        images.map((img) => {
          if (img.complete) return Promise.resolve();
          return new Promise((resolve) => {
            const done = () => resolve();
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
          });
        })
      ),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  })()`,
);

    // B8-F-006 — a blocked navigation means injected markup tried to leave
    // the report; never print whatever document is left. Deterministic.
    if (blockedNavigation) {
      throw new OutputVerificationError("REPORT_RENDER_INPUT_INCONSISTENT", [
        { check: "renderer_blocked_navigation", detail: blockedRequests.join(",").slice(0, 200) },
      ]);
    }

    // THE LAYOUT AUDIT (pdf/report-geometry.ts): an element that clips its
    // own text would print a report with words cut off or missing, and that
    // leaves no trace in the PDF's text positions. Refused here, before
    // printing — deterministic, so never retried.
    const clipped = (await page.evaluate(LAYOUT_AUDIT_SCRIPT)) as LayoutAuditEntry[];
    if (clipped.length) {
      throw new OutputVerificationError("REPORT_OUTPUT_INCONSISTENT", layoutAuditFindings(clipped));
    }

    const footerData = (await page.evaluate(
      `(() => {
        const text = (selector) =>
          (document.querySelector(selector) || {}).textContent
            ? document.querySelector(selector).textContent.trim() || null
            : null;

        const meta = (name) => {
          const node = document.querySelector('meta[name="' + name + '"]');
          if (!node) return null;
          const v = node.getAttribute("content");
          return v ? v.trim() || null : null;
        };

        const findValueByLabel = (label) => {
          const cards = Array.from(document.querySelectorAll(".cover-meta-card"));
          for (const card of cards) {
            const lEl = card.querySelector(".cover-meta-label");
            const labelText = (lEl && lEl.textContent ? lEl.textContent.trim() : "") || "";
            if (labelText.toLowerCase() === label.toLowerCase()) {
              const vEl = card.querySelector(".cover-meta-value");
              return (vEl && vEl.textContent ? vEl.textContent.trim() : "") || null;
            }
          }
          return null;
        };

        // 2026-10-20 (AUD-18): the footer states the verification reference
        // the cover states; it never scrapes a UUID out of the body text.
        const evidenceReference =
          findValueByLabel("Verification Reference") ||
          text("[data-evidence-reference]") ||
          null;

        const root = document.querySelector(".report-root");

        return {
          evidenceReference,
          version:
            meta("proovra-report-version") ||
            (root && root.getAttribute("data-report-version")
              ? root.getAttribute("data-report-version").trim()
              : null) ||
            "1",
          generatedDateUtc:
            meta("proovra-report-generated-date") ||
            (root && root.getAttribute("data-generated-date-utc")
              ? root.getAttribute("data-generated-date-utc").trim()
              : null) ||
            meta("proovra-report-generated-at") ||
            "",
        };
      })()`,
    )) as {
      evidenceReference: string | null;
      version: string;
      generatedDateUtc: string;
    };

    const bands = await paperBandDataUrls();
    const footerTemplate = buildFooterTemplate({
      bottomBandUrl: bands.bottom,
reportId: fullReportId(footerData.evidenceReference),
      version: footerData.version || "1",
      generatedDateUtc: normalizeGeneratedDate(footerData.generatedDateUtc),
    });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      tagged: true,
      displayHeaderFooter: true,
      headerTemplate: buildHeaderTemplate(bands.top),
      footerTemplate,
      // The SAME margins the stylesheet declares in @page (page-geometry.ts):
      // the footer template is drawn in the bottom margin, which no content can
      // enter. They used to disagree (@page margin 0 overrode this 12mm under
      // preferCSSPageSize), and the footer was drawn over the content area.
      margin: {
        top: `${REPORT_PAGE.marginTopMm}mm`,
        right: "0mm",
        bottom: `${REPORT_PAGE.marginBottomMm}mm`,
        left: "0mm",
      },
    });

    // B8-F-006 — a navigation blocked WHILE printing (it raced the check
    // above) refuses the render too: the printed document is not trusted.
    if (blockedNavigation) {
      throw new OutputVerificationError("REPORT_RENDER_INPUT_INCONSISTENT", [
        { check: "renderer_blocked_navigation", detail: blockedRequests.join(",").slice(0, 200) },
      ]);
    }

    if (blockedRequests.length > 0) {
      // B8-F-006 — a template should never ask for anything outside its own
      // assets; when it does, say so (scheme/host only, no record text).
      console.warn(
        JSON.stringify({ event: "report_render.blocked_requests", blocked: blockedRequests }),
      );
    }

    // The PDF names the product's renderer, not the browser that printed it.
    return setPdfRendererIdentity(Buffer.from(pdf), REPORT_PDF_CREATOR);
  } finally {
    await browser.close();
  }
}