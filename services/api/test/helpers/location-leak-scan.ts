/**
 * F-14 closure (2026-10-22) — THE semantic location-leak scan for a
 * verification package, shared by the package tests.
 *
 * The first F-14 assertion searched the concatenated text of every entry for
 * substrings such as "52.52" / "52.5" / "13.4". Those substrings also occur in
 * ISO-8601 timestamps (seconds + milliseconds, e.g. "…:52:52.520Z"), so the
 * assertion failed on Main whenever the run happened to sign at such an
 * instant, with no location anywhere in the package. This scan states what a
 * leak IS, and is strictly stronger for real leaks:
 *
 *   - every JSON entry is parsed and walked: a location-named key with a value
 *     that is not "[withheld]", or ANY number / numeric string within
 *     `tolerance` of a recorded coordinate (full precision or coarsened, down to
 *     one decimal), under ANY key or array position;
 *   - every entry (JSON included, as raw text) is searched for free-standing
 *     decimal numbers (never a fragment of a timestamp, version or longer
 *     number) within `tolerance` of a recorded coordinate;
 *   - the full-precision coordinate strings and any extra literal needles (e.g.
 *     the location source name) must appear nowhere, in any entry, as bytes.
 *
 * Each finding names the entry, the JSON path (or "$text") and why.
 */

export type LocationLeak = { entry: string; path: string; reason: string };

const LOCATION_KEYS =
  /^(lat|lng|lon|latitude|longitude|accuracy|accuracymeters|accuracyradius|gps|geolocation|capturelocation|location|locationsource|providerreportedmock|mapurl|externalmapurl)$/i;

/** A decimal standing alone: not preceded by a digit, ":" or ".", not followed by a digit or ".". */
const FREE_DECIMAL = /(?<![\d:.])-?\d{1,3}\.\d+(?![\d.])/g;

export function scanPackageForLocationLeaks(
  entries: ReadonlyMap<string, Buffer>,
  facts: {
    coordinates: ReadonlyArray<number>;
    /** Literal byte strings that must appear nowhere (e.g. the full-precision coordinate, the source name). */
    needles?: ReadonlyArray<string>;
    /** Default 0.06: catches the coordinate at full precision AND coarsened to 1 decimal ("52.5"). */
    tolerance?: number;
  },
): LocationLeak[] {
  const tolerance = facts.tolerance ?? 0.06;
  const near = (n: number) => Number.isFinite(n) && !Number.isInteger(n) && facts.coordinates.some((c) => Math.abs(n - c) < tolerance);
  const leaks: LocationLeak[] = [];

  const walk = (entry: string, node: unknown, path: string) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(entry, v, `${path}[${i}]`));
      return;
    }
    if (typeof node === "number" || (typeof node === "string" && /^-?\d+\.\d+$/.test(node.trim()))) {
      if (near(Number(node))) leaks.push({ entry, path, reason: `value ${JSON.stringify(node)} is a recorded coordinate` });
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const childPath = `${path}.${k}`;
      if (LOCATION_KEYS.test(k) && v !== null && v !== undefined && v !== "" && v !== "[withheld]" && v !== false) {
        leaks.push({ entry, path: childPath, reason: `location key "${k}" carries ${JSON.stringify(v).slice(0, 80)}` });
      }
      walk(entry, v, childPath);
    }
  };

  for (const [entry, bytes] of entries) {
    const text = bytes.toString("utf8");
    for (const needle of [...facts.coordinates.map((c) => String(c)), ...(facts.needles ?? [])]) {
      if (text.includes(needle)) leaks.push({ entry, path: "$bytes", reason: `contains ${JSON.stringify(needle)}` });
    }
    if (entry.endsWith(".json")) {
      try {
        walk(entry, JSON.parse(text), "$");
      } catch {
        leaks.push({ entry, path: "$", reason: "unparseable JSON entry" });
      }
    }
    if (/\.(json|txt|md)$/.test(entry)) {
      for (const m of text.matchAll(FREE_DECIMAL)) {
        if (near(Number(m[0]))) leaks.push({ entry, path: "$text", reason: `free-standing ${m[0]} is a recorded coordinate` });
      }
    }
  }
  return leaks;
}
