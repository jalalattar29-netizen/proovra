/**
 * Capture Environment writer — shared ingest-path persistence.
 *
 * Pins:
 *   * Reuses buildCaptureEnvironment → stores only the privacy-safe
 *     shape: NO raw IP, NO raw User-Agent.
 *   * Persists uploadSource / captureMethod / parsed browser/OS/device
 *     /timezone/locale + masked IP + UA hash.
 *   * Never throws and never blocks ingest: a DB failure returns false.
 */

import { describe, expect, it } from "vitest";

import { recordCaptureEnvironment } from "../src/services/technical-metadata/capture-environment-writer.js";

const RAW_IP = "203.0.113.42";
const RAW_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function capturePrisma() {
  const captured: { id?: string; data?: Record<string, unknown> } = {};
  return {
    prisma: {
      evidence: {
        update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          captured.id = args.where.id;
          captured.data = args.data;
          return {};
        },
      },
    } as never,
    captured,
  };
}

describe("recordCaptureEnvironment — privacy + persistence", () => {
  it("stores the privacy-safe shape with no raw IP / raw UA (intake-link)", async () => {
    const { prisma, captured } = capturePrisma();
    const ok = await recordCaptureEnvironment({
      evidenceId: "ev-1",
      rawUserAgent: RAW_UA,
      rawIp: RAW_IP,
      timezone: "Europe/London",
      locale: "en-GB",
      captureMethod: "INTAKE_LINK",
      uploadSource: "INTAKE_LINK",
      prisma,
    });
    expect(ok).toBe(true);
    expect(captured.id).toBe("ev-1");
    const ce = captured.data!.captureEnvironment as Record<string, unknown>;
    expect(ce.uploadSource).toBe("INTAKE_LINK");
    expect(ce.captureMethod).toBe("INTAKE_LINK");
    expect(ce.browserName).toBe("Chrome");
    expect(ce.osName).toBe("Windows");
    expect(ce.ipAddressMasked).toBe("203.0.x.x");
    expect(String(ce.userAgentHash)).toMatch(/^sha256:/);

    const serialized = JSON.stringify(captured.data);
    expect(serialized).not.toContain(RAW_IP);
    expect(serialized).not.toContain(RAW_UA);
  });

  it("derives locale from Accept-Language when not supplied (mobile)", async () => {
    const { prisma, captured } = capturePrisma();
    await recordCaptureEnvironment({
      evidenceId: "ev-2",
      rawUserAgent: RAW_UA,
      rawIp: RAW_IP,
      acceptLanguage: "fr-FR,fr;q=0.9,en;q=0.8",
      captureMethod: "MOBILE",
      uploadSource: "MOBILE_APP",
      prisma,
    });
    const ce = captured.data!.captureEnvironment as Record<string, unknown>;
    expect(ce.uploadSource).toBe("MOBILE_APP");
    expect(ce.locale).toBe("fr-FR");
  });

  it("never throws and returns false when the DB update fails (ingest never blocked)", async () => {
    const throwingPrisma = {
      evidence: {
        update: async () => {
          throw new Error("db down");
        },
      },
    } as never;
    let threw = false;
    let result = true;
    try {
      result = await recordCaptureEnvironment({
        evidenceId: "ev-3",
        rawUserAgent: RAW_UA,
        rawIp: RAW_IP,
        uploadSource: "API",
        prisma: throwingPrisma,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toBe(false);
  });
});
