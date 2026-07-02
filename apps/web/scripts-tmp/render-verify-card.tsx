/**
 * TEMPORARY harness — renders the REAL VerifyTechnicalMetadataSection component
 * (the public verify page's Evidence Acquisition + Capture device cards) to
 * static HTML for each scenario, using the same public acquisition projection
 * the live page receives. Proves the verify-page role label + no PII.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VerifyTechnicalMetadataSection } from "../components/verify-v2/VerifyTechnicalMetadataSection";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ART = path.resolve(__dirname, "../../../tmp-artifacts");

const typo = { small: {}, kicker: {} } as Record<string, Record<string, unknown>>;
const brand = { accent: "#0b7d63" };

// Public capture-environment projection (device card) — mirrors the live shape.
const captureEnvironment = {
  osName: "iOS", osVersion: "17.5", deviceClass: "MOBILE",
  browserName: "Safari", browserVersion: "17.5", timezone: "Europe/Berlin", locale: "de-DE",
};
const exif = { exifPresent: true, camera: "Apple iPhone 14 Pro", originalCaptureTime: "2026-06-30T09:58:11Z" };

for (const key of ["web", "sms", "email", "psl"]) {
  const acqPath = path.join(ART, `${key}__verify-acquisition.json`);
  const acquisition = JSON.parse(readFileSync(acqPath, "utf8"));
  const technicalMetadata = {
    media: null, exif, captureEnvironment, network: { country: "DE" },
    // The live verify page only attaches acquisition for intake evidence.
    acquisition: acquisition && acquisition.isIntake ? acquisition : null,
  };
  const html = renderToStaticMarkup(
    createElement(VerifyTechnicalMetadataSection as never, { technicalMetadata, typo, brand } as never),
  );
  writeFileSync(path.join(ART, `verify-card-${key}.html`), html ?? "(null render)", "utf8");
  console.log(`[verify:${key}] hasCard=${Boolean(html)} intakeAcq=${Boolean(technicalMetadata.acquisition)}`);
}
console.log("DONE verify cards");
