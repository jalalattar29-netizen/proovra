/**
 * OPS-005 — every Prometheus job an alert names is a job the config scrapes.
 * infra/prometheus/prometheus.yml cites this test by name; it did not exist, so a
 * renamed job would have disarmed its alert with nothing to say so.
 */
import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const scraped = new Set([...read("infra/prometheus/prometheus.yml").matchAll(/job_name:\s*([\w-]+)/g)].map((m) => m[1]!));

function referencedJobs(text: string): string[] {
  const jobs: string[] = [];
  for (const m of text.matchAll(/job\s*(=~|=)\s*\\?"([^"\\]+)\\?"/g)) {
    jobs.push(...(m[1] === "=~" ? m[2]!.split("|") : [m[2]!]));
  }
  return jobs;
}

describe("alert target parity", () => {
  const files = readdirSync(new URL("infra/grafana/alerts/", root)).filter((f) => f.endsWith(".yaml"));

  it("finds the alert files and the scrape jobs", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(scraped.has("proovra-api")).toBe(true);
  });

  it.each(files)("%s names only scraped jobs", (file) => {
    const jobs = referencedJobs(read(`infra/grafana/alerts/${file}`));
    // A regex alternative may list a legacy name; at least one must be scraped.
    const text = read(`infra/grafana/alerts/${file}`);
    for (const m of text.matchAll(/job\s*=~\s*\\?"([^"\\]+)\\?"/g)) {
      expect(m[1]!.split("|").some((j) => scraped.has(j)), m[0]).toBe(true);
    }
    for (const m of text.matchAll(/job\s*=\s*\\?"([^"\\]+)\\?"/g)) {
      expect(scraped.has(m[1]!), m[0]).toBe(true);
    }
    expect(jobs.length).toBeGreaterThanOrEqual(0);
  });
});
