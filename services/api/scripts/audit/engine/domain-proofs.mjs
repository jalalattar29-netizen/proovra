/**
 * PHASE 0 §8 — DOMAIN AUTHORITIES, READ BUT NEVER RE-DERIVED.
 *
 * Migration inventory, queue topology, Point-5 executed proof, Point-7 executed
 * proof and the reviewed-judgement manifests are genuinely different subjects
 * from "which routes exist and who calls them". Collapsing them into the source
 * engine would not remove a duplicate authority; it would create one, because
 * the source engine cannot measure whether an integration run happened or which
 * build a scenario executed against.
 *
 * So the engine READS them. For each it records the path, the schema/version it
 * declares, the run or build identifier it was bound to, the content hash, and
 * whether that binding is still current. What it never does is state their
 * subject in its own words — a count copied by hand from one of these into a
 * report is precisely the drift Phase 0 exists to end, so the facts artifact
 * carries a REFERENCE, not a transcription.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { REPO, DOMAIN_AUTHORITIES } from "./registry.mjs";

const sha256 = (v) => createHash("sha256").update(v).digest("hex");

/**
 * Pull the binding identifier a proof artifact declares, without inventing one.
 *
 * A missing identifier is reported as `null` and downgrades freshness to
 * UNBOUND. It is never defaulted to the current revision: an artifact that does
 * not say what it was measured against has not proven that it is current, and
 * quietly supplying the answer is how a stale proof gets credited.
 */
function extractBinding(json, binding) {
  // Point-5 and Point-7 bind PER SUITE, not per file: each record carries the
  // SHA-256 of the suite that produced it plus the run or build it executed
  // against, precisely so one stale entry cannot ride along on a fresh header.
  // Reading only the top level would report both artifacts as unbound and
  // credit neither — the mirror of the error of crediting both.
  const suites = json?.suites && typeof json.suites === "object" ? Object.values(json.suites) : [];
  const keys =
    binding === "RUN_ID"
      ? ["runId", "integrationRunId", "run"]
      : binding === "BUILD_ID"
        ? ["buildId", "nextBuildId", "releaseCandidateId", "runId"]
        : ["sourceRevision", "revision", "head"];

  const pick = (obj) => {
    for (const k of keys) {
      const v = obj?.[k];
      if (typeof v === "string" && v.length > 0) return v;
      if (typeof v === "number") return String(v);
    }
    return null;
  };

  const top = pick(json);
  if (top) return top;
  if (suites.length === 0) return null;

  const bound = suites.map(pick).filter(Boolean);
  // Every suite must be bound. A partially-bound artifact is reported as
  // unbound rather than credited on the strength of its bound half.
  if (bound.length !== suites.length) return null;
  return [...new Set(bound)].sort().join(",");
}

export function readDomainProofs() {
  const out = [];
  for (const d of DOMAIN_AUTHORITIES) {
    const abs = path.join(REPO, d.artifact);
    if (!existsSync(abs)) {
      out.push({
        domain: d.domain,
        path: d.artifact,
        producer: d.producer,
        binding: d.binding,
        present: false,
        freshness: "MISSING",
        why: d.why,
      });
      continue;
    }
    const raw = readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* not JSON — hash only */
    }
    const bindingValue = json ? extractBinding(json, d.binding) : null;
    const producerPresent =
      d.producer === "REVIEWED_BY_HUMAN" || existsSync(path.join(REPO, d.producer));

    // CONTENT_ONLY artifacts are curated registries: the hash IS the binding,
    // so a present artifact with a present producer is BOUND. Executed proofs
    // must additionally name the run or build they were produced by.
    let freshness;
    if (!producerPresent) freshness = "PRODUCER_MISSING";
    else if (d.binding === "CONTENT_ONLY") freshness = "BOUND_BY_CONTENT";
    else if (bindingValue) freshness = "BOUND";
    else freshness = "UNBOUND";

    out.push({
      domain: d.domain,
      path: d.artifact,
      producer: d.producer,
      producerPresent,
      binding: d.binding,
      bindingValue,
      schemaVersion:
        json?.schemaVersion ?? json?.schema ?? json?.version ?? json?.generatorVersion ?? null,
      contentHash: sha256(raw),
      byteLength: raw.length,
      present: true,
      freshness,
      why: d.why,
    });
  }
  return out;
}

/** Domain proofs whose binding does not entitle them to be credited. */
export const staleDomainProofs = (proofs) =>
  proofs.filter((p) => p.freshness === "MISSING" || p.freshness === "PRODUCER_MISSING" || p.freshness === "UNBOUND");
