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
      if (fs.existsSync(real)) {
        return candidate;
      }
    } catch {
      // ignore broken symlink / missing path / loop
    }
  }

  return undefined;
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
    ],
  });

  try {
    const page = await browser.newPage();

    await page.setViewport({
      width: 1440,
      height: 2000,
      deviceScaleFactor: 1,
    });

    await page.emulateMediaType("print");

    await page.setContent(html, {
      waitUntil: ["domcontentloaded", "networkidle0"],
    });

    await page.evaluate(async () => {
      const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
      if (fonts?.ready) {
        await fonts.ready;
      }

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

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: "0mm",
        right: "0mm",
        bottom: "0mm",
        left: "0mm",
      },
    });

    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}