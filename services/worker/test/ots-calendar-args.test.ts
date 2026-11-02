/**
 * OPS-016 / CRYPTO-005 — a proof goes to more than one calendar. Whether the real
 * calendars answer is not exercised here: this pins the arguments the client gets.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { otsCalendarArgs } from "../src/ots.service.js";

describe("otsCalendarArgs", () => {
  it("submits to every listed calendar and needs two answers", () => {
    expect(otsCalendarArgs({ OTS_CALENDAR_URLS: "https://a.example, https://b.example,https://c.example" })).toEqual([
      "-c", "https://a.example", "-c", "https://b.example", "-c", "https://c.example", "-m", "2",
    ]);
  });

  it("still honours one named calendar, which cannot require two answers", () => {
    expect(otsCalendarArgs({ OTS_CALENDAR_URL: "https://a.example" })).toEqual(["-c", "https://a.example", "-m", "1"]);
  });

  it("the list wins over the single name, and nothing set leaves the client's own defaults", () => {
    expect(otsCalendarArgs({ OTS_CALENDAR_URLS: "https://a.example,https://b.example", OTS_CALENDAR_URL: "https://z.example" })).not.toContain("https://z.example");
    expect(otsCalendarArgs({})).toEqual([]);
  });

  it("the production compose file names at least two calendars, and only on the worker", () => {
    const compose = readFileSync(new URL("../../../infra/docker/docker-compose.prod.yml", import.meta.url), "utf8");
    const line = compose.split("\n").find((l) => l.trim().startsWith("OTS_CALENDAR_URLS:"))!;
    expect(line.match(/https:\/\//g)!.length).toBeGreaterThanOrEqual(2);
    expect(compose).not.toMatch(/^\s+OTS_CALENDAR_URL:/m);
  });
});
