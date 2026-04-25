// D:\digital-witness\services\worker\src\report-v2\render-pdf.ts
import fs from "node:fs";
import puppeteer from "puppeteer";

function resolveBrowserExecutablePath(): string | undefined {
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

  const uuidMatch = raw.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  );
  if (uuidMatch?.[0]) return uuidMatch[0];

  return raw;
}

function normalizeGeneratedDate(value: string | null | undefined): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "Not recorded";

  const dateOnly = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return dateOnly?.[1] ?? raw;
}

function buildFooterTemplate(params: {
  reportId: string;
  version: string;
  generatedDateUtc: string;
}): string {
  const reportId = escapeFooterHtml(params.reportId);
  const version = escapeFooterHtml(params.version);
  const generatedDateUtc = escapeFooterHtml(params.generatedDateUtc);

  return `
    <style>
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

    <div class="proovra-footer">
      <div class="proovra-footer-inner">
        <span class="proovra-footer-brand">PROOVRA</span>
        <span>&nbsp;Verification Report</span>
        <span class="proovra-footer-sep">|</span>
        <span>ID: ${reportId}</span>
        <span class="proovra-footer-sep">|</span>
        <span>v${version}</span>
        <span class="proovra-footer-sep">|</span>
        <span class="proovra-footer-page">Page <span class="pageNumber"></span>/<span class="totalPages"></span></span>
        <span class="proovra-footer-sep">|</span>
        <span>Generated: ${generatedDateUtc} UTC</span>
      </div>
    </div>
  `;
}

export async function renderPdfFromHtml(html: string): Promise<Buffer> {
  const executablePath = resolveBrowserExecutablePath();

  if (!executablePath) {
    throw new Error(
      "No usable Chromium executable was found for report-v2 PDF rendering"
    );
  }

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
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

    await page.setContent(html, {
      waitUntil: ["domcontentloaded", "load", "networkidle0"],
      timeout: 120_000,
    });

    await page.evaluate(async () => {
      const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
      if (fonts?.ready) await fonts.ready;

      const images = Array.from(document.images);
      await Promise.all(
        images.map((img) => {
          if (img.complete) return Promise.resolve();

          return new Promise<void>((resolve) => {
            const done = () => resolve();
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
          });
        })
      );
    });

    const footerData = await page.evaluate(() => {
      function text(selector: string): string | null {
        return document.querySelector(selector)?.textContent?.trim() || null;
      }

      function meta(name: string): string | null {
        return (
          document
            .querySelector(`meta[name="${name}"]`)
            ?.getAttribute("content")
            ?.trim() || null
        );
      }

      function findValueByLabel(label: string): string | null {
        const cards = Array.from(document.querySelectorAll(".cover-meta-card"));
        for (const card of cards) {
          const labelText =
            card.querySelector(".cover-meta-label")?.textContent?.trim() || "";
          if (labelText.toLowerCase() === label.toLowerCase()) {
            return (
              card.querySelector(".cover-meta-value")?.textContent?.trim() ||
              null
            );
          }
        }

        return null;
      }

      const evidenceReference =
        findValueByLabel("Evidence Reference") ||
        text("[data-evidence-reference]") ||
        document.body.textContent?.match(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
        )?.[0] ||
        null;

      return {
        evidenceReference,
        version:
          meta("proovra-report-version") ||
          document
            .querySelector(".report-root")
            ?.getAttribute("data-report-version")
            ?.trim() ||
          "1",
        generatedDateUtc:
          meta("proovra-report-generated-date") ||
          document
            .querySelector(".report-root")
            ?.getAttribute("data-generated-date-utc")
            ?.trim() ||
          meta("proovra-report-generated-at") ||
          "",
      };
    });

    const footerTemplate = buildFooterTemplate({
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
      headerTemplate: `<div></div>`,
      footerTemplate,
      margin: {
        top: "0mm",
        right: "0mm",
        bottom: "14mm",
        left: "0mm",
      },
    });

    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}