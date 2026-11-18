/**
 * WS-REL / PRO-PSZ-05 — the API reads the client contract a request reports,
 * allows browsers to send it, and says so; an absent report is a legacy client
 * and never a refusal.
 */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { CLIENT_CAPABILITIES, parseClientContractReport } from "@proovra/shared";

import { clientDeclaresCapability, readClientContractReport } from "../src/http/client-contract-report.js";

describe("PRO-PSZ-05 client contract report", () => {
  it("parses the contract and a bounded, normalised capability list", () => {
    expect(parseClientContractReport("3", " Update-Required-Notice, x ,bad token!, update-required-notice")).toEqual({
      contract: 3,
      capabilities: ["update-required-notice", "x"],
    });
    expect(parseClientContractReport(null, null)).toEqual({ contract: null, capabilities: [] });
    expect(parseClientContractReport("0", "a".repeat(41)).contract).toBeNull();
    const many = Array.from({ length: 40 }, (_, i) => `c${i}`).join(",");
    expect(parseClientContractReport("1", many).capabilities).toHaveLength(16);
  });

  it("routes read it through one helper; absent headers are a legacy client", async () => {
    const app = Fastify();
    app.get("/probe", async (req) => ({
      report: readClientContractReport(req),
      notice: clientDeclaresCapability(req, CLIENT_CAPABILITIES.UPDATE_REQUIRED_NOTICE),
    }));
    const legacy = await app.inject({ method: "GET", url: "/probe" });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json()).toEqual({ report: { contract: null, capabilities: [] }, notice: false });
    const modern = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { "x-proovra-client-contract": "1", "x-proovra-client-capabilities": "update-required-notice" },
    });
    expect(modern.json()).toEqual({ report: { contract: 1, capabilities: ["update-required-notice"] }, notice: true });
    await app.close();
  });
});
